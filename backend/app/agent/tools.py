"""Deterministic tools the investigation agent may call. Executed by OUR code — the LLM never
computes totals or match math, it only reads these results."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from app.core.money import ZERO, D, fmt
from app.detect.detectors import DetectContext
from app.matching.score import MTxn
from app.normalize.fuzzy import vendor_similarity
from app.normalize.vendors import mask_numbers


@dataclass
class Snapshot:
    ctx: DetectContext
    openings: dict[str, Decimal] = field(default_factory=dict)  # account -> opening balance
    mask: bool = True

    def describe(self, t: MTxn) -> dict:
        return {
            "id": t.id, "side": t.source, "date": t.date.isoformat(), "amount": fmt(t.amount),
            "description": mask_numbers(t.desc) if self.mask else t.desc, "counterparty": t.vendor,
            "reference": (mask_numbers(t.reference) if self.mask else t.reference) if t.reference else None,
            "account": t.account_id, "matched": t.id not in self.ctx.unmatched,
        }


DECLARATIONS = [
    {
        "name": "search_ledger",
        "description": "Search transactions on the other side (ledger for a bank item, bank for a ledger item) by counterparty, amount and date range. Returns up to 8 candidates with match status.",
        "parameters": {"type": "OBJECT", "properties": {
            "side": {"type": "STRING", "description": "Which side to search: 'ledger' or 'bank'"},
            "vendor": {"type": "STRING", "description": "Counterparty name (fuzzy matched)"},
            "amount": {"type": "STRING", "description": "Signed decimal amount, e.g. '-49900.00'"},
            "date_from": {"type": "STRING", "description": "yyyy-MM-dd"},
            "date_to": {"type": "STRING", "description": "yyyy-MM-dd"},
        }},
    },
    {
        "name": "find_duplicates",
        "description": "Find other transactions on the same side with the same amount and counterparty within ±7 days of the given transaction.",
        "parameters": {"type": "OBJECT", "properties": {"txn_id": {"type": "STRING"}}, "required": ["txn_id"]},
    },
    {
        "name": "get_vendor_history",
        "description": "Payment history for a counterparty across prior reconciliation runs: count, median amount, first seen date, last 5 payments.",
        "parameters": {"type": "OBJECT", "properties": {"vendor": {"type": "STRING"}}, "required": ["vendor"]},
    },
    {
        "name": "check_period_boundary",
        "description": "Look for a counterpart just across the month cut-off (entries dated in the first days of the next period).",
        "parameters": {"type": "OBJECT", "properties": {"txn_id": {"type": "STRING"}}, "required": ["txn_id"]},
    },
    {
        "name": "get_balance_context",
        "description": "Opening balance, running balance on a date, and count of unmatched items for a bank account.",
        "parameters": {"type": "OBJECT", "properties": {"account": {"type": "STRING"}, "date": {"type": "STRING"}}, "required": ["account"]},
    },
]


def _date(s: str | None, default: date) -> date:
    try:
        return date.fromisoformat(s) if s else default
    except ValueError:
        return default


def execute(snap: Snapshot, name: str, args: dict, focus: MTxn) -> tuple[dict, str, int]:
    """Run a tool; returns (result, one-line summary, ms)."""
    t0 = time.perf_counter()
    ctx = snap.ctx
    try:
        if name == "search_ledger":
            side = args.get("side") or ("ledger" if focus.source == "bank" else "bank")
            vendor = args.get("vendor") or ""
            amt = D(args["amount"]) if args.get("amount") else None
            d0 = _date(args.get("date_from"), focus.date - timedelta(days=7))
            d1 = _date(args.get("date_to"), focus.date + timedelta(days=7))
            pool = [t for t in list(ctx.txns.values()) + ctx.external if t.source == side and d0 <= t.date <= d1]
            scored = []
            for t in pool:
                vs = vendor_similarity(vendor, t.vendor) if vendor else 0.0
                ad = abs(t.amount - amt) if amt is not None else None
                if amt is not None and ad > abs(amt) * Decimal("0.25") and vs < 0.8:
                    continue
                if amt is None and vs < 0.6:
                    continue
                scored.append((0 if ad is None else float(ad), -vs, t))
            scored.sort(key=lambda x: (x[0], x[1]))
            res = [{**snap.describe(t), "vendorSimilarity": -s, "amountDiff": fmt(t.amount - amt) if amt is not None else None} for _, s, t in scored[:8]]
            exact = sum(1 for r in res if r["amountDiff"] == "0.00")
            summary = f"{len(res)} candidate(s) on {side} side ({exact} exact amount; {sum(1 for r in res if not r['matched'])} unmatched)"
            out = {"candidates": res}
        elif name == "find_duplicates":
            t = ctx.txns.get(args.get("txn_id", ""), focus)
            dups = [o for o in ctx.txns.values() if o.id != t.id and o.source == t.source and o.amount == t.amount
                    and abs((o.date - t.date).days) <= 7 and vendor_similarity(o.vendor, t.vendor) >= 0.85]
            out = {"duplicates": [snap.describe(o) for o in dups]}
            summary = f"{len(dups)} same-side txn(s) with identical amount & counterparty" + (f": {', '.join(o.id for o in dups[:3])}" if dups else "")
        elif name == "get_vendor_history":
            v = args.get("vendor") or focus.vendor
            hist = []
            for (side, vendor), xs in ctx.history.items():
                if side == focus.source and vendor_similarity(vendor, v) >= 0.9:
                    hist.extend(xs)
            hist.sort()
            amounts = sorted(abs(a) for _, a in hist)
            med = amounts[len(amounts) // 2] if amounts else None
            first = ctx.vendor_first_seen.get(v)
            out = {"count": len(hist), "median": fmt(med) if med is not None else None, "firstSeen": first.isoformat() if first else None,
                   "inVendorMaster": v in ctx.known_vendors, "last5": [{"date": d.isoformat(), "amount": fmt(a)} for d, a in hist[-5:]]}
            summary = f"{len(hist)} prior txn(s) in history" + (f"; median {fmt(med)}" if med is not None else "") + ("; in vendor master" if out["inVendorMaster"] else "; NOT in vendor master")
        elif name == "check_period_boundary":
            t = ctx.txns.get(args.get("txn_id", ""), focus)
            other = "ledger" if t.source == "bank" else "bank"
            days_to_end = (ctx.period_end - t.date).days
            hits = [o for o in ctx.external if o.source == other and o.amount == t.amount and 0 < (o.date - ctx.period_end).days <= 10]
            out = {"periodEnd": ctx.period_end.isoformat(), "daysBeforeCutoff": days_to_end, "nextPeriodMatches": [snap.describe(o) for o in hits]}
            summary = (f"Next-period {other} entry {hits[0].id} matches amount" if hits else
                       f"{days_to_end} day(s) before cut-off; no next-period counterpart")
        elif name == "get_balance_context":
            acct = args.get("account") or focus.account_id
            on = _date(args.get("date"), focus.date)
            opening = snap.openings.get(acct)
            run_bal = None
            if opening is not None:
                run_bal = opening + sum((t.amount for t in ctx.txns.values() if t.source == "bank" and t.account_id == acct and t.date <= on), ZERO)
            um = sum(1 for i in ctx.unmatched if ctx.txns[i].account_id == acct)
            out = {"account": acct, "openingBalance": fmt(opening) if opening is not None else None,
                   "balanceOnDate": fmt(run_bal) if run_bal is not None else None, "unmatchedItems": um}
            summary = f"{um} unmatched items on {acct}" + (f"; balance on {on.isoformat()} {fmt(run_bal)}" if run_bal is not None else "")
        else:
            out, summary = {"error": f"unknown tool {name}"}, f"Unknown tool {name}"
    except Exception as e:  # tool errors are reported back to the model, never raised
        out, summary = {"error": str(e)[:200]}, f"Tool error: {str(e)[:80]}"
    return out, summary, int((time.perf_counter() - t0) * 1000)
