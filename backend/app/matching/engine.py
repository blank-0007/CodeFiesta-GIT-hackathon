"""Deterministic multi-pass matcher.

Each pass: block candidates (amount window via bisect + date window), score edges with scorePair,
then solve a maximum-weight assignment per connected component with
scipy.optimize.linear_sum_assignment. Group-sum (1:N / N:1) runs as a subset-sum search inside
same-counterparty candidate groups. Enabled rules (date/amount tolerances, vendor/account scope,
route-to-review holds, TDS splits) are applied here and their hits are counted.
"""

from __future__ import annotations

import bisect
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from decimal import Decimal

import numpy as np
from scipy.optimize import linear_sum_assignment

from app.core.money import D
from app.matching.score import MTxn, score_pair
from app.normalize.fuzzy import vendor_similarity

P1, P2, P3, P4, P5, MANUAL = "P1 · Exact", "P2 · Date ±3d", "P3 · Fuzzy vendor", "P4 · Group sum", "P5 · Relaxed re-run", "Manual"
INTERNAL_REF_PREFIXES = ("PV-", "RV-", "SAL-", "PC-", "JV-")


@dataclass
class PassSpec:
    name: str
    date_tol: int
    amount_tol: Decimal
    vendor_threshold: float
    kind: str  # exact | date | fuzzy | group | relaxed
    max_group: int = 25


@dataclass
class ScopedTolerance:
    rule_id: str
    scope: str  # vendor | account
    value: str
    date_tol: int | None = None
    amount_tol: Decimal | None = None
    vendor_threshold: float | None = None


@dataclass
class HoldRule:
    rule_id: str
    channel: str | None
    weekdays: set[int]  # 0=Mon … 6=Sun


@dataclass
class TdsRule:
    rule_id: str
    rate: Decimal


@dataclass
class RuleSet:
    scoped: list[ScopedTolerance] = field(default_factory=list)
    holds: list[HoldRule] = field(default_factory=list)
    tds: list[TdsRule] = field(default_factory=list)
    pass_rules: dict[int, str] = field(default_factory=dict)  # pass number -> rule id
    accounts: dict[str, list[str]] = field(default_factory=dict)  # account id -> labels (id, last4, name)
    # When the ledger export tags every row with its bank ledger (Tally "Ledger" column), a ledger line may
    # only reconcile against the statement of that same bank account. Off when ledger accounts are guessed.
    same_account: bool = False


@dataclass
class Pair:
    bank: list[MTxn]
    ledger: list[MTxn]
    pass_name: str
    breakdown: dict[str, float]
    score: float
    note: str | None = None


@dataclass
class MatchResult:
    pairs: list[Pair]
    hits: dict[str, int]
    pass_counts: dict[str, int]
    held: set[str]


def _norm_ref(s: str | None) -> str:
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def ref_match(bank: Sequence[MTxn], ledger: Sequence[MTxn]) -> bool | None:
    """True if a ledger reference appears in the bank narration/reference; None when the ledger
    only carries an internal voucher number (no information); False otherwise."""
    informative = False
    for lt in ledger:
        r = lt.reference or ""
        if not r or r.upper().startswith(INTERNAL_REF_PREFIXES):
            continue
        informative = True
        nr = _norm_ref(r)
        if len(nr) < 4:
            continue
        for bt in bank:
            if nr in _norm_ref(bt.desc) or nr == _norm_ref(bt.reference):
                return True
    return False if informative else None


class Matcher:
    def __init__(self, bank: Iterable[MTxn], ledger: Iterable[MTxn], rules: RuleSet | None = None):
        self.bank = {t.id: t for t in bank}
        self.ledger = {t.id: t for t in ledger}
        self.rules = rules or RuleSet()
        self.matched: set[str] = set()
        self.pairs: list[Pair] = []
        self.hits: dict[str, int] = defaultdict(int)
        self.held: set[str] = set()
        self._apply_holds()

    # ---------------------------------------------------------------- rules
    def _apply_holds(self) -> None:
        for h in self.rules.holds:
            for t in self.bank.values():
                if (h.channel is None or t.channel == h.channel) and t.date.weekday() in h.weekdays:
                    self.held.add(t.id)
                    self.hits[h.rule_id] += 1

    def _scope_hit(self, s: ScopedTolerance, b: MTxn, l: MTxn) -> bool:
        if s.scope == "vendor":
            return max(vendor_similarity(s.value, b.vendor), vendor_similarity(s.value, l.vendor)) >= 0.85
        labels = self.rules.accounts.get(b.account_id, [b.account_id])
        return any(x and x in s.value for x in labels) or s.value == b.account_id

    def _tolerances(self, p: PassSpec, b: MTxn, l: MTxn) -> tuple[int, Decimal, float, list[str]]:
        date_tol, amt_tol, vthr, used = p.date_tol, p.amount_tol, p.vendor_threshold, []
        if p.kind in ("exact", "group"):
            return date_tol, amt_tol, vthr, used
        for s in self.rules.scoped:
            if not self._scope_hit(s, b, l):
                continue
            hit = False
            if s.date_tol is not None and s.date_tol > date_tol:
                date_tol, hit = s.date_tol, True
            if s.amount_tol is not None and s.amount_tol > amt_tol:
                amt_tol, hit = s.amount_tol, True
            if s.vendor_threshold is not None and s.vendor_threshold < vthr:
                vthr, hit = s.vendor_threshold, True
            if hit:
                used.append(s.rule_id)
        return date_tol, amt_tol, vthr, used

    def _max_tols(self, p: PassSpec) -> tuple[int, Decimal]:
        dt, at = p.date_tol, p.amount_tol
        if p.kind not in ("exact", "group"):
            for s in self.rules.scoped:
                if s.date_tol is not None:
                    dt = max(dt, s.date_tol)
                if s.amount_tol is not None:
                    at = max(at, s.amount_tol)
        return dt, at

    def _acct_ok(self, b: MTxn, l: MTxn) -> bool:
        return not self.rules.same_account or b.account_id == l.account_id

    # ---------------------------------------------------------------- 1:1 passes
    def unmatched(self, side: str) -> list[MTxn]:
        pool = self.bank if side == "bank" else self.ledger
        return [t for t in pool.values() if t.id not in self.matched and t.id not in self.held]

    def run_pass(self, p: PassSpec) -> int:
        if p.kind == "group":
            return self._group_pass(p)
        bank = self.unmatched("bank")
        ledger = sorted(self.unmatched("ledger"), key=lambda t: t.amount)
        amounts = [t.amount for t in ledger]
        max_dt, max_at = self._max_tols(p)
        edges: dict[tuple[str, str], tuple[float, dict, list[str], str | None]] = {}
        for b in bank:
            lo = bisect.bisect_left(amounts, b.amount - max_at)
            hi = bisect.bisect_right(amounts, b.amount + max_at)
            for l in ledger[lo:hi]:
                lag = abs((b.date - l.date).days)
                if lag > max_dt or not self._acct_ok(b, l):
                    continue
                dt, at, vthr, used = self._tolerances(p, b, l)
                if lag > dt or abs(b.amount - l.amount) > at:
                    continue
                rm = ref_match([b], [l])
                vs = vendor_similarity(b.vendor, l.vendor)
                if p.kind == "exact":
                    ok = lag == 0 and b.amount == l.amount and (vs >= vthr or rm is True)
                else:
                    ok = vs >= vthr or (rm is True and p.kind != "fuzzy")
                if not ok:
                    continue
                breakdown, score = score_pair([b], [l], rm)
                note = None
                if b.amount != l.amount:
                    note = f"Within amount tolerance (₹{abs(b.amount - l.amount):.2f})"
                edges[(b.id, l.id)] = (score, breakdown, used, note)
        made = self._assign(edges, p.name)
        if p.kind in ("date", "relaxed"):
            made += self._tds_pass(p)
        return made

    def _assign(self, edges: dict, pass_name: str) -> int:
        if not edges:
            return 0
        # connected components over the bipartite candidate graph
        parent: dict[str, str] = {}

        def find(x: str) -> str:
            while parent.setdefault(x, x) != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for b, l in edges:
            parent[find("b:" + b)] = find("l:" + l)
        comps: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for b, l in edges:
            comps[find("b:" + b)].append((b, l))
        made = 0
        for comp in comps.values():
            bs = sorted({b for b, _ in comp})
            ls = sorted({l for _, l in comp})
            if len(comp) == 1:
                chosen = comp
            else:
                cost = np.full((len(bs), len(ls)), 1e6)
                bi = {x: i for i, x in enumerate(bs)}
                li = {x: i for i, x in enumerate(ls)}
                for b, l in comp:
                    cost[bi[b], li[l]] = -edges[(b, l)][0]
                rows, cols = linear_sum_assignment(cost)
                chosen = [(bs[r], ls[c]) for r, c in zip(rows, cols, strict=True) if cost[r, c] < 1e5]
            for b, l in chosen:
                score, breakdown, used, note = edges[(b, l)]
                self._add(Pair([self.bank[b]], [self.ledger[l]], pass_name, breakdown, score, note))
                for rid in used:
                    self.hits[rid] += 1
                made += 1
        return made

    def _add(self, pair: Pair) -> None:
        self.pairs.append(pair)
        for t in pair.bank + pair.ledger:
            self.matched.add(t.id)

    def _tds_pass(self, p: PassSpec) -> int:
        """Approved TDS rule: bank = ledger x (1 - rate) for the same counterparty."""
        made = 0
        for rule in self.rules.tds:
            ledger = self.unmatched("ledger")
            for b in self.unmatched("bank"):
                best = None
                for l in ledger:
                    if l.id in self.matched or (l.amount < 0) != (b.amount < 0) or not self._acct_ok(b, l):
                        continue
                    if abs((b.date - l.date).days) > max(p.date_tol, 3):
                        continue
                    net = (l.amount * (1 - rule.rate)).quantize(Decimal("0.01"))
                    if abs(net - b.amount) > Decimal("1.00") or vendor_similarity(b.vendor, l.vendor) < 0.85:
                        continue
                    best = l
                    break
                if best:
                    breakdown, score = score_pair([b], [best], ref_match([b], [best]))
                    tds = abs(best.amount - b.amount)
                    self._add(Pair([b], [best], P2, breakdown, score, f"Matched net of {rule.rate * 100:.0f}% TDS — split ₹{tds:.2f} to TDS payable ({rule.rule_id})"))
                    self.hits[rule.rule_id] += 1
                    made += 1
        return made

    # ---------------------------------------------------------------- group sum
    def _group_pass(self, p: PassSpec) -> int:
        made = 0
        for one_side, many_side in (("bank", "ledger"), ("ledger", "bank")):
            singles = sorted(self.unmatched(one_side), key=lambda t: -abs(t.amount))
            for s in singles:
                if s.id in self.matched:
                    continue
                cands = [
                    t for t in self.unmatched(many_side)
                    if (t.amount < 0) == (s.amount < 0) and abs(t.amount) < abs(s.amount) and abs((t.date - s.date).days) <= p.date_tol
                    and (not self.rules.same_account or t.account_id == s.account_id)
                ]
                if len(cands) < 2:
                    continue
                groups: dict[str, list[MTxn]] = defaultdict(list)
                for t in cands:
                    groups[t.vendor].append(t)
                best: list[MTxn] | None = None
                for vendor, items in groups.items():
                    if len(items) < 2:
                        continue
                    # The group must be the same counterparty as the single side.
                    if vendor_similarity(vendor, s.vendor) < 0.6:
                        continue
                    subset = subset_sum(items, s.amount, p.max_group)
                    if subset and (best is None or len(subset) > len(best)):
                        best = subset
                if not best:
                    continue
                bank, ledger = ([s], best) if one_side == "bank" else (best, [s])
                bank.sort(key=lambda t: (t.date, t.id))
                ledger.sort(key=lambda t: (t.date, t.id))
                breakdown, score = score_pair(bank, ledger, ref_match(bank, ledger))
                self._add(Pair(bank, ledger, P4, breakdown, score, f"{len(bank)}:{len(ledger)} group — sums agree exactly"))
                if p.kind == "group" and (rid := self.rules.pass_rules.get(4)):
                    self.hits[rid] += 1
                made += 1
        return made

    def result(self) -> MatchResult:
        counts: dict[str, int] = defaultdict(int)
        for pr in self.pairs:
            counts[pr.pass_name] += 1
        return MatchResult(self.pairs, dict(self.hits), dict(counts), set(self.held))


def subset_sum(items: list[MTxn], target: Decimal, max_size: int) -> list[MTxn] | None:
    """Exact (paise) subset-sum; prefers the whole group, then DP with a bounded state space."""
    cents = [int((t.amount * 100).to_integral_value()) for t in items]
    tgt = int((target * 100).to_integral_value())
    total_c = sum(cents)
    if len(items) <= max_size and total_c == tgt:
        return list(items)
    # Whole group minus one stray line (e.g. payroll batch + an unrelated entry for the same counterparty).
    if 3 <= len(items) <= max_size + 1:
        for i, c in enumerate(cents):
            if total_c - c == tgt:
                return [t for j, t in enumerate(items) if j != i]
    items_sorted = sorted(zip(cents, items, strict=True), key=lambda x: -abs(x[0]))[:max(max_size, 2) * 2]
    states: dict[int, tuple[int, ...]] = {0: ()}
    sign = 1 if tgt >= 0 else -1
    for idx, (c, _) in enumerate(items_sorted):
        new: dict[int, tuple[int, ...]] = {}
        for s, combo in states.items():
            ns = s + c
            if sign * ns > sign * tgt or len(combo) >= max_size:
                continue
            if ns not in states and ns not in new:
                new[ns] = combo + (idx,)
        states.update(new)
        if tgt in states:
            break
        if len(states) > 200_000:
            break
    combo = states.get(tgt)
    if combo and len(combo) >= 2:
        return [items_sorted[i][1] for i in combo]
    return None


def default_passes(config: dict) -> list[PassSpec]:
    """Build pass specs from a run config (camelCase wire dict, as stored)."""
    passes = config.get("passes") or []
    out: list[PassSpec] = []
    multi = config.get("multiPass", True)
    for i, ps in enumerate(passes):
        name = str(ps.get("name", ""))
        n = name.split("·")[0].strip().upper()
        kind = {"P1": "exact", "P2": "date", "P3": "fuzzy", "P4": "group"}.get(n, "relaxed" if i else "exact")
        canonical = {"exact": P1, "date": P2, "fuzzy": P3, "group": P4}.get(kind, name)
        out.append(PassSpec(
            name=canonical,
            date_tol=int(ps.get("dateToleranceDays", 0)),
            amount_tol=D(ps.get("amountTolerance", "0")),
            vendor_threshold=float(ps.get("vendorThreshold", 0.85)),
            kind=kind,
        ))
        if not multi:
            break
    if not out:
        out.append(PassSpec(P1, 0, Decimal("0"), 0.9, "exact"))
    return out
