"""score_pair must equal scorePair in src/api/mocks/seed.ts.

Weights .45/.15/.25/.15; amountSim 1 if diff == 0 else max(0, 1 - 0.05 * diff);
dateSim max(0, 1 - 0.08 * lag); refSim 1 / 0.2 / 0.6 for True / False / None;
breakdown rounded to 3dp (JS Math.round), score = min(1, sum) rounded to 3dp.
"""

from datetime import date
from decimal import Decimal

import pytest

from app.matching.score import SCORE_W, MTxn, score_pair


def tx(amount: str, d: str, vendor: str = "Acme", source: str = "bank", i: int = 0) -> MTxn:
    return MTxn(f"{source[0]}{i}", source, date.fromisoformat(d), Decimal(amount), vendor, "", None, "acc")


def side(rows, source):
    return [tx(a, d, v, source, i) for i, (a, d, v) in enumerate(rows)]


def test_weights():
    assert SCORE_W == {"amount": 0.45, "date": 0.15, "vendor": 0.25, "reference": 0.15}
    assert sum(SCORE_W.values()) == pytest.approx(1.0)


# ---------------------------------------------------------------- hand-computed
def test_perfect_match_scores_one():
    bd, s = score_pair([tx("-1000.00", "2026-09-10")], [tx("-1000.00", "2026-09-10", source="ledger")], True)
    assert bd == {"amount": 0.45, "date": 0.15, "vendor": 0.25, "reference": 0.15}
    assert s == 1.0


@pytest.mark.parametrize(("ref", "expected"), [(True, 0.15), (False, 0.03), (None, 0.09)])
def test_reference_sim(ref, expected):
    bd, _ = score_pair([tx("1.00", "2026-09-10")], [tx("1.00", "2026-09-10", source="ledger")], ref)
    assert bd["reference"] == expected


@pytest.mark.parametrize(
    ("bank_amt", "ledger_amt", "expected"),
    [
        ("100.00", "100.00", 0.45),
        ("100.00", "99.00", 0.428),  # 0.45 * 0.95 = 0.4275 -> half-up 0.428
        ("100.00", "98.00", 0.405),  # 0.45 * 0.90
        ("100.00", "90.00", 0.225),  # 0.45 * 0.50
        ("100.00", "80.00", 0.0),  # diff 20 -> sim 0
        ("100.00", "50.00", 0.0),  # clamped at 0
        ("-100.00", "100.00", 0.0),  # opposite signs, diff 200
    ],
)
def test_amount_sim(bank_amt, ledger_amt, expected):
    bd, _ = score_pair([tx(bank_amt, "2026-09-10")], [tx(ledger_amt, "2026-09-10", source="ledger")], None)
    assert bd["amount"] == expected


@pytest.mark.parametrize(
    ("bank_d", "ledger_d", "expected"),
    [
        ("2026-09-10", "2026-09-10", 0.15),
        ("2026-09-10", "2026-09-11", 0.138),  # 0.15 * 0.92
        ("2026-09-11", "2026-09-10", 0.138),  # lag is absolute
        ("2026-09-10", "2026-09-13", 0.114),  # 0.15 * 0.76
        ("2026-09-10", "2026-09-15", 0.09),  # 0.15 * 0.60
        ("2026-09-10", "2026-09-22", 0.006),  # 0.15 * 0.04
        ("2026-09-10", "2026-09-23", 0.0),  # 1 - 1.04 -> clamped
        ("2026-08-31", "2026-09-01", 0.138),  # across a month boundary
    ],
)
def test_date_sim(bank_d, ledger_d, expected):
    bd, _ = score_pair([tx("1.00", bank_d)], [tx("1.00", ledger_d, source="ledger")], None)
    assert bd["date"] == expected


def test_vendor_component_uses_vendor_similarity():
    # vendorSimilarity("ACME TRDRS", "ACME Traders Pvt Ltd") == 0.97 -> 0.25 * 0.97 = 0.2425 -> 0.243 (half-up)
    bd, _ = score_pair([tx("1.00", "2026-09-10", "ACME TRDRS")], [tx("1.00", "2026-09-10", "ACME Traders Pvt Ltd", "ledger")], None)
    assert bd["vendor"] == 0.243


def test_total_is_rounded_sum_of_breakdown():
    bd, s = score_pair([tx("-1000.00", "2026-09-10", "ACME TRDRS")], [tx("-999.50", "2026-09-12", "ACME Traders Pvt Ltd", "ledger")], None)
    # amount 0.45 * (1 - 0.025) = 0.43875 -> 0.439; date 0.15 * 0.84 = 0.126; vendor 0.243; ref 0.09
    assert bd == {"amount": 0.439, "date": 0.126, "vendor": 0.243, "reference": 0.09}
    assert s == 0.898


def test_score_never_exceeds_one():
    _, s = score_pair([tx("5.00", "2026-09-10")], [tx("5.00", "2026-09-10", source="ledger")], True)
    assert s <= 1.0


# ---------------------------------------------------------------- groups (1:N / N:1)
def test_one_to_many_group_sums_ledger_side():
    bank = side([("300.00", "2026-09-10", "Acme")], "bank")
    ledger = side([("100.00", "2026-09-10", "Acme"), ("150.00", "2026-09-11", "Acme"), ("50.00", "2026-09-12", "Acme")], "ledger")
    bd, s = score_pair(bank, ledger, None)
    assert bd["amount"] == 0.45  # sums agree exactly
    assert bd["date"] == 0.15  # lag uses the first txn on each side only
    assert s == pytest.approx(0.94)
    assert s == 0.94


def test_many_to_one_group_sums_bank_side():
    bank = side([("-60.00", "2026-09-12", "Acme"), ("-40.00", "2026-09-13", "Acme")], "bank")
    ledger = side([("-100.00", "2026-09-10", "Acme")], "ledger")
    bd, s = score_pair(bank, ledger, True)
    assert bd == {"amount": 0.45, "date": 0.126, "vendor": 0.25, "reference": 0.15}
    assert s == 0.976


def test_group_partial_sum_penalised():
    bank = side([("300.00", "2026-09-10", "Acme")], "bank")
    ledger = side([("100.00", "2026-09-10", "Acme"), ("199.00", "2026-09-10", "Acme")], "ledger")
    bd, _ = score_pair(bank, ledger, None)
    assert bd["amount"] == 0.428  # diff 1.00


# ---------------------------------------------------------------- cross-checked against TS scorePair
# (bank rows, ledger rows, refMatch, breakdown, score) produced by running a verbatim copy of
# seed.ts scorePair (with big.js + date-fns + src/lib/fuzzy.ts) under `npx tsx`.
TS_CASES = [
    ([("-1000.00", "2026-09-10", "ACME TRDRS")], [("-1000.00", "2026-09-10", "ACME Traders Pvt Ltd")], True,
     {"amount": 0.45, "date": 0.15, "vendor": 0.243, "reference": 0.15}, 0.993),
    ([("-1000.00", "2026-09-10", "ACME TRDRS")], [("-999.50", "2026-09-12", "ACME Traders Pvt Ltd")], None,
     {"amount": 0.439, "date": 0.126, "vendor": 0.243, "reference": 0.09}, 0.898),
    ([("-5000.00", "2026-09-01", "AMZN MKTP US*2K4")], [("-5001.00", "2026-09-04", "Amazon")], False,
     {"amount": 0.428, "date": 0.114, "vendor": 0.228, "reference": 0.03}, 0.8),
    ([("250000.00", "2026-09-15", "RZP SETTLEMENT")],
     [("100000.00", "2026-09-14", "Razorpay Software"), ("100000.00", "2026-09-15", "Razorpay Software"), ("50000.00", "2026-09-15", "Razorpay Software")],
     None, {"amount": 0.45, "date": 0.138, "vendor": 0.198, "reference": 0.09}, 0.876),
    ([("-60000.00", "2026-09-20", "BUNDL TECHNOLOGIES"), ("-40000.00", "2026-09-21", "BUNDL TECHNOLOGIES")],
     [("-100000.00", "2026-09-18", "Swiggy")], False,
     {"amount": 0.45, "date": 0.126, "vendor": 0.1, "reference": 0.03}, 0.706),
    ([("-100.00", "2026-09-01", "X")], [("-130.00", "2026-09-30", "Y")], False,
     {"amount": 0.0, "date": 0.0, "vendor": 0.0, "reference": 0.03}, 0.03),
    ([("-1000.00", "2026-09-01", "AWS INDIA")], [("-1007.37", "2026-09-08", "Amazon Web Services India")], True,
     {"amount": 0.284, "date": 0.066, "vendor": 0.133, "reference": 0.15}, 0.633),
    # sub-paise differences: Big.toFixed(2) rounds half-up (0.025 -> 0.03), Python round() would give 0.02
    ([("10.005", "2026-09-01", "Acme")], [("10.00", "2026-09-01", "Acme")], True,
     {"amount": 0.45, "date": 0.15, "vendor": 0.25, "reference": 0.15}, 1.0),
    ([("10.125", "2026-09-01", "Acme")], [("10.00", "2026-09-01", "Acme")], True,
     {"amount": 0.447, "date": 0.15, "vendor": 0.25, "reference": 0.15}, 0.997),
    ([("100.025", "2026-09-01", "Acme")], [("100.00", "2026-09-01", "Acme")], True,
     {"amount": 0.449, "date": 0.15, "vendor": 0.25, "reference": 0.15}, 0.999),
    ([("-501.005", "2026-09-02", "Acme")], [("-500.00", "2026-09-01", "Acme")], None,
     {"amount": 0.427, "date": 0.138, "vendor": 0.25, "reference": 0.09}, 0.905),
    ([("-2000.00", "2026-03-08", "MSFT AZURE")], [("-2000.00", "2026-03-10", "Microsoft Azure")], None,
     {"amount": 0.45, "date": 0.126, "vendor": 0.243, "reference": 0.09}, 0.909),
]


@pytest.mark.parametrize(("bank", "ledger", "ref", "breakdown", "score"), TS_CASES)
def test_score_pair_matches_ts(bank, ledger, ref, breakdown, score):
    bd, s = score_pair(side(bank, "bank"), side(ledger, "ledger"), ref)
    assert bd == breakdown
    assert s == score
