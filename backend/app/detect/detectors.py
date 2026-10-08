"""Statistical / rule detectors. Each emits Signals with plain-English humanText built from real numbers.

Signal.score is the detector's raw strength multiplied by the detector weight, so the run's
riskScore = noisy-OR(signal.score) and the UI's per-signal breakdown add up to the same number.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from app.core.money import inr
from app.matching.score import MTxn
from app.normalize.fuzzy import js_round, vendor_similarity

DETECTOR_IDS = (
    "duplicate_detector", "approval_limit", "new_vendor", "weekend_payment", "high_value",
    "period_boundary", "amount_outlier", "no_counterpart", "amount_mismatch", "round_amount",
)

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass
class DetectorCfg:
    id: str
    enabled: bool
    threshold: float
    weight: float


@dataclass
class Sig:
    detector: str
    raw: float
    evidence: list[str]
    details: dict
    text: str


@dataclass
class DetectContext:
    period_start: date
    period_end: date
    txns: dict[str, MTxn]  # all in-period txns of the run
    unmatched: set[str]
    external: list[MTxn]  # out-of-period rows (first days of next month etc.)
    history: dict[tuple[str, str], list[tuple[date, Decimal]]]  # (side, vendor) -> prior runs' txns
    known_vendors: set[str]  # ledger vendor master + vendors seen in prior runs
    vendor_first_seen: dict[str, date]
    approval_limit: Decimal
    high_value: Decimal
    cfg: dict[str, DetectorCfg]
    run_enabled: dict[str, bool] = field(default_factory=dict)
    # Ledger rows carry their bank account (matching is per account): look for exact counterparts that
    # were booked against the other account. account_names: account id -> display label.
    same_account: bool = False
    account_names: dict[str, str] = field(default_factory=dict)

    def on(self, det: str) -> bool:
        c = self.cfg.get(det)
        return bool(c and c.enabled and self.run_enabled.get(det, True))


def _days(a: date, b: date) -> int:
    return abs((a - b).days)


# -------------------------------------------------------------------- individual detectors
def duplicate(t: MTxn, ctx: DetectContext, window: int = 3) -> Sig | None:
    best = None
    for o in ctx.txns.values():
        if o.id == t.id or o.source != t.source or o.amount != t.amount:
            continue
        if _days(o.date, t.date) > window or vendor_similarity(o.vendor, t.vendor) < 0.85:
            continue
        # The duplicate is the later (or unmatched) one: prefer an original that is matched / earlier.
        if o.id in ctx.unmatched and (o.date, o.id) > (t.date, t.id):
            continue
        best = o
        break
    if not best:
        return None
    days = (t.date - best.date).days
    when = "on the same day" if days == 0 else f"{abs(days)} day{'s' if abs(days) != 1 else ''} {'earlier' if days > 0 else 'later'}"
    side = "payee" if t.source == "bank" else "vendor"
    return Sig("duplicate_detector", 0.6, [best.id], {"matchedTxn": best.id, "amountEqual": True, "daysApart": abs(days)},
               f"Same amount {inr(t.amount)} and {side} as {best.id} {when}")


def approval_limit(t: MTxn, ctx: DetectContext) -> Sig | None:
    if t.amount >= 0 or ctx.approval_limit <= 0:
        return None
    a = abs(t.amount)
    pct = float((ctx.approval_limit - a) / ctx.approval_limit)
    thr = ctx.cfg["approval_limit"].threshold
    if a >= ctx.approval_limit or pct > thr:
        return None
    raw = 0.78 if pct <= thr / 2 else 0.6
    return Sig("approval_limit", raw, [], {"amount": f"{a:.2f}", "limit": f"{ctx.approval_limit:.2f}", "pctBelow": js_round(pct * 100, 2)},
               f"Amount {inr(a)} is {pct * 100:.1f}% below the {inr(ctx.approval_limit)} approval limit")


def new_vendor(t: MTxn, ctx: DetectContext) -> Sig | None:
    if t.source != "bank" or abs(t.amount) < Decimal("5000") or "—" in t.vendor:
        return None
    days_thr = int(ctx.cfg["new_vendor"].threshold)
    known = t.vendor in ctx.known_vendors or any(vendor_similarity(t.vendor, v) >= 0.9 for v in ctx.known_vendors)
    prior = len(ctx.history.get((t.source, t.vendor), []))
    if not known and prior == 0:
        return Sig("new_vendor", 0.6, [], {"priorPayments": 0, "inVendorMaster": False},
                   "Counterparty not in the vendor/customer master; first payment to this beneficiary")
    first = ctx.vendor_first_seen.get(t.vendor)
    if prior == 0 and first and 0 <= (t.date - first).days <= days_thr:
        d = (t.date - first).days
        return Sig("new_vendor", 0.7, [], {"firstSeen": first.isoformat(), "priorPayments": 0},
                   f"Vendor first seen {d} day{'s' if d != 1 else ''} before this payment ({first.strftime('%d %b')}); no prior payments")
    return None


def weekend_payment(t: MTxn, ctx: DetectContext) -> Sig | None:
    if t.source != "bank" or t.amount >= 0 or t.date.weekday() < 5:
        return None
    if t.channel not in ("RTGS", "NEFT", "IMPS"):
        return None
    day = WEEKDAYS[t.date.weekday()]
    prior_weekend = sum(1 for o in ctx.txns.values() if o.source == "bank" and o.channel == t.channel and o.amount < 0 and o.date.weekday() >= 5 and o.id != t.id)
    prior_all = sum(1 for o in ctx.txns.values() if o.source == "bank" and o.channel == t.channel and o.amount < 0 and o.id != t.id)
    raw = 0.65 if prior_weekend == 0 else 0.45
    return Sig("weekend_payment", raw, [], {"weekday": day, "channel": t.channel, "priorWeekend": prior_weekend},
               f"{t.channel} initiated on {day} {t.date.strftime('%d %b %Y')} — {prior_weekend} of {prior_all} other {t.channel} payments this period were on a weekend")


def high_value(t: MTxn, ctx: DetectContext) -> Sig | None:
    if abs(t.amount) < ctx.high_value:
        return None
    return Sig("high_value", 0.6, [], {"amount": f"{abs(t.amount):.2f}", "threshold": f"{ctx.high_value:.2f}"},
               f"{inr(t.amount)} exceeds the {inr(ctx.high_value)} high-value threshold")


def period_boundary(t: MTxn, ctx: DetectContext) -> Sig | None:
    window = int(ctx.cfg["period_boundary"].threshold)
    if (ctx.period_end - t.date).days > window:
        return None
    other = "ledger" if t.source == "bank" else "bank"
    best = None
    for o in ctx.external:
        if o.source != other or o.amount != t.amount or o.date <= ctx.period_end:
            continue
        after = (o.date - ctx.period_end).days
        if after > window + 3:
            continue
        if vendor_similarity(o.vendor, t.vendor) < 0.6 and not (o.reference and t.reference and o.reference == t.reference):
            continue
        if best is None or o.date < best.date:
            best = o
    if not best:
        return None
    after = (best.date - ctx.period_end).days
    if t.source == "bank":
        text = f"Ledger entry {best.id} for the same amount is dated {best.date.strftime('%d %b')} — {after} day(s) after cut-off"
    else:
        text = f"Clears in bank on {best.date.strftime('%d %b')} ({best.id}) — {after} day(s) after cut-off"
    return Sig("period_boundary", 0.35, [best.id], {"counterpart": best.id, "daysAfterCutoff": after}, text)


def amount_outlier(t: MTxn, ctx: DetectContext) -> Sig | None:
    hist = [abs(a) for _, a in ctx.history.get((t.source, t.vendor), [])]
    if len(hist) < 5:
        return None
    med = statistics.median(hist)
    mad = statistics.median([abs(x - med) for x in hist])
    if mad == 0:
        mad = med * Decimal("0.05") or Decimal("1")
    z = float(Decimal("0.6745") * (abs(t.amount) - med) / mad)
    k = ctx.cfg["amount_outlier"].threshold
    if abs(z) < k:
        return None
    raw = min(0.9, 0.3 + 0.08 * (abs(z) - k))
    return Sig("amount_outlier", raw, [], {"robustZ": js_round(z, 2), "median": f"{med:.2f}", "historyCount": len(hist)},
               f"{inr(t.amount)} is {abs(z):.1f} robust SDs {'above' if z > 0 else 'below'} this counterparty's median of {inr(med)} ({len(hist)} prior txns)")


def amount_mismatch(t: MTxn, ctx: DetectContext) -> Sig | None:
    other = "ledger" if t.source == "bank" else "bank"
    best, best_diff = None, None
    for oid in ctx.unmatched:
        o = ctx.txns[oid]
        if o.source != other or (o.amount < 0) != (t.amount < 0) or o.amount == t.amount:
            continue
        if _days(o.date, t.date) > 3:
            continue
        diff = abs(t.amount - o.amount)
        if diff > abs(t.amount) * Decimal("0.05"):
            continue
        if vendor_similarity(o.vendor, t.vendor) < 0.8:
            continue
        if best_diff is None or diff < best_diff:
            best, best_diff = o, diff
    if not best:
        return None
    return Sig("amount_mismatch", 0.45, [best.id], {"otherTxn": best.id, "diff": f"{best_diff:.2f}"},
               f"{'Ledger' if other == 'ledger' else 'Bank'} {best.id} matches counterparty and date but differs by {inr(best_diff)}")


def round_amount(t: MTxn, ctx: DetectContext) -> Sig | None:
    if t.amount >= 0:
        return None
    a = abs(t.amount)
    if a < Decimal("10000"):
        return None
    if a % Decimal("10000") == 0:
        return Sig("round_amount", 0.3, [], {"roundTo": "10000"}, f"Round amount {inr(a)} on a vendor payment")
    nxt = (a / Decimal("10000")).to_integral_value(rounding="ROUND_CEILING") * Decimal("10000")
    gap = nxt - a
    if Decimal("0") < gap <= Decimal("500") and a % 100 == 0:
        return Sig("round_amount", 0.3, [], {"gapToRound": f"{gap:.2f}"}, f"Near-round amount ({inr(gap)} below {inr(nxt)})")
    return None


def cross_account(t: MTxn, ctx: DetectContext) -> MTxn | None:
    """Unmatched other-side txn with the same amount and counterparty, booked against another bank account."""
    if not ctx.same_account:
        return None
    other = "ledger" if t.source == "bank" else "bank"
    best = None
    for oid in ctx.unmatched:
        o = ctx.txns[oid]
        if o.source != other or o.account_id == t.account_id or o.amount != t.amount or _days(o.date, t.date) > 3:
            continue
        if vendor_similarity(o.vendor, t.vendor) < 0.8:
            continue
        if best is None or (_days(o.date, t.date), o.id) < (_days(best.date, t.date), best.id):
            best = o
    return best


def no_counterpart(t: MTxn, ctx: DetectContext) -> Sig:
    other = "ledger" if t.source == "bank" else "bank"
    if x := cross_account(t, ctx):
        acct = ctx.account_names.get(t.account_id, t.account_id)
        x_acct = ctx.account_names.get(x.account_id, x.account_id)
        if t.source == "ledger":
            text = f"Not on the {acct} statement; the same amount and counterparty appears on the {x_acct} statement ({x.id}) — likely booked against the wrong bank account"
        else:
            text = f"No {acct} ledger entry; ledger {x.id} has the same amount and counterparty but is booked against {x_acct}"
        return Sig("no_counterpart", 0.4, [x.id], {"side": other, "otherAccountTxn": x.id, "otherAccount": x.account_id}, text)
    window = 7
    near = 0
    for oid in ctx.unmatched:
        o = ctx.txns[oid]
        if o.source == other and _days(o.date, t.date) <= window and abs(o.amount - t.amount) <= abs(t.amount) * Decimal("0.2"):
            near += 1
    raw = 0.5 if near == 0 else 0.25
    where = "ledger entry" if other == "ledger" else "bank transaction"
    text = f"No unmatched {where} for this amount within ±{window} days" if near == 0 else f"No exact-amount {where}; {near} near-amount candidate(s) within ±{window} days"
    return Sig("no_counterpart", raw, [], {"side": other, "nearCandidates": near}, text)


ORDER = [duplicate, approval_limit, new_vendor, weekend_payment, high_value, period_boundary, amount_outlier, amount_mismatch, round_amount]


def run_detectors(t: MTxn, ctx: DetectContext, only: Iterable[str] | None = None) -> list[Sig]:
    out: list[Sig] = []
    only_set = set(only) if only else None
    for fn in ORDER:
        det = "duplicate_detector" if fn is duplicate else fn.__name__
        if only_set and det not in only_set:
            continue
        if not ctx.on(det):
            continue
        s = fn(t, ctx)
        if s:
            out.append(s)
    if (not only_set or "no_counterpart" in only_set) and ctx.on("no_counterpart"):
        out.append(no_counterpart(t, ctx))
    return out


def weighted(sig: Sig, ctx: DetectContext) -> float:
    w = ctx.cfg[sig.detector].weight if sig.detector in ctx.cfg else 1.0
    return js_round(sig.raw * w, 3)


def noisy_or(scores: Iterable[float]) -> float:
    remaining = 1.0
    for s in scores:
        remaining -= remaining * max(0.0, min(1.0, s))
    return 1 - remaining


def risk_level(score: float) -> str:
    if score >= 0.85:
        return "critical"
    if score >= 0.7:
        return "high"
    if score >= 0.4:
        return "medium"
    return "low"


def build_history(rows: Iterable[tuple[str, str, date, Decimal]]) -> dict[tuple[str, str], list[tuple[date, Decimal]]]:
    h: dict[tuple[str, str], list[tuple[date, Decimal]]] = defaultdict(list)
    for side, vendor, d, a in rows:
        h[(side, vendor)].append((d, a))
    return h


def month_bounds(period: str) -> tuple[date, date]:
    y, m = (int(x) for x in period.split("-"))
    start = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return start, nxt - timedelta(days=1)
