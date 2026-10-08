"""Matcher (app.matching.engine): multi-pass 1:1 matching, optimal assignment, group sums, rules."""

import copy
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.matching.engine import (
    P1,
    P2,
    P3,
    P4,
    HoldRule,
    Matcher,
    PassSpec,
    RuleSet,
    ScopedTolerance,
    TdsRule,
    default_passes,
    ref_match,
    subset_sum,
)
from app.matching.score import MTxn

# Mirrors DEFAULT_CONFIG in src/lib/matching.ts (camelCase wire shape).
DEFAULT_CONFIG = {
    "preset": "balanced",
    "dateToleranceDays": 3,
    "amountMode": "tolerance",
    "amountTolerance": "1.00",
    "vendorThreshold": 0.85,
    "referenceMatching": True,
    "multiPass": True,
    "passes": [
        {"name": "P1 · Exact", "dateToleranceDays": 0, "amountTolerance": "0.00", "vendorThreshold": 0.9, "confidence": 0.97},
        {"name": "P2 · Date ±3d", "dateToleranceDays": 3, "amountTolerance": "1.00", "vendorThreshold": 0.85, "confidence": 0.92},
        {"name": "P3 · Fuzzy vendor", "dateToleranceDays": 3, "amountTolerance": "1.00", "vendorThreshold": 0.55, "confidence": 0.8},
        {"name": "P4 · Group sum", "dateToleranceDays": 2, "amountTolerance": "0.00", "vendorThreshold": 0.8, "confidence": 0.9},
    ],
}

BASE = date(2026, 9, 9)  # a Wednesday
_seq = {"bank": 0, "ledger": 0}


def tx(source: str, amount: str, day: int, vendor: str, *, ref: str | None = None, desc: str = "", channel: str | None = None,
       account: str = "acc_hdfc", tid: str | None = None) -> MTxn:
    _seq[source] += 1
    return MTxn(tid or f"{source[0].upper()}{_seq[source]:04d}", source, BASE + timedelta(days=day), Decimal(amount), vendor,
                desc or vendor, ref, account, channel)


def bank(*a, **k) -> MTxn:
    return tx("bank", *a, **k)


def ledger(*a, **k) -> MTxn:
    return tx("ledger", *a, **k)


def specs(config=None) -> dict[str, PassSpec]:
    return {s.kind: s for s in default_passes(config or DEFAULT_CONFIG)}


def run_all(m: Matcher, config=None) -> Matcher:
    """Same order as services.pipeline.stage_match: P1 exact, P2 date, P4 group, P3 fuzzy/relaxed."""
    ps = default_passes(config or DEFAULT_CONFIG)
    for kinds in (("exact",), ("date",), ("group",), ("fuzzy", "relaxed")):
        for s in ps:
            if s.kind in kinds:
                m.run_pass(s)
    return m


def pairs_by_id(m: Matcher) -> dict[tuple[tuple[str, ...], tuple[str, ...]], str]:
    return {(tuple(t.id for t in p.bank), tuple(t.id for t in p.ledger)): p.pass_name for p in m.pairs}


# ---------------------------------------------------------------- config -> passes
def test_default_passes_from_config():
    ps = default_passes(DEFAULT_CONFIG)
    assert [(p.name, p.kind) for p in ps] == [(P1, "exact"), (P2, "date"), (P3, "fuzzy"), (P4, "group")]
    assert [p.date_tol for p in ps] == [0, 3, 3, 2]
    assert [p.amount_tol for p in ps] == [Decimal("0.00"), Decimal("1.00"), Decimal("1.00"), Decimal("0.00")]
    assert [p.vendor_threshold for p in ps] == [0.9, 0.85, 0.55, 0.8]


def test_default_passes_single_pass_when_multipass_off():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["multiPass"] = False
    ps = default_passes(cfg)
    assert len(ps) == 1 and ps[0].kind == "exact"


def test_default_passes_relaxed_and_empty():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["passes"].append({"name": "P5 · Relaxed", "dateToleranceDays": 7, "amountTolerance": "50.00", "vendorThreshold": 0.5})
    assert default_passes(cfg)[-1].kind == "relaxed"
    assert default_passes(cfg)[-1].amount_tol == Decimal("50.00")
    fallback = default_passes({"passes": []})
    assert len(fallback) == 1 and fallback[0].kind == "exact" and fallback[0].name == P1


# ---------------------------------------------------------------- P1 / P2 / P3
def test_p1_exact_pairs_identical_amount_and_date():
    b1 = bank("-12500.00", 0, "ACME Traders")
    b2 = bank("-12500.00", 1, "ACME Traders")  # lag 1 -> not exact
    l1 = ledger("-12500.00", 0, "ACME Traders Pvt Ltd")
    l2 = ledger("-12500.00", 2, "ACME Traders Pvt Ltd")
    m = Matcher([b1, b2], [l1, l2])
    assert m.run_pass(specs()["exact"]) == 1
    assert pairs_by_id(m) == {((b1.id,), (l1.id,)): P1}
    # no references on either side -> refSim 0.6: 0.45 + 0.15 + 0.25 + 0.09
    assert m.pairs[0].score == 0.94
    assert m.pairs[0].note is None


def test_p1_requires_exact_amount():
    b = bank("-12500.00", 0, "ACME Traders")
    l_ = ledger("-12499.50", 0, "ACME Traders")
    m = Matcher([b], [l_])
    assert m.run_pass(specs()["exact"]) == 0


def test_p1_reference_rescues_dissimilar_vendor():
    b = bank("-4200.00", 0, "BUNDL TECHNOLOGIES", desc="NEFT SBIN0012345 BUNDL TECHNOLOGIES")
    l_ = ledger("-4200.00", 0, "Swiggy", ref="SBIN0012345")
    m = Matcher([b], [l_])
    assert m.run_pass(specs()["exact"]) == 1
    assert m.pairs[0].breakdown["reference"] == 0.15


def test_p2_matches_within_three_day_lag_and_amount_tolerance():
    b1 = bank("-1000.00", 0, "ACME Traders")
    l1 = ledger("-999.50", 3, "ACME Traders Pvt Ltd")  # lag 3, diff 0.50
    b2 = bank("-2000.00", 0, "Zeta Corp")
    l2 = ledger("-2000.00", 4, "Zeta Corp")  # lag 4 -> outside
    b3 = bank("-3000.00", 0, "Omega Ltd")
    l3 = ledger("-3001.50", 1, "Omega Ltd")  # diff 1.50 -> outside
    m = Matcher([b1, b2, b3], [l1, l2, l3])
    assert m.run_pass(specs()["exact"]) == 0
    assert m.run_pass(specs()["date"]) == 1
    (p,) = m.pairs
    assert (p.bank[0].id, p.ledger[0].id, p.pass_name) == (b1.id, l1.id, P2)
    assert p.note == "Within amount tolerance (₹0.50)"


def test_p3_fuzzy_vendor_matches_bank_abbreviations():
    b1 = bank("-8800.00", 0, "AMZN WEB SVCS")
    l1 = ledger("-8800.00", 1, "Amazon Web Services")
    b2 = bank("50000.00", 0, "RZP SETTLEMENT")
    l2 = ledger("50000.00", 1, "Razorpay Software")  # similarity 0.79: below P2's 0.85, above P3's 0.55
    b3 = bank("-610.00", 0, "BUNDL TECHNOLOGIES")
    l3 = ledger("-610.00", 0, "Swiggy")  # similarity 0.40: too low even for P3
    m = run_all(Matcher([b1, b2, b3], [l1, l2, l3]))
    got = pairs_by_id(m)
    assert got[((b1.id,), (l1.id,))] == P2  # 0.97 similarity already clears P2
    assert got[((b2.id,), (l2.id,))] == P3
    assert all(b3.id not in k[0] for k in got)


def test_p3_alone_matches_amzn_alias():
    b = bank("-8800.00", 0, "AMZN WEB SVCS")
    l_ = ledger("-8800.00", 2, "Amazon Web Services")
    m = Matcher([b], [l_])
    assert m.run_pass(specs()["fuzzy"]) == 1
    assert m.pairs[0].pass_name == P3


def test_fuzzy_pass_ignores_reference_only_evidence():
    b = bank("-4200.00", 1, "BUNDL TECHNOLOGIES", desc="NEFT SBIN0012345")
    l_ = ledger("-4200.00", 0, "Swiggy", ref="SBIN0012345")
    assert Matcher([b], [l_]).run_pass(specs()["fuzzy"]) == 0
    assert Matcher([b], [l_]).run_pass(specs()["date"]) == 1


def test_assignment_is_optimal_not_greedy():
    # Candidate edges: b1-l1 (lag 0, best single score), b1-l2 (lag 2), b2-l1 (lag 2); b2-l2 lag 4 is no edge.
    # Greedy would take b1-l1 and strand b2; the max-weight assignment takes b1-l2 + b2-l1.
    b1 = bank("-10000.00", 0, "ACME Traders")
    b2 = bank("-10000.00", -2, "ACME Traders")
    l1 = ledger("-10000.00", 0, "ACME Traders")
    l2 = ledger("-10000.00", 2, "ACME Traders")
    m = Matcher([b1, b2], [l1, l2])
    assert m.run_pass(specs()["date"]) == 2
    assert set(pairs_by_id(m)) == {((b1.id,), (l2.id,)), ((b2.id,), (l1.id,))}
    assert sum(p.score for p in m.pairs) == pytest.approx(0.916 * 2)


def test_independent_components_each_assigned():
    pairs = [(bank(f"-{n}.00", 0, "ACME Traders"), ledger(f"-{n}.00", 1, "ACME Traders")) for n in (101, 202, 303)]
    m = Matcher([b for b, _ in pairs], [l_ for _, l_ in pairs])
    assert m.run_pass(specs()["date"]) == 3
    assert set(pairs_by_id(m)) == {((b.id,), (l_.id,)) for b, l_ in pairs}


# ---------------------------------------------------------------- group sum (P4)
def test_one_to_many_group():
    b = bank("250000.00", 0, "RZP SETTLEMENT")
    ls = [ledger("100000.00", -1, "Razorpay Software"), ledger("100000.00", 0, "Razorpay Software"), ledger("50000.00", 0, "Razorpay Software")]
    m = run_all(Matcher([b], ls))
    (p,) = m.pairs
    assert p.pass_name == P4
    assert [t.id for t in p.bank] == [b.id]
    assert sorted(t.id for t in p.ledger) == sorted(t.id for t in ls)
    assert p.note == "1:3 group — sums agree exactly"
    assert p.breakdown["amount"] == 0.45


def test_one_to_many_group_skips_decoy_line():
    b = bank("250000.00", 0, "RZP SETTLEMENT")
    good = [ledger("100000.00", 0, "Razorpay Software"), ledger("100000.00", 0, "Razorpay Software"), ledger("50000.00", 1, "Razorpay Software")]
    decoy = ledger("70000.00", 0, "Razorpay Software")
    m = Matcher([b], [*good, decoy])
    assert m.run_pass(specs()["group"]) == 1
    assert {t.id for t in m.pairs[0].ledger} == {t.id for t in good}
    assert decoy.id not in m.matched


def test_many_to_one_group():
    bs = [bank("-60000.00", 0, "ACME TRADERS"), bank("-40000.00", 1, "ACME TRADERS")]
    l_ = ledger("-100000.00", 0, "ACME Traders Pvt Ltd")
    m = run_all(Matcher(bs, [l_]))
    (p,) = m.pairs
    assert p.pass_name == P4
    assert [t.id for t in p.bank] == [bs[0].id, bs[1].id]  # sorted by (date, id)
    assert [t.id for t in p.ledger] == [l_.id]
    assert p.note == "2:1 group — sums agree exactly"


def test_payroll_one_to_twenty_group():
    lines = [ledger(f"{-(35000 + i * 1234.5):.2f}", -(i % 2), "Salary Payroll", ref=f"SAL-09-{i:04d}") for i in range(20)]
    total = sum((t.amount for t in lines), Decimal(0))
    b = bank(f"{total:.2f}", 0, "SALARY PAYROLL SEP")
    m = run_all(Matcher([b], lines))
    (p,) = m.pairs
    assert p.pass_name == P4 and len(p.ledger) == 20
    assert p.note == "1:20 group — sums agree exactly"
    assert ref_match(p.bank, p.ledger) is None  # SAL- refs are internal vouchers


def test_group_respects_max_group_size():
    lines = [ledger("-1000.00", 0, "Salary Payroll") for _ in range(6)]
    b = bank("-6000.00", 0, "SALARY PAYROLL")
    spec = specs()["group"]
    spec.max_group = 5
    assert Matcher([b], lines).run_pass(spec) == 0
    spec.max_group = 6
    assert Matcher([b], lines).run_pass(spec) == 1


def test_group_requires_same_counterparty():
    b = bank("300.00", 0, "Acme")
    ls = [ledger("100.00", 0, "Zeta Corp"), ledger("200.00", 0, "Zeta Corp")]
    assert Matcher([b], ls).run_pass(specs()["group"]) == 0


def test_group_respects_date_window():
    b = bank("300.00", 0, "Acme Traders")
    ls = [ledger("100.00", 0, "Acme Traders"), ledger("200.00", 3, "Acme Traders")]  # P4 window is ±2 days
    assert Matcher([b], ls).run_pass(specs()["group"]) == 0


# ---------------------------------------------------------------- subset_sum
def _items(*amounts: str) -> list[MTxn]:
    return [ledger(a, 0, "Acme") for a in amounts]


def test_subset_sum_prefers_whole_group():
    items = _items("100.00", "200.00", "300.00")
    assert subset_sum(items, Decimal("600.00"), 25) == items


def test_subset_sum_picks_exact_subset():
    items = _items("100.00", "250.00", "400.00", "75.00", "30.00")
    got = subset_sum(items, Decimal("355.00"), 25)
    assert got is not None
    assert sorted(t.amount for t in got) == [Decimal("30.00"), Decimal("75.00"), Decimal("250.00")]


def test_subset_sum_paise_exact_and_negative():
    items = _items("-100.10", "-250.25", "-49.90", "-0.01")
    got = subset_sum(items, Decimal("-150.00"), 25)
    assert got is not None and sorted(t.amount for t in got) == [Decimal("-100.10"), Decimal("-49.90")]


def test_subset_sum_rejects_single_item_and_no_solution():
    items = _items("100.00", "250.00", "400.00")
    assert subset_sum(items, Decimal("400.00"), 25) is None  # a 1-item "group" is a 1:1 match, not a group
    assert subset_sum(items, Decimal("123.45"), 25) is None


def test_subset_sum_respects_max_size():
    items = _items("10.00", "20.00", "30.00", "40.00")
    assert subset_sum(items, Decimal("100.00"), 3) is None
    assert subset_sum(items, Decimal("100.00"), 4) == items


# ---------------------------------------------------------------- rules
def test_hold_rule_parks_weekend_rtgs():
    sat = 3  # BASE is a Wednesday
    assert (BASE + timedelta(days=sat)).weekday() == 5
    rtgs = bank("-750000.00", sat, "ACME Traders", channel="RTGS")
    neft = bank("-12000.00", sat + 1, "Zeta Corp", channel="NEFT")
    weekday_rtgs = bank("-90000.00", 0, "Omega Ltd", channel="RTGS")
    ls = [ledger("-750000.00", sat, "ACME Traders"), ledger("-12000.00", sat + 1, "Zeta Corp"), ledger("-90000.00", 0, "Omega Ltd")]
    rules = RuleSet(holds=[HoldRule("R-weekend-rtgs", "RTGS", {5, 6})])
    m = run_all(Matcher([rtgs, neft, weekday_rtgs], ls, rules))
    res = m.result()
    assert res.held == {rtgs.id}
    assert res.hits["R-weekend-rtgs"] == 1
    matched_bank = {t.id for p in res.pairs for t in p.bank}
    assert matched_bank == {neft.id, weekday_rtgs.id}
    assert ls[0].id not in m.matched
    assert res.pass_counts == {P1: 2}


def test_hold_rule_any_channel():
    t = bank("-500.00", 4, "Acme", channel="UPI")  # Sunday
    m = Matcher([t], [], RuleSet(holds=[HoldRule("R-any", None, {6})]))
    assert m.held == {t.id}
    assert m.unmatched("bank") == []


def test_vendor_scoped_date_tolerance():
    b_acme = bank("-5000.00", 0, "ACME TRADERS")
    l_acme = ledger("-5000.00", 6, "ACME Traders Pvt Ltd")
    b_zeta = bank("-7000.00", 0, "Zeta Corp")
    l_zeta = ledger("-7000.00", 6, "Zeta Corp")
    # without the rule nothing matches at lag 6
    assert Matcher([b_acme, b_zeta], [l_acme, l_zeta]).run_pass(specs()["date"]) == 0
    rules = RuleSet(scoped=[ScopedTolerance("R-acme-7d", "vendor", "ACME Traders", date_tol=7)])
    m = Matcher([b_acme, b_zeta], [l_acme, l_zeta], rules)
    assert m.run_pass(specs()["date"]) == 1
    assert pairs_by_id(m) == {((b_acme.id,), (l_acme.id,)): P2}
    assert m.result().hits == {"R-acme-7d": 1}


def test_vendor_scoped_amount_tolerance_and_exact_pass_unaffected():
    b = bank("-5000.00", 0, "ACME TRADERS")
    l_ = ledger("-4975.00", 0, "ACME Traders")
    rules = RuleSet(scoped=[ScopedTolerance("R-acme-amt", "vendor", "ACME Traders", amount_tol=Decimal("50.00"))])
    m = Matcher([b], [l_], rules)
    assert m.run_pass(specs()["exact"]) == 0  # scoped rules never loosen P1
    assert m.run_pass(specs()["date"]) == 1
    assert m.pairs[0].note == "Within amount tolerance (₹25.00)"
    assert m.hits["R-acme-amt"] == 1


def test_account_scoped_tolerance():
    b = bank("-800.00", 0, "Omega Ltd", account="acc_icici")
    l_ = ledger("-800.00", 5, "Omega Ltd")
    b2 = bank("-900.00", 0, "Omega Ltd", account="acc_hdfc")
    l2 = ledger("-900.00", 5, "Omega Ltd")
    rules = RuleSet(scoped=[ScopedTolerance("R-icici", "account", "acc_icici", date_tol=5)])
    m = Matcher([b, b2], [l_, l2], rules)
    assert m.run_pass(specs()["date"]) == 1
    assert pairs_by_id(m) == {((b.id,), (l_.id,)): P2}


def test_tds_rule_matches_net_of_tds():
    l_ = ledger("-100000.00", 0, "Infosys Ltd")
    b = bank("-90000.00", 1, "INFOSYS LIMITED")
    rules = RuleSet(tds=[TdsRule("R-tds-10", Decimal("0.10"))])
    m = Matcher([b], [l_], rules)
    assert m.run_pass(specs()["date"]) == 1
    (p,) = m.pairs
    assert p.pass_name == P2
    assert p.note == "Matched net of 10% TDS — split ₹10000.00 to TDS payable (R-tds-10)"
    assert m.hits["R-tds-10"] == 1


def test_tds_rule_needs_same_counterparty_and_sign():
    rules = RuleSet(tds=[TdsRule("R-tds-2", Decimal("0.02"))])
    # customer receipt net of 2% TDS: 50,000 invoiced, 49,000 received
    ok = Matcher([bank("49000.00", 0, "Wipro Enterprises")], [ledger("50000.00", 0, "Wipro Enterprises")], rules)
    assert ok.run_pass(specs()["date"]) == 1
    other_vendor = Matcher([bank("49000.00", 0, "Zeta Corp")], [ledger("50000.00", 0, "Wipro Enterprises")], rules)
    assert other_vendor.run_pass(specs()["date"]) == 0
    wrong_sign = Matcher([bank("-49000.00", 0, "Wipro Enterprises")], [ledger("50000.00", 0, "Wipro Enterprises")], rules)
    assert wrong_sign.run_pass(specs()["date"]) == 0
    no_rule = Matcher([bank("49000.00", 0, "Wipro Enterprises")], [ledger("50000.00", 0, "Wipro Enterprises")])
    assert no_rule.run_pass(specs()["date"]) == 0


# ---------------------------------------------------------------- reference matching
def test_ref_match():
    b = bank("-1.00", 0, "X", desc="NEFT/UTR-HDFC00123/ACME", ref="HDFC00123")
    assert ref_match([b], [ledger("-1.00", 0, "X", ref="hdfc-00123")]) is True
    assert ref_match([b], [ledger("-1.00", 0, "X", ref="PV-09-0001")]) is None  # internal voucher
    assert ref_match([b], [ledger("-1.00", 0, "X", ref=None)]) is None
    assert ref_match([b], [ledger("-1.00", 0, "X", ref="INV-777")]) is False
    assert ref_match([b], [ledger("-1.00", 0, "X", ref="AB")]) is False  # informative but too short


# ---------------------------------------------------------------- full pipeline order
def test_full_run_attributes_each_pair_to_its_pass():
    b_p1 = bank("-12500.00", 0, "ACME Traders")
    l_p1 = ledger("-12500.00", 0, "ACME Traders")
    b_p2 = bank("-3300.00", 0, "Zeta Corp")
    l_p2 = ledger("-3300.00", 2, "Zeta Corp")
    b_p3 = bank("-4400.00", 0, "TCS")
    l_p3 = ledger("-4400.00", 1, "Tata Consultancy Services")  # 0.76
    b_p4 = bank("-900.00", 0, "Omega Ltd")
    l_p4 = [ledger("-400.00", 0, "Omega Ltd"), ledger("-500.00", 1, "Omega Ltd")]
    orphan = bank("-77.00", 0, "Unknown")
    m = run_all(Matcher([b_p1, b_p2, b_p3, b_p4, orphan], [l_p1, l_p2, l_p3, *l_p4]))
    res = m.result()
    assert res.pass_counts == {P1: 1, P2: 1, P3: 1, P4: 1}
    by_bank = {p.bank[0].id: p.pass_name for p in res.pairs}
    assert by_bank == {b_p1.id: P1, b_p2.id: P2, b_p3.id: P3, b_p4.id: P4}
    assert [t.id for t in m.unmatched("bank")] == [orphan.id]
    assert m.unmatched("ledger") == []
