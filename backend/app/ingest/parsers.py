"""Upload parsing: CSV (ICICI iBizz, Tally day book, generic) and PDF statements (pdfplumber + OCR fallback).

A parsed upload keeps every row keyed by the ORIGINAL headers plus an auto column mapping
(canonical field -> source column). Canonicalization into signed transactions happens at run time
(`to_canonical`) so user-supplied mappings and sign conventions can be honoured.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

import pandas as pd

from app.core.money import ZERO, D, fmt, inr

DATE_HEADERS = re.compile(r"^(txn date|transaction date|date|value date|value dt|posting date|voucher date|tran date|txn dt)$", re.I)
AMOUNT_HEADERS = re.compile(r"^(amount|amt|txn amount|transaction amount)$", re.I)
DEBIT_HEADERS = re.compile(r"^(debit|withdrawal amt\.?|withdrawal|withdrawals|dr|debit amount|debit amt\.?)$", re.I)
CREDIT_HEADERS = re.compile(r"^(credit|deposit amt\.?|deposit|deposits|cr|credit amount|credit amt\.?)$", re.I)
DESC_HEADERS = re.compile(r"^(description|narration|particulars|remarks|transaction remarks|details)$", re.I)
REF_HEADERS = re.compile(r"^(ref no\.?|ref|reference|chq\.?/ref\.?no\.?|cheque no\.?|chq no\.?|vch no\.?|utr|reference no\.?)$", re.I)
BAL_HEADERS = re.compile(r"^(balance|closing balance|running balance)$", re.I)

DATE_FORMATS = ("%d/%m/%y", "%d/%m/%Y", "%d-%b-%Y", "%d-%b-%y", "%Y-%m-%d", "%d-%m-%Y", "%d-%m-%y", "%d %b %Y", "%d.%m.%Y", "%d %b %y")


class ParseError(Exception):
    pass


def parse_date(s: str) -> date:
    s = (s or "").strip()
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    raise ParseError(f"Unrecognized date '{s}'")


@dataclass
class Parsed:
    detected: str  # parser id: icici | tally | generic_bank | generic_ledger | hdfc_pdf | pdf
    detected_format: str
    columns: list[str]
    rows: list[dict[str, str]]
    mapping: dict[str, str]
    auto_mapped: bool
    warnings: list[dict] = field(default_factory=list)
    sanity: dict | None = None
    row_meta: list[dict] = field(default_factory=list)  # per-row {_page,_line} or {_row}


def _find(cols: list[str], pat: re.Pattern) -> str | None:
    for c in cols:
        if pat.match(c.strip()):
            return c
    return None


def auto_mapping(cols: list[str], detected: str) -> dict[str, str]:
    m: dict[str, str] = {}
    if detected == "tally":
        m = {"date": "Voucher Date", "description": "Narration" if "Narration" in cols else "Particulars", "vendor": "Particulars",
             "debit": "Debit", "credit": "Credit", "reference": "Vch No."}
        if "Ledger" in cols:
            m["account"] = "Ledger"
        if "Cost Centre" in cols:
            m["gl"] = "Cost Centre"
        return {k: v for k, v in m.items() if v in cols}
    if c := _find(cols, DATE_HEADERS):
        m["date"] = c
    if c := _find(cols, DESC_HEADERS):
        m["description"] = c
    if c := _find(cols, AMOUNT_HEADERS):
        m["amount"] = c
    if c := _find(cols, DEBIT_HEADERS):
        m["debit"] = c
    if c := _find(cols, CREDIT_HEADERS):
        m["credit"] = c
    if c := _find(cols, REF_HEADERS):
        m["reference"] = c
    if c := _find(cols, BAL_HEADERS):
        m["balance"] = c
    return m


def mapping_complete(m: dict[str, str]) -> bool:
    return bool(m.get("date") and m.get("description") and (m.get("amount") or (m.get("debit") and m.get("credit"))))


# ----------------------------------------------------------------------------- CSV
def parse_csv(raw: bytes, kind: str) -> Parsed:
    text = None
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None or "\x00" in text[:2048]:
        raise ParseError("File is not a text CSV (looks binary — an XLS saved with a .csv extension?)")
    try:
        df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, skip_blank_lines=True)
    except Exception as e:  # pandas.errors.ParserError, EmptyDataError
        raise ParseError(f"Could not read CSV: {e}") from e
    cols = [str(c).strip() for c in df.columns]
    if not cols or all(c.startswith("Unnamed") for c in cols):
        raise ParseError("Header row not found")
    df.columns = cols
    rows = [{c: str(v).strip() for c, v in r.items()} for r in df.to_dict(orient="records")]
    rows = [r for r in rows if any(v for v in r.values())]
    lower = {c.lower() for c in cols}
    if {"vch type", "vch no.", "particulars"} & lower and "voucher date" in lower:
        detected, label = "tally", "Tally Prime day book (CSV)"
    elif "txn date" in lower and "ref no" in lower:
        detected, label = "icici", "ICICI iBizz CSV"
    else:
        detected = "generic_ledger" if kind == "ledger" else "generic_bank"
        label = "Generic ledger CSV" if kind == "ledger" else "Generic bank CSV"
    mapping = auto_mapping(cols, detected)
    ok = mapping_complete(mapping)
    p = Parsed(detected, label, cols, rows, mapping if ok else {}, ok, row_meta=[{"_row": i + 2} for i in range(len(rows))])
    if ok and kind == "bank":
        p.sanity = sanity_from_rows(rows, mapping, detected)
    return p


# ----------------------------------------------------------------------------- PDF
PDF_HEADER_HINTS = ("date", "narration", "withdrawal", "deposit", "balance")
OPENING = re.compile(r"opening\s+balance[^\d\-]*(-?[\d,]+\.\d{2})", re.I)
CLOSING = re.compile(r"closing\s+balance[^\d\-]*(-?[\d,]+\.\d{2})", re.I)
OCR_LINE = re.compile(r"^(\d{2}/\d{2}/\d{2,4})\s+(.+?)\s+(\S+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$")
MIN_PAGE_TEXT = 40


def _clean_cell(c) -> str:
    return re.sub(r"\s+", " ", str(c or "")).strip()


def parse_pdf(raw: bytes) -> Parsed:
    import pdfplumber

    try:
        pdf = pdfplumber.open(io.BytesIO(raw))
    except Exception as e:
        raise ParseError("Not a readable PDF (file is corrupt or encrypted)") from e
    header: list[str] | None = None
    rows: list[dict[str, str]] = []
    meta: list[dict] = []
    warnings: list[dict] = []
    full_text = []
    bank_name = None
    with pdf:
        if not pdf.pages:
            raise ParseError("PDF has no pages")
        for pno, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            full_text.append(text)
            if bank_name is None:
                m = re.search(r"(HDFC|ICICI|SBI|AXIS|KOTAK|YES)\s+BANK", text, re.I)
                bank_name = m.group(1).upper() if m else None
            if len(text.strip()) < MIN_PAGE_TEXT:
                warnings.append({"page": pno, "message": f"Page {pno}: table could not be detected (no text layer) — retry with OCR", "canRetryOcr": True})
                continue
            tables = page.extract_tables() or []
            line = 0
            got = False
            for tbl in tables:
                for r in tbl:
                    cells = [_clean_cell(c) for c in r]
                    if not any(cells):
                        continue
                    low = [c.lower() for c in cells]
                    if sum(any(h in c for h in PDF_HEADER_HINTS) for c in low) >= 3:
                        header = cells
                        continue
                    if header is None or len(cells) != len(header):
                        continue
                    if not re.match(r"^\d{2}[/\-]\d{2}[/\-]\d{2,4}$", cells[0]):
                        continue
                    line += 1
                    got = True
                    rows.append(dict(zip(header, cells, strict=True)))
                    meta.append({"_page": pno, "_line": line})
            if not got:
                warnings.append({"page": pno, "message": f"Page {pno}: table could not be detected — retry with OCR", "canRetryOcr": True})
    if header is None:
        raise ParseError("No transaction table found in PDF")
    detected = "hdfc_pdf" if bank_name == "HDFC" else "pdf"
    label = "HDFC Bank statement (PDF)" if bank_name == "HDFC" else (f"{bank_name.title()} Bank statement (PDF)" if bank_name else "Bank statement (PDF)")
    mapping = auto_mapping(header, detected)
    text = "\n".join(full_text)
    p = Parsed(detected, label, header, rows, mapping, mapping_complete(mapping), warnings, row_meta=meta)
    p.sanity = sanity_from_rows(rows, mapping, detected, text=text, missing_pages=[w["page"] for w in warnings])
    return p


def ocr_pages(raw: bytes, pages: list[int], header: list[str]) -> tuple[list[dict[str, str]], list[dict], list[str]]:
    """OCR the given 1-based pages. Returns (rows, meta, errors)."""
    import pdfplumber

    try:
        import pytesseract
    except ImportError:  # pragma: no cover
        return [], [], ["OCR engine (pytesseract) is not installed"]
    rows: list[dict[str, str]] = []
    meta: list[dict] = []
    errors: list[str] = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for pno in pages:
            try:
                img = pdf.pages[pno - 1].to_image(resolution=300).original
                text = pytesseract.image_to_string(img, config="--psm 6")
            except Exception as e:  # tesseract binary missing etc.
                errors.append(f"Page {pno}: OCR failed ({type(e).__name__}: {str(e)[:80]})")
                continue
            line = 0
            prev_bal: Decimal | None = None
            for ln in text.splitlines():
                m = OCR_LINE.match(ln.strip())
                if not m:
                    continue
                d, narr, ref, amt, bal = m.groups()
                amt_d, bal_d = D(amt), D(bal)
                # Withdrawal vs deposit from the running balance delta when available
                is_dep = prev_bal is not None and bal_d - prev_bal == amt_d
                prev_bal = bal_d
                line += 1
                row = {h: "" for h in header}
                cols = auto_mapping(header, "pdf")
                row[cols.get("date", header[0])] = d
                if "description" in cols:
                    row[cols["description"]] = narr
                if "reference" in cols:
                    row[cols["reference"]] = ref
                if is_dep and "credit" in cols:
                    row[cols["credit"]] = fmt(amt_d)
                elif "debit" in cols:
                    row[cols["debit"]] = fmt(amt_d)
                if "balance" in cols:
                    row[cols["balance"]] = fmt(bal_d)
                rows.append(row)
                meta.append({"_page": pno, "_line": line, "_ocr": True})
            if line == 0:
                errors.append(f"Page {pno}: OCR found no transaction rows")
    return rows, meta, errors


# ----------------------------------------------------------------------------- canonical rows
@dataclass
class CanonRow:
    date: date
    amount: Decimal
    description: str
    reference: str | None
    vendor: str | None
    gl: str | None
    account_label: str | None
    balance: Decimal | None
    raw: dict


def signed_amount(r: dict[str, str], m: dict[str, str], detected: str, sign: str | None) -> Decimal:
    if m.get("amount") and r.get(m["amount"], "") != "":
        a = D(r[m["amount"]])
        return -a if sign == "credit_negative" else a
    dr = D(r.get(m.get("debit", ""), "") or "0")
    cr = D(r.get(m.get("credit", ""), "") or "0")
    if detected == "tally":
        # Tally bank-ledger day book: Debit = money into the bank, Credit = money out.
        return abs(dr) - abs(cr)
    return abs(cr) - abs(dr)


def to_canonical(rows: list[dict[str, str]], m: dict[str, str], detected: str, sign: str | None, meta: list[dict] | None = None) -> list[CanonRow]:
    out = []
    for i, r in enumerate(rows):
        try:
            d = parse_date(r.get(m["date"], ""))
        except (ParseError, KeyError):
            continue
        try:
            a = signed_amount(r, m, detected, sign)
        except ValueError:
            continue
        if a == 0:
            continue
        bal = None
        if m.get("balance") and r.get(m["balance"]):
            try:
                bal = D(r[m["balance"]])
            except ValueError:
                bal = None
        raw = {**(meta[i] if meta and i < len(meta) else {}), **r}
        out.append(CanonRow(
            date=d, amount=a, description=r.get(m.get("description", ""), "").strip(),
            reference=(r.get(m["reference"]) or None) if m.get("reference") else None,
            vendor=(r.get(m["vendor"]) or None) if m.get("vendor") else None,
            gl=(r.get(m["gl"]) or None) if m.get("gl") else None,
            account_label=(r.get(m["account"]) or None) if m.get("account") else None,
            balance=bal, raw=raw,
        ))
    return out


def sanity_from_rows(rows: list[dict[str, str]], m: dict[str, str], detected: str, text: str = "", missing_pages: list[int] | None = None) -> dict | None:
    canon = to_canonical(rows, m, detected, None)
    if not canon:
        return None
    total = sum((c.amount for c in canon), ZERO)
    op = cl = None
    if text:
        if mo := OPENING.search(text):
            op = D(mo.group(1))
        if mc := CLOSING.search(text):
            cl = D(mc.group(1))
    with_bal = [c for c in canon if c.balance is not None]
    if op is None and with_bal:
        op = with_bal[0].balance - with_bal[0].amount
    if cl is None and with_bal:
        cl = with_bal[-1].balance
    if op is None or cl is None:
        return None
    computed = op + total
    ok = computed == cl
    expl = None
    if not ok:
        gap = computed - cl
        direction = "higher" if gap > 0 else "lower"
        cause = (
            f"Rows on page{'s' if len(missing_pages or []) > 1 else ''} {', '.join(map(str, missing_pages))} were not detected — retrying with OCR usually fixes this."
            if missing_pages else "Some rows may be missing or duplicated in the export; check for a truncated page or a filtered date range."
        )
        expl = f"Computed closing balance is {inr(gap)} {direction} than the statement's closing balance. {cause}"
    return {
        "openingBalance": fmt(op), "sumOfTxns": fmt(total), "closingBalance": fmt(cl), "computedClosing": fmt(computed),
        "ok": ok, **({"explanation": expl} if expl else {}),
    }


def resolve_mapping(user_map: dict[str, str] | None, columns: list[str]) -> dict[str, str] | None:
    """Accept {canonical: column} or {column: canonical}; decide by which side holds real headers."""
    if not user_map:
        return None
    cols = set(columns)
    vals_are_cols = sum(1 for v in user_map.values() if v in cols)
    keys_are_cols = sum(1 for k in user_map if k in cols)
    m = {k: v for k, v in user_map.items() if v} if vals_are_cols >= keys_are_cols else {v: k for k, v in user_map.items() if v}
    return {k: v for k, v in m.items() if v in cols}
