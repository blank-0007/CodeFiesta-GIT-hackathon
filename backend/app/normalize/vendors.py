"""Normalize stage: extract the counterparty from Indian bank narrations and canonicalize it.

NEFT DR-HDFC0000123-ACME TRADERS-INV2041   -> "ACME TRADERS" -> "ACME Traders Pvt Ltd" (ledger master)
UPI/412345678901/SWIGGY/swiggy@ybl         -> "SWIGGY"
NACH-DR-ZOHO CORP-4471029381               -> "ZOHO CORP"
IMPS/P2A/612345098712/OFFICEMART           -> "OFFICEMART"
POS 4521XXXXXXXX9921 MAKEMYTRIP BANGALORE  -> "MAKEMYTRIP"
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.normalize.fuzzy import jaro_winkler, normalize_vendor, skeleton, vendor_similarity

IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
CHANNEL = re.compile(r"^(?:BULK\s+)?(NEFT|RTGS|UPI|NACH|IMPS|POS|CHQ|CLG)\b", re.I)
ACCOUNT_LIKE = re.compile(r"\b(\d[\dX]{7,}\d{3,4})\b")
CITIES = {"BANGALORE", "BENGALURU", "MUMBAI", "DELHI", "PUNE", "CHENNAI", "HYDERABAD", "GURGAON", "NOIDA", "KOLKATA", "BLR"}

BANK_CHARGE = re.compile(r"^(CHRG|GST ON CHGS|.*ANNUAL FEE|SMS CHGS|NEFT/RTGS CHGS|MIN BAL CHGS)", re.I)
INTEREST = re.compile(r"^(INT\.?PD|INT\.? CREDIT|INTEREST)", re.I)
CASH = re.compile(r"^(CASH WDL|ATM WDL|CASH DEP)", re.I)
SALARY = re.compile(r"SALARY|PAYROLL", re.I)


def channel_of(desc: str) -> str | None:
    m = CHANNEL.match(desc.strip())
    if not m:
        return None
    ch = m.group(1).upper()
    return "CHQ" if ch == "CLG" else ch


def extract_counterparty(desc: str, bank_name: str = "Bank") -> str:
    d = desc.strip()
    u = d.upper()
    if BANK_CHARGE.match(u):
        return f"{bank_name} — charges"
    if INTEREST.match(u):
        return f"{bank_name} — interest"
    if CASH.match(u):
        return "ATM cash withdrawal" if "WDL" in u else "Cash deposit"
    if SALARY.search(u) and ("BULK" in u or "BATCH" in u):
        return "Payroll — Bulk salary"
    ch = channel_of(u)
    if ch in ("NEFT", "RTGS"):
        parts = [p.strip() for p in d.split("-")]
        # "NEFT DR" - IFSC - NAME - ref...
        if len(parts) >= 3 and IFSC.match(parts[1].upper()):
            return parts[2]
        if len(parts) >= 2:
            return parts[1]
    if ch in ("UPI",):
        parts = d.split("/")
        if len(parts) >= 3:
            return parts[2]
    if ch == "IMPS":
        parts = d.split("/")
        if len(parts) >= 4:
            return parts[3]
    if ch == "NACH":
        parts = [p.strip() for p in d.split("-")]
        if len(parts) >= 3:
            return parts[2]
    if ch == "POS":
        toks = d.split()[2:]  # drop "POS" + masked card
        if len(toks) > 1 and toks[-1].upper() in CITIES:
            toks = toks[:-1]
        return " ".join(toks) or d
    if ch == "CHQ":
        parts = [p.strip() for p in d.split("-")]
        return parts[-1] if len(parts) >= 2 else d
    # Generic: strip leading channel words / numbers
    toks = [t for t in re.split(r"[\s/\-]+", d) if t and not re.search(r"\d{4,}", t)]
    return " ".join(toks[:4]) or d


def title_case(s: str) -> str:
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), s.lower())


_SMALL_WORDS = {"of", "and", "the", "for"}
_LEGAL_WORDS = {"co", "pvt", "ltd", "llp", "inc"}


def display_name(s: str) -> str:
    """Narration name -> display name: title case, but keep acronyms ("LIC OF INDIA" -> "LIC of India")."""
    out = []
    for i, w in enumerate(s.split()):
        lw = w.lower()
        if i and lw in _SMALL_WORDS:
            out.append(lw)
        elif lw in _LEGAL_WORDS:
            out.append(lw.capitalize())
        elif w.isalpha() and w.isupper() and (len(w) <= 3 or not re.search(r"[AEIOU]", w)):
            out.append(w)
        else:
            out.append(title_case(w))
    return " ".join(out)


@dataclass
class AliasRule:
    rule_id: str
    canonical: str
    aliases: list[str]


# Words that never carry a brand: dropped when building initials ("Amazon Web Services India" -> "aws").
_NON_BRAND = {"pvt", "ltd", "private", "limited", "llp", "inc", "india", "co", "corp", "corporation", "the", "and", "of", "&"}


def initials(name: str) -> str:
    words = [w for w in re.split(r"[^a-z&]+", name.lower()) if w and w not in _NON_BRAND]
    return "".join(w[0] for w in words) if len(words) >= 2 else ""


def _token_close(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) >= 3 and len(b) >= 3 and (a.startswith(b) or b.startswith(a) or skeleton(a) == skeleton(b) or skeleton(a) == b or a == skeleton(b)):
        return True
    return jaro_winkler(a, b) >= 0.85


def lead_token_agrees(extracted: str, candidate: str) -> bool:
    """The leading (brand) token of a narration name must appear in the candidate. vendor_similarity takes
    the best single-token score, so a shared generic word ("DLVRY LOGISTICS" vs "Mahindra Logistics")
    would otherwise canonicalize a payee to the wrong vendor."""
    toks = normalize_vendor(extracted)
    if not toks:
        return True
    return any(_token_close(toks[0], c) for c in normalize_vendor(candidate))


def upi_handle(desc: str) -> str | None:
    """UPI/412345678901/BUNDL TECHNOLOGIES/swiggy@ybl -> "swiggy" (VPA handles usually carry the brand)."""
    if channel_of(desc) != "UPI" or "@" not in desc:
        return None
    h = desc.rsplit("/", 1)[-1].split("@")[0]
    h = " ".join(t for t in re.split(r"[^A-Za-z]+", h) if len(t) > 2)
    return h or None


@dataclass
class VendorResolver:
    """Canonicalizes extracted names against the ledger vendor master + approved alias rules.

    Order: approved alias rules -> fuzzy match to the master (>= threshold and the brand token agrees)
    -> initialism ("AWS" = Amazon Web Services) -> UPI VPA handle -> the narration name, title-cased."""

    master: list[str]
    aliases: list[AliasRule] = field(default_factory=list)
    threshold: float = 0.9
    hits: dict[str, int] = field(default_factory=dict)
    _cache: dict[tuple[str, str | None], str] = field(default_factory=dict)
    _initials: dict[str, list[str]] | None = None

    def _match(self, name: str) -> str | None:
        best, best_s = None, 0.0
        for v in self.master:
            s = vendor_similarity(name, v)
            if s > best_s and lead_token_agrees(name, v):
                best, best_s = v, s
        if best is not None and best_s >= self.threshold:
            return best
        if self._initials is None:
            self._initials = {}
            for v in self.master:
                if ini := initials(v):
                    self._initials.setdefault(ini, []).append(v)
        for tok in normalize_vendor(name):
            hits = self._initials.get(tok, []) if 3 <= len(tok) <= 5 else []
            if len(hits) == 1:
                return hits[0]
        return None

    def resolve(self, raw_desc: str, extracted: str) -> str:
        up = raw_desc.upper()
        for a in self.aliases:
            if any(al.upper() in up for al in a.aliases if al):
                self.hits[a.rule_id] = self.hits.get(a.rule_id, 0) + 1
                return a.canonical
        handle = upi_handle(raw_desc)
        key = (extracted, handle)
        if key in self._cache:
            return self._cache[key]
        out = None if "—" in extracted else self._match(extracted)
        if out is None and handle:
            out = self._match(handle)
        if out is None:
            out = extracted if "—" in extracted else display_name(extracted)
        self._cache[key] = out
        return out


def unique(xs: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for x in xs:
        if x:
            seen.setdefault(x, None)
    return list(seen)


def mask_numbers(text: str) -> str:
    """Mask account/card numbers (keep last 4) before anything leaves our process."""

    def _m(m: re.Match) -> str:
        s = m.group(1)
        return "X" * (len(s) - 4) + s[-4:]

    return ACCOUNT_LIKE.sub(_m, text)
