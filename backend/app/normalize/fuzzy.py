"""Line-for-line port of src/lib/fuzzy.ts so UI previews equal backend decisions.

JS parity notes: `/[^a-z0-9 ]+/g` and `/\\d/` are ASCII-only, `toLowerCase` on the narrations we
see is equivalent to str.lower(), and `Math.round(x * 100) / 100` rounds half up (towards +inf),
which we reproduce with floor(x * 100 + 0.5).
"""

import math
import re
from functools import lru_cache

NOISE = {
    "pvt", "ltd", "private", "limited", "llp", "inc", "india", "co", "corp", "corporation",
    "mktp", "mktplace", "us", "in", "the", "and", "neft", "rtgs", "imps", "upi", "nach", "ach",
    "dr", "cr", "pos", "payment", "pay", "services", "svc",
}

_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")
_DIGIT = re.compile(r"[0-9]")


def js_round(x: float, dp: int = 2) -> float:
    """Math.round(x * 10^dp) / 10^dp — half rounds toward +infinity like JS."""
    f = 10**dp
    return math.floor(x * f + 0.5) / f


def normalize_vendor(s: str) -> list[str]:
    s = _NON_ALNUM.sub(" ", s.lower())
    return [t for t in _WS.split(s) if len(t) > 1 and t not in NOISE and not _DIGIT.search(t)]


def jaro_winkler(a: str, b: str) -> float:
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    rng = max(0, max(len(a), len(b)) // 2 - 1)
    a_m = [False] * len(a)
    b_m = [False] * len(b)
    matches = 0
    for i in range(len(a)):
        lo = max(0, i - rng)
        hi = min(i + rng + 1, len(b))
        for j in range(lo, hi):
            if not b_m[j] and a[i] == b[j]:
                a_m[i] = b_m[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    t = 0
    k = 0
    for i in range(len(a)):
        if not a_m[i]:
            continue
        while not b_m[k]:
            k += 1
        if a[i] != b[k]:
            t += 1
        k += 1
    m = matches
    jaro = (m / len(a) + m / len(b) + (m - t / 2) / m) / 3
    prefix = 0
    while prefix < 4 and prefix < len(a) and prefix < len(b) and a[prefix] == b[prefix]:
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def skeleton(t: str) -> str:
    """First letter + consonants: "amazon" -> "amzn" — catches bank abbreviations."""
    return t[0] + re.sub(r"[aeiou]", "", t[1:])


@lru_cache(maxsize=200_000)
def vendor_similarity(a: str, b: str) -> float:
    ta = normalize_vendor(a)
    tb = normalize_vendor(b)
    if not ta or not tb:
        return 0.0
    full = jaro_winkler(" ".join(ta), " ".join(tb))
    best = 0.0
    for x in ta:
        for y in tb:
            s = jaro_winkler(x, y)
            if len(x) >= 3 and len(y) >= 3 and (skeleton(x) == skeleton(y) or skeleton(x) == y or x == skeleton(y)):
                s = max(s, 0.92)
            best = max(best, s)
    score = max(full, best * 0.97)
    return js_round(score, 2)
