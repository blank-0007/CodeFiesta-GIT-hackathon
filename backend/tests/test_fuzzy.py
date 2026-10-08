"""Parity tests: app.normalize.fuzzy must equal src/lib/fuzzy.ts bit-for-bit.

Every expected value below was produced by running the TypeScript module itself
(`npx tsx` importing src/lib/fuzzy.ts) and is asserted with exact float equality.
"""

import pytest

from app.normalize.fuzzy import jaro_winkler, js_round, normalize_vendor, skeleton, vendor_similarity

# (a, b, vendorSimilarity(a, b)) — outputs of src/lib/fuzzy.ts
VENDOR_CASES = [
    ("AMZN MKTP US*2K4", "Amazon", 0.91),
    ("AWS INDIA", "Amazon Web Services India", 0.53),
    ("ACME TRDRS", "ACME Traders Pvt Ltd", 0.97),
    ("RZP SETTLEMENT", "Razorpay Software", 0.79),
    ("BUNDL TECHNOLOGIES", "Swiggy", 0.4),
    ("", "", 0.0),
    ("", "Amazon", 0.0),
    ("Amazon", "", 0.0),
    ("Amazon", "Amazon", 1.0),
    ("ACME Traders", "ACME Traders", 1.0),
    ("12345", "67890", 0.0),
    ("NEFT 998877 ACME", "ACME", 1.0),
    ("AMZN WEB SVCS", "Amazon Web Services", 0.97),
    ("AMAZON WEB SERVICES", "Amazon Web Services India Pvt Ltd", 1.0),
    ("Infosys Ltd", "Infosys Limited", 1.0),
    ("TATA CONSULTANCY", "Tata Consultancy Services", 1.0),
    ("TCS", "Tata Consultancy Services", 0.76),
    ("HDFC BANK", "HDFC Bank Ltd", 1.0),
    ("ZOMATO MEDIA", "Zomato Ltd", 0.97),
    ("SWIGGY", "Bundl Technologies", 0.4),
    ("UPI/PAYTM/9876", "Paytm", 1.0),
    ("FLIPKART INTERNET", "Flipkart Internet Pvt Ltd", 1.0),
    ("FLPKRT", "Flipkart", 0.93),
    ("RELIANCE JIO", "Reliance Jio Infocomm", 0.97),
    ("BHARTI AIRTEL", "Airtel", 0.97),
    ("MSFT AZURE", "Microsoft Azure", 0.97),
    ("GOOGLE CLOUD", "Google India Pvt Ltd", 0.97),
    ("OLA CABS", "ANI Technologies", 0.59),
    ("Salary June", "Salary July", 0.97),
    ("a b c", "x y z", 0.0),
    ("The Co Ltd", "Pvt Inc", 0.0),
    ("Acme-Traders/Mumbai", "ACME TRADERS MUMBAI", 1.0),
    ("WIPRO", "Wipro Enterprises", 0.97),
    ("MARTHA", "MARHTA", 0.96),
    ("DWAYNE", "DUANE", 0.84),
    ("DIXON", "DICKSONX", 0.81),
    ("Café Coffee Day", "Cafe Coffee Day", 0.97),
    ("ACME2 TRADERS", "ACME TRADERS", 0.97),
    ("Rent Oct 2026", "Office Rent", 0.97),
    ("PAYU PAYMENTS", "PayU Payments Pvt Ltd", 1.0),
    ("CRED", "Dreamplug Technologies", 0.51),
    ("  ACME   TRADERS  ", "acme traders", 1.0),
    ("Ab", "Ab", 1.0),
    ("MKTP", "Amazon", 0.0),
]

# (a, b, jaroWinkler(a, b)) — outputs of src/lib/fuzzy.ts
JW_CASES = [
    ("", "", 1.0),
    ("", "a", 0.0),
    ("a", "", 0.0),
    ("a", "a", 1.0),
    ("a", "b", 0.0),
    ("ab", "ba", 0.0),
    ("martha", "marhta", 0.9611111111111111),
    ("dwayne", "duane", 0.8400000000000001),
    ("dixon", "dicksonx", 0.8133333333333332),
    ("crate", "trace", 0.7333333333333334),
    ("amzn", "amazon", 0.9111111111111111),
    ("acme traders", "acme trdrs", 0.9666666666666667),
    ("abc", "abcd", 0.9416666666666667),
    ("abcd", "abc", 0.9416666666666667),
    ("jellyfish", "smellyfish", 0.8962962962962964),
    ("prefixmatch", "prefixmatchy", 0.9833333333333333),
    ("aws", "amazon web", 0.53),
    ("12345", "12354", 0.9533333333333333),
    ("razorpay software", "rzp settlement", 0.6735294117647058),
    ("bundl technologies", "swiggy", 0.0),
]

# (s, normalizeVendor(s)) — outputs of src/lib/fuzzy.ts
NORM_CASES = [
    ("AMZN MKTP US*2K4", ["amzn"]),
    ("Amazon Web Services India Pvt Ltd", ["amazon", "web"]),
    ("", []),
    ("   ", []),
    ("NEFT/RTGS/IMPS UPI", []),
    ("ACME TRDRS 12345", ["acme", "trdrs"]),
    ("ab1 cd ef2", ["cd"]),
    ("Café Coffee Day", ["caf", "coffee", "day"]),
    ("X Y Z", []),
    ("The ACME and Co", ["acme"]),
    ("PAYMENT TO ACME SVC", ["to", "acme"]),
    ("ACME-Traders/Mumbai_Branch", ["acme", "traders", "mumbai", "branch"]),
    ("HDFC0001234 SALARY", ["salary"]),
    ("a\tb\ncde  fgh", ["cde", "fgh"]),
]

# (x, dp, Math.round(x * 10**dp) / 10**dp) — computed in node
JS_ROUND_CASES = [
    (0.125, 2, 0.13),  # Python's round() gives 0.12 (banker's rounding)
    (2.5, 0, 3.0),  # round() -> 2
    (-2.5, 0, -2.0),  # JS rounds half towards +inf, not away from zero
    (-0.5, 0, 0.0),
    (1.005, 2, 1.0),  # 1.005 * 100 == 100.49999999999999 in binary
    (0.0005, 3, 0.001),
    (0.4445, 3, 0.445),
    (0.9549999, 2, 0.95),
    (0.955, 2, 0.96),
    (12.345, 2, 12.35),
    (0.2675, 3, 0.268),
]


@pytest.mark.parametrize(("a", "b", "expected"), VENDOR_CASES)
def test_vendor_similarity_matches_ts(a, b, expected):
    assert vendor_similarity(a, b) == expected


@pytest.mark.parametrize(("a", "b", "expected"), VENDOR_CASES)
def test_vendor_similarity_is_symmetric_on_cases(a, b, expected):
    assert vendor_similarity(b, a) == expected


@pytest.mark.parametrize(("a", "b", "expected"), JW_CASES)
def test_jaro_winkler_matches_ts(a, b, expected):
    assert jaro_winkler(a, b) == expected


@pytest.mark.parametrize(("s", "expected"), NORM_CASES)
def test_normalize_vendor_matches_ts(s, expected):
    assert normalize_vendor(s) == expected


@pytest.mark.parametrize(("x", "dp", "expected"), JS_ROUND_CASES)
def test_js_round_is_math_round_half_up(x, dp, expected):
    assert js_round(x, dp) == expected


def test_js_round_differs_from_python_round_on_ties():
    assert js_round(0.125, 2) != round(0.125, 2)
    assert js_round(2.5, 0) != round(2.5)


def test_js_round_default_is_two_places():
    assert js_round(0.915) == js_round(0.915, 2)


@pytest.mark.parametrize(("token", "expected"), [("amazon", "amzn"), ("traders", "trdrs"), ("acme", "acm"), ("aws", "aws")])
def test_skeleton_keeps_first_letter_drops_vowels(token, expected):
    assert skeleton(token) == expected


def test_vendor_similarity_bounds_and_two_decimals():
    for a, b, _ in VENDOR_CASES:
        v = vendor_similarity(a, b)
        assert 0.0 <= v <= 1.0
        assert round(v * 100) == pytest.approx(v * 100)
