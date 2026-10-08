"""noisy_or / risk_level / weighted in app.detect.detectors vs src/lib/risk.ts."""

import math
from datetime import date
from decimal import Decimal

import pytest

from app.detect.detectors import DetectContext, DetectorCfg, Sig, noisy_or, risk_level, weighted

# (scores, noisyOr(scores).combined) — produced by running src/lib/risk.ts under `npx tsx`
TS_NOISY_OR = [
    ([], 0.0),
    ([0.0], 0.0),
    ([1.0], 1.0),
    ([0.5], 0.5),
    ([0.5, 0.5], 0.75),
    ([0.3, 0.4, 0.2], 0.664),
    ([0.6, 0.45, 0.35, 0.25], 0.8927499999999999),
    ([1.5, -0.2, 0.3], 1.0),  # inputs are clamped to [0, 1]
    ([0.9, 0.9, 0.9], 0.999),
    ([0.18, 0.234, 0.5, 0.07, 0.11], 0.740052538),
]

# (score, getRiskLevel(score)) — produced by src/lib/risk.ts
TS_LEVELS = [
    (0.0, "low"),
    (0.39, "low"),
    (0.3999999, "low"),
    (0.4, "medium"),
    (0.69, "medium"),
    (0.7, "high"),
    (0.84, "high"),
    (0.85, "critical"),
    (0.849999, "high"),
    (1.0, "critical"),
    (1.2, "critical"),
    (-0.1, "low"),
]


@pytest.mark.parametrize(("scores", "expected"), TS_NOISY_OR)
def test_noisy_or_matches_ts(scores, expected):
    assert noisy_or(scores) == expected


@pytest.mark.parametrize("scores", [s for s, _ in TS_NOISY_OR if all(0 <= x <= 1 for x in s)])
def test_noisy_or_is_one_minus_product(scores):
    assert noisy_or(scores) == pytest.approx(1 - math.prod(1 - s for s in scores))


def test_noisy_or_accepts_generators_and_is_order_insensitive():
    a = noisy_or(x for x in [0.2, 0.5, 0.3])
    b = noisy_or([0.3, 0.2, 0.5])
    assert a == pytest.approx(b) == pytest.approx(0.72)


def test_noisy_or_monotone():
    assert noisy_or([0.3]) < noisy_or([0.3, 0.1]) < noisy_or([0.3, 0.1, 0.4])


@pytest.mark.parametrize(("score", "expected"), TS_LEVELS)
def test_risk_level_matches_ts(score, expected):
    assert risk_level(score) == expected


@pytest.mark.parametrize(("score", "expected"), [(0.4, "medium"), (0.7, "high"), (0.85, "critical")])
def test_risk_level_thresholds_inclusive(score, expected):
    assert risk_level(score) == expected
    assert risk_level(math.nextafter(score, 0)) != expected


def _ctx(cfg: dict[str, DetectorCfg]) -> DetectContext:
    return DetectContext(
        period_start=date(2026, 9, 1), period_end=date(2026, 9, 30), txns={}, unmatched=set(), external=[],
        history={}, known_vendors=set(), vendor_first_seen={}, approval_limit=Decimal("50000"),
        high_value=Decimal("500000"), cfg=cfg,
    )


def test_weighted_multiplies_raw_by_weight_and_rounds_3dp():
    ctx = _ctx({"duplicate_detector": DetectorCfg("duplicate_detector", True, 0.0, 0.85)})
    sig = Sig("duplicate_detector", 0.6, [], {}, "")
    assert weighted(sig, ctx) == 0.51
    sig2 = Sig("duplicate_detector", 0.65, [], {}, "")
    # 0.65 * 0.85 = 0.5525 -> JS half-up at 3dp -> 0.553
    assert weighted(sig2, ctx) == 0.553


def test_weighted_defaults_to_weight_one():
    assert weighted(Sig("round_amount", 0.3, [], {}, ""), _ctx({})) == 0.3


def test_combined_risk_from_weighted_signals():
    ctx = _ctx({
        "duplicate_detector": DetectorCfg("duplicate_detector", True, 0.0, 1.0),
        "weekend_payment": DetectorCfg("weekend_payment", True, 0.0, 1.0),
    })
    sigs = [Sig("duplicate_detector", 0.6, [], {}, ""), Sig("weekend_payment", 0.65, [], {}, "")]
    combined = noisy_or(weighted(s, ctx) for s in sigs)
    assert combined == pytest.approx(0.86)
    assert risk_level(combined) == "critical"
