"""scorePair — identical to src/api/mocks/seed.ts so scores shown in the UI equal backend scores."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from app.normalize.fuzzy import js_round, vendor_similarity

SCORE_W = {"amount": 0.45, "date": 0.15, "vendor": 0.25, "reference": 0.15}


@dataclass
class MTxn:
    """Matching-time view of a transaction."""

    id: str
    source: str  # bank | ledger
    date: date
    amount: Decimal
    vendor: str
    desc: str
    reference: str | None
    account_id: str
    channel: str | None = None


def score_pair(bank: Sequence[MTxn], ledger: Sequence[MTxn], ref_match: bool | None) -> tuple[dict[str, float], float]:
    b = sum((t.amount for t in bank), Decimal(0))
    lsum = sum((t.amount for t in ledger), Decimal(0))
    diff = abs(b - lsum)
    # Big.toFixed(2) rounds half-up; Python's round(Decimal) is half-even, so quantize explicitly.
    amount_sim = 1.0 if diff == 0 else max(0.0, 1 - float(diff.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) * 0.05)
    lag = abs((bank[0].date - ledger[0].date).days)
    date_sim = max(0.0, 1 - lag * 0.08)
    vendor_sim = vendor_similarity(bank[0].vendor, ledger[0].vendor)
    ref_sim = 0.6 if ref_match is None else (1.0 if ref_match else 0.2)
    breakdown = {
        "amount": js_round(SCORE_W["amount"] * amount_sim, 3),
        "date": js_round(SCORE_W["date"] * date_sim, 3),
        "vendor": js_round(SCORE_W["vendor"] * vendor_sim, 3),
        "reference": js_round(SCORE_W["reference"] * ref_sim, 3),
    }
    score = min(1.0, js_round(breakdown["amount"] + breakdown["date"] + breakdown["vendor"] + breakdown["reference"], 3))
    return breakdown, score
