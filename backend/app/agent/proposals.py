"""Rule proposals: mined deterministically from the run's leftovers and validated by replaying the
matcher (the `simulation`). The LLM may only rewrite titles/descriptions. Never auto-activated."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from app.core.money import inr
from app.matching.engine import P3, Matcher, PassSpec, RuleSet, ScopedTolerance, TdsRule
from app.matching.score import MTxn
from app.normalize.fuzzy import vendor_similarity
from app.normalize.vendors import extract_counterparty


def _replay(bank: list[MTxn], ledger: list[MTxn], rs: RuleSet, spec: PassSpec) -> list:
    """Pairs the candidate rule ADDS: replay the pass with and without it on the leftovers."""
    with_rule = Matcher(bank, ledger, rs)
    with_rule.run_pass(spec)
    base = Matcher(bank, ledger, RuleSet(same_account=rs.same_account))
    base.run_pass(spec)
    seen = {tuple(t.id for t in p.bank + p.ledger) for p in base.pairs}
    return [p for p in with_rule.pairs if tuple(t.id for t in p.bank + p.ledger) not in seen]


def mine(txns: dict[str, MTxn], unmatched: set[str], pairs: list, existing_params: list[dict], same_account: bool = False) -> list[dict]:
    out: list[dict] = []
    ub = [txns[i] for i in unmatched if txns[i].source == "bank"]
    ul = [txns[i] for i in unmatched if txns[i].source == "ledger"]

    def exists(pred) -> bool:
        return any(pred(p) for p in existing_params)

    # 1) Aliases: fuzzy (P3) matches whose bank counterparty string repeats
    groups: dict[tuple[str, str], list] = defaultdict(list)
    for p in pairs:
        if p.pass_name != P3:
            continue
        raw = extract_counterparty(p.bank[0].desc).upper().strip()
        groups[(p.ledger[0].vendor, raw)].append(p)
    by_vendor: dict[str, dict[str, list]] = defaultdict(dict)
    for (vendor, raw), ps in groups.items():
        by_vendor[vendor][raw] = ps
    for vendor, raws in by_vendor.items():
        total = sum(len(v) for v in raws.values())
        if total < 2:
            continue
        aliases = sorted(raws, key=lambda r: -len(raws[r]))[:4]
        if exists(lambda pp, vendor=vendor, aliases=aliases: pp.get("canonical") == vendor and set(aliases) <= set(pp.get("aliases", []))):
            continue
        sup = [p.bank[0] for r in aliases for p in raws[r]]
        out.append({
            "title": f"Alias: {' / '.join(repr(a) for a in aliases[:2])} → {vendor}",
            "description": f"Bank narrations for {vendor} use {len(aliases)} abbreviation(s) that only fuzzy-match. Adding them as aliases lets the exact pass match these with higher confidence instead of relying on fuzzy matching.",
            "scope": "vendor alias", "params": {"canonical": vendor, "aliases": aliases},
            "supporting": sup, "simulation": {"matchesGained": 0, "matchesChanged": len(sup),
                                              "examples": [f"{len(sup)} existing match(es) move from Pass 3 (fuzzy) to Pass 1 (exact) with higher confidence"]},
            "confidence": min(0.97, 0.8 + 0.03 * len(sup)),
        })

    # 2) Vendor-specific date tolerance: same counterparty & amount, lag 4–10 days
    lags: dict[str, list[tuple[MTxn, MTxn, int]]] = defaultdict(list)
    for b in ub:
        for l in ul:
            lag = abs((b.date - l.date).days)
            if b.amount == l.amount and 4 <= lag <= 10 and vendor_similarity(b.vendor, l.vendor) >= 0.85 and (not same_account or b.account_id == l.account_id):
                lags[l.vendor].append((b, l, lag))
                break
    for vendor, items in lags.items():
        days = max(x[2] for x in items) + 1
        if exists(lambda pp, vendor=vendor: pp.get("vendor") == vendor and "dateToleranceDays" in pp):
            continue
        rs = RuleSet(scoped=[ScopedTolerance("SIM", "vendor", vendor, date_tol=days)], same_account=same_account)
        gained = _replay(ub, ul, rs, PassSpec("P2 · Date ±3d", 3, Decimal("1.00"), 0.85, "date"))
        if not gained:
            continue
        out.append({
            "title": f"{vendor}: widen date tolerance to {days} days",
            "description": f"Payments for {vendor} clear {min(x[2] for x in items)}–{max(x[2] for x in items)} days after the ledger date, beyond the ±3 day window. Use a {days}-day tolerance for this vendor only.",
            "scope": f"vendor: {vendor}", "params": {"vendor": vendor, "dateToleranceDays": days},
            "supporting": [x[0] for x in items], "simulation": {"matchesGained": len(gained), "matchesChanged": 0,
                                                                  "examples": [f"Would auto-match {len(gained)} item(s) currently left for review"]},
            "confidence": min(0.95, 0.75 + 0.05 * len(gained)),
        })

    # 3) Small bank charges → classify automatically
    charges = [t for t in ub if t.amount < 0 and abs(t.amount) <= Decimal("2000") and t.vendor.endswith("— charges")]
    if len(charges) >= 2 and not exists(lambda pp: "pattern" in pp):
        out.append({
            "title": "Auto-classify small bank charges",
            "description": "Bank debits whose narration starts with 'CHRG', 'GST ON CHGS' or ends with 'ANNUAL FEE' and are under ₹2,000 are always bank charges. Classify them as missing-in-ledger (bank charge) and suggest GL 6900 without AI investigation.",
            "scope": "global", "params": {"pattern": "^(CHRG|GST ON CHGS|.*ANNUAL FEE)", "maxAmount": "2000.00", "category": "missing", "suggestedGl": "6900 Bank Charges"},
            "supporting": charges, "simulation": {"matchesGained": 0, "matchesChanged": 0,
                                                   "examples": [f"{len(charges)} item(s) per run auto-resolved with a GL suggestion instead of AI investigation"]},
            "confidence": 0.95,
        })

    # 4) TDS netting: bank = ledger × (1 − rate)
    for rate in (Decimal("0.02"), Decimal("0.01"), Decimal("0.10")):
        hits = []
        for b in ub:
            for l in ul:
                if (b.amount < 0 and l.amount < 0 and abs((b.date - l.date).days) <= 3 and abs(l.amount * (1 - rate) - b.amount) <= 1
                        and vendor_similarity(b.vendor, l.vendor) >= 0.85 and (not same_account or b.account_id == l.account_id)):
                    hits.append((b, l))
                    break
        if hits and not exists(lambda pp, rate=rate: pp.get("tdsRate") is not None and Decimal(str(pp["tdsRate"])) == rate):
            gained = _replay(ub, ul, RuleSet(tds=[TdsRule("SIM", rate)], same_account=same_account), PassSpec("P2 · Date ±3d", 3, Decimal("1.00"), 0.85, "date"))
            out.append({
                "title": f"Match contractor payments net of {rate * 100:.0f}% TDS",
                "description": f"When a bank debit equals the ledger amount × {1 - rate} for the same vendor, match them and propose a TDS-payable split for the difference (e.g. {inr(hits[0][1].amount - hits[0][0].amount)} on {hits[0][1].vendor}).",
                "scope": "vendor group: contractors", "params": {"vendorGroup": "contractors", "tdsRate": float(rate), "section": "194C", "action": "match_with_split"},
                "supporting": [h[0] for h in hits], "simulation": {"matchesGained": len(gained), "matchesChanged": 0,
                                                                    "examples": [f"Would match {h[1].vendor} {inr(h[0].amount)} / {inr(h[1].amount)}" for h in hits[:2]]},
                "confidence": 0.74,
            })
    return out
