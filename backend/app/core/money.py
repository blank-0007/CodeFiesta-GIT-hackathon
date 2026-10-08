"""Decimal money helpers. Money never touches float."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def D(v: object) -> Decimal:
    """Parse a money-ish value into a Decimal (strings with commas / ₹ tolerated)."""
    if isinstance(v, Decimal):
        return v
    if v is None or v == "":
        return ZERO
    if isinstance(v, float):  # only ever from foreign input (e.g. pandas); go through repr to avoid binary noise
        v = repr(v)
    s = str(v).strip().replace(",", "").replace("₹", "").replace("Rs.", "").replace("Rs", "").strip()
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1]
    if s.upper().endswith(" DR") or s.upper().endswith(" CR"):
        s = s[:-3].strip()
    try:
        d = Decimal(s)
    except InvalidOperation as e:
        raise ValueError(f"Not a valid amount: {v!r}") from e
    return -d if neg else d


def q2(d: Decimal) -> Decimal:
    out = d.quantize(CENT, rounding=ROUND_HALF_UP)
    return ZERO if out == 0 else out


def fmt(d: object) -> str:
    """Wire format: decimal string with exactly 2 dp, e.g. "-124500.00"."""
    return str(q2(D(d)))


def inr(d: object) -> str:
    """Human format with Indian grouping: ₹1,24,500.00 (absolute value)."""
    s = fmt(abs(D(d)))
    i, f = s.split(".")
    last3, rest = i[-3:], i[:-3]
    if rest:
        groups = []
        while len(rest) > 2:
            groups.insert(0, rest[-2:])
            rest = rest[:-2]
        if rest:
            groups.insert(0, rest)
        i = ",".join(groups) + "," + last3
    return f"₹{i}.{f}"


def total(xs) -> Decimal:
    t = ZERO
    for x in xs:
        t += D(x)
    return t
