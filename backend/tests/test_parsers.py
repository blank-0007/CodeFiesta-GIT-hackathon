"""Upload parsing (app.ingest.parsers): CSV format detection, mappings, sign conventions, sanity, PDFs."""

import io
from datetime import date
from decimal import Decimal

import pytest

from app.ingest.parsers import (
    ParseError,
    auto_mapping,
    mapping_complete,
    parse_csv,
    parse_date,
    parse_pdf,
    resolve_mapping,
    signed_amount,
    to_canonical,
)

ICICI_CSV = (
    "Txn Date,Value Date,Description,Ref No,Debit,Credit,Balance\n"
    "01/09/2026,01/09/2026,NEFT-ACME TRADERS-INV 101,UTR0001,\"12,500.00\",,\"87,500.00\"\n"
    "02/09/2026,02/09/2026,RZP SETTLEMENT,UTR0002,,\"25,000.00\",\"1,12,500.00\"\n"
    "03/09/2026,03/09/2026,AWS INDIA,UTR0003,\"2,345.67\",,\"1,10,154.33\"\n"
    "\n"
)

TALLY_CSV = (
    "Voucher Date,Particulars,Vch Type,Vch No.,Debit,Credit,Narration\n"
    "01-Sep-2026,ACME Traders Pvt Ltd,Payment,PV-09-0001,,12500.00,Being payment against INV 101\n"
    "02-Sep-2026,Razorpay Software,Receipt,RV-09-0001,25000.00,,Settlement received\n"
)


# ---------------------------------------------------------------- dates
@pytest.mark.parametrize(
    "s",
    ["05/09/26", "05/09/2026", "05-Sep-2026", "05-Sep-26", "2026-09-05", "05-09-2026", "05-09-26", "05 Sep 2026",
     "05.09.2026", "05 Sep 26", "  05/09/2026  "],
)
def test_parse_date_formats(s):
    assert parse_date(s) == date(2026, 9, 5)


@pytest.mark.parametrize("s", ["", "not a date", "2026/13/45", "32/01/2026", None])
def test_parse_date_rejects(s):
    with pytest.raises(ParseError):
        parse_date(s)


# ---------------------------------------------------------------- CSV detection
def test_icici_ibizz_detected_and_mapped():
    p = parse_csv(ICICI_CSV.encode(), "bank")
    assert p.detected == "icici"
    assert p.detected_format == "ICICI iBizz CSV"
    assert p.auto_mapped is True
    assert p.mapping == {"date": "Txn Date", "description": "Description", "debit": "Debit", "credit": "Credit",
                         "reference": "Ref No", "balance": "Balance"}
    assert len(p.rows) == 3  # blank line dropped
    assert p.row_meta == [{"_row": 2}, {"_row": 3}, {"_row": 4}]
    canon = to_canonical(p.rows, p.mapping, p.detected, None)
    assert [c.amount for c in canon] == [Decimal("-12500.00"), Decimal("25000.00"), Decimal("-2345.67")]
    assert canon[0].reference == "UTR0001" and canon[0].date == date(2026, 9, 1)


def test_icici_sanity_ok_with_derived_opening():
    p = parse_csv(ICICI_CSV.encode(), "bank")
    # opening is derived from the first balance row: 87,500 - (-12,500) = 1,00,000
    assert p.sanity == {"openingBalance": "100000.00", "sumOfTxns": "10154.33", "closingBalance": "110154.33",
                        "computedClosing": "110154.33", "ok": True}


def test_icici_sanity_flags_missing_row():
    rows = ICICI_CSV.strip().split("\n")
    broken = "\n".join([rows[0], rows[1], rows[3]]) + "\n"  # drop the 25,000 credit
    p = parse_csv(broken.encode(), "bank")
    assert p.sanity["ok"] is False
    assert p.sanity["computedClosing"] == "85154.33"
    assert "₹25,000.00 lower" in p.sanity["explanation"]


def test_csv_sanity_only_for_bank_uploads():
    assert parse_csv(ICICI_CSV.encode(), "ledger").sanity is None


def test_tally_day_book_detected_with_debit_into_bank():
    p = parse_csv(TALLY_CSV.encode(), "ledger")
    assert p.detected == "tally"
    assert p.detected_format == "Tally Prime day book (CSV)"
    assert p.auto_mapped is True
    assert p.mapping == {"date": "Voucher Date", "description": "Narration", "vendor": "Particulars", "debit": "Debit",
                         "credit": "Credit", "reference": "Vch No."}
    canon = to_canonical(p.rows, p.mapping, p.detected, None)
    # Tally bank ledger: Debit = money INTO the bank -> signed = debit - credit
    assert [c.amount for c in canon] == [Decimal("-12500.00"), Decimal("25000.00")]
    assert canon[0].vendor == "ACME Traders Pvt Ltd"
    assert canon[0].description == "Being payment against INV 101"
    assert canon[1].date == date(2026, 9, 2)


def test_generic_csv_with_known_headers_is_auto_mapped():
    raw = b"Date,Remarks,Amount\n05/09/2026,UPI-ZOMATO,-450.00\n"
    p = parse_csv(raw, "bank")
    assert p.detected == "generic_bank" and p.detected_format == "Generic bank CSV"
    assert p.auto_mapped is True
    assert p.mapping == {"date": "Date", "description": "Remarks", "amount": "Amount"}
    assert p.sanity is None  # no balance column, no statement text


def test_generic_csv_unknown_headers_not_auto_mapped():
    raw = b"Foo,Bar,Baz\n1,2,3\n4,5,6\n"
    p = parse_csv(raw, "ledger")
    assert p.detected == "generic_ledger"
    assert p.auto_mapped is False
    assert p.mapping == {}
    assert p.columns == ["Foo", "Bar", "Baz"]
    assert len(p.rows) == 2
    assert p.sanity is None


def test_csv_utf8_bom_and_cp1252():
    p = parse_csv("﻿Date,Narration,Amount\n05/09/2026,Café,10.00\n".encode(), "bank")
    assert p.columns[0] == "Date"
    p2 = parse_csv("Date,Narration,Amount\n05/09/2026,Café ₹,10.00\n".encode("cp1252", errors="replace"), "bank")
    assert p2.rows[0]["Narration"].startswith("Caf")


def test_binary_garbage_raises_parse_error():
    garbage = bytes(range(256)) * 8
    with pytest.raises(ParseError, match="binary"):
        parse_csv(garbage, "bank")


def test_xlsx_bytes_raise_parse_error():
    zipish = b"PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00" + bytes(200)
    with pytest.raises(ParseError):
        parse_csv(zipish, "bank")


def test_empty_csv_raises_parse_error():
    with pytest.raises(ParseError):
        parse_csv(b"", "bank")


# ---------------------------------------------------------------- mappings & signs
def test_resolve_mapping_canonical_to_column():
    cols = ["Txn Date", "Description", "Amt", "Other"]
    assert resolve_mapping({"date": "Txn Date", "description": "Description", "amount": "Amt"}, cols) == {
        "date": "Txn Date", "description": "Description", "amount": "Amt"}


def test_resolve_mapping_column_to_canonical():
    cols = ["Txn Date", "Description", "Amt", "Other"]
    assert resolve_mapping({"Txn Date": "date", "Description": "description", "Amt": "amount", "Other": ""}, cols) == {
        "date": "Txn Date", "description": "Description", "amount": "Amt"}


def test_resolve_mapping_drops_unknown_columns_and_empty():
    cols = ["Date", "Narration"]
    assert resolve_mapping({"date": "Date", "description": "Narration", "reference": "Nope", "gl": ""}, cols) == {
        "date": "Date", "description": "Narration"}
    assert resolve_mapping(None, cols) is None
    assert resolve_mapping({}, cols) is None


def test_signed_amount_amount_column_and_credit_negative():
    m = {"amount": "Amount"}
    assert signed_amount({"Amount": "1,500.00"}, m, "generic_ledger", None) == Decimal("1500.00")
    assert signed_amount({"Amount": "1,500.00"}, m, "generic_ledger", "credit_negative") == Decimal("-1500.00")
    assert signed_amount({"Amount": "-200.00"}, m, "generic_ledger", "credit_negative") == Decimal("200.00")


def test_signed_amount_debit_credit_columns():
    m = {"debit": "Dr", "credit": "Cr"}
    assert signed_amount({"Dr": "100.00", "Cr": ""}, m, "generic_bank", None) == Decimal("-100.00")
    assert signed_amount({"Dr": "", "Cr": "100.00"}, m, "generic_bank", None) == Decimal("100.00")
    # Tally flips: Debit is money into the bank
    assert signed_amount({"Dr": "100.00", "Cr": ""}, m, "tally", None) == Decimal("100.00")
    assert signed_amount({"Dr": "", "Cr": "100.00"}, m, "tally", None) == Decimal("-100.00")


def test_signed_amount_falls_back_to_debit_credit_when_amount_blank():
    m = {"amount": "Amount", "debit": "Dr", "credit": "Cr"}
    assert signed_amount({"Amount": "", "Dr": "", "Cr": "75.00"}, m, "generic_bank", None) == Decimal("75.00")


def test_to_canonical_skips_bad_dates_amounts_and_zero_rows():
    m = {"date": "Date", "description": "Desc", "amount": "Amount"}
    rows = [
        {"Date": "05/09/2026", "Desc": " ok ", "Amount": "10.00"},
        {"Date": "garbage", "Desc": "bad date", "Amount": "10.00"},
        {"Date": "05/09/2026", "Desc": "bad amount", "Amount": "abc"},
        {"Date": "05/09/2026", "Desc": "zero", "Amount": "0.00"},
    ]
    canon = to_canonical(rows, m, "generic_bank", None, meta=[{"_row": 2}, {"_row": 3}, {"_row": 4}, {"_row": 5}])
    assert len(canon) == 1
    assert canon[0].description == "ok"
    assert canon[0].raw["_row"] == 2


def test_auto_mapping_and_completeness():
    cols = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]
    m = auto_mapping(cols, "pdf")
    assert m == {"date": "Date", "description": "Narration", "debit": "Withdrawal Amt.", "credit": "Deposit Amt.",
                 "reference": "Chq./Ref.No.", "balance": "Closing Balance"}
    assert mapping_complete(m)
    assert not mapping_complete({"date": "Date", "description": "Narration", "debit": "Dr"})


# ---------------------------------------------------------------- PDF
HDFC_HEADER = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]
HDFC_ROWS = [
    ["01/09/26", "NEFT DR-ACME TRADERS", "0000123456", "01/09/26", "12,500.00", "", "87,500.00"],
    ["02/09/26", "RZP SETTLEMENT", "0000123457", "02/09/26", "", "25,000.00", "1,12,500.00"],
    ["03/09/26", "AWS INDIA", "0000123458", "03/09/26", "2,345.67", "", "1,10,154.33"],
]


def _statement_pdf(closing_text: str | None = "1,10,154.33", blank_page: bool = True, opening_text: str | None = "1,00,000.00") -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4))
    styles = getSampleStyleSheet()
    tbl = Table([HDFC_HEADER, *HDFC_ROWS])
    tbl.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    story = [
        Paragraph("HDFC BANK LTD — Statement of account", styles["Title"]),
        Paragraph("Account No: XXXXXXXX1234 · Period: 01/09/2026 to 30/09/2026", styles["Normal"]),
        Spacer(1, 12),
        tbl,
        Spacer(1, 12),
    ]
    if opening_text:
        story.insert(2, Paragraph(f"Opening Balance: {opening_text}", styles["Normal"]))
    if closing_text:
        story.append(Paragraph(f"Closing Balance: {closing_text}", styles["Normal"]))
    if blank_page:
        from reportlab.platypus.flowables import Flowable

        class Box(Flowable):  # a drawn shape, no text layer — stands in for a scanned image page
            def wrap(self, *_):
                return 300, 200

            def draw(self):
                self.canv.setFillColor(colors.grey)
                self.canv.rect(0, 0, 300, 200, fill=1)

        story += [PageBreak(), Box()]
    doc.build(story)
    return buf.getvalue()


def test_pdf_statement_rows_and_sanity():
    p = parse_pdf(_statement_pdf())
    assert p.detected == "hdfc_pdf"
    assert p.detected_format == "HDFC Bank statement (PDF)"
    assert p.columns == HDFC_HEADER
    assert p.auto_mapped is True
    assert [r["Narration"] for r in p.rows] == [r[1] for r in HDFC_ROWS]
    assert p.row_meta == [{"_page": 1, "_line": 1}, {"_page": 1, "_line": 2}, {"_page": 1, "_line": 3}]
    canon = to_canonical(p.rows, p.mapping, p.detected, None)
    assert [c.amount for c in canon] == [Decimal("-12500.00"), Decimal("25000.00"), Decimal("-2345.67")]
    assert canon[0].date == date(2026, 9, 1)
    assert p.sanity == {"openingBalance": "100000.00", "sumOfTxns": "10154.33", "closingBalance": "110154.33",
                        "computedClosing": "110154.33", "ok": True}


def test_pdf_blank_page_gets_ocr_retry_warning():
    p = parse_pdf(_statement_pdf())
    assert len(p.warnings) == 1
    w = p.warnings[0]
    assert w["page"] == 2 and w["canRetryOcr"] is True
    assert "retry with OCR" in w["message"]


def test_pdf_sanity_mismatch_points_at_missing_page():
    p = parse_pdf(_statement_pdf(closing_text="1,35,154.33"))
    s = p.sanity
    assert s["ok"] is False
    assert s["closingBalance"] == "135154.33" and s["computedClosing"] == "110154.33"
    assert "₹25,000.00 lower" in s["explanation"]
    assert "page 2" in s["explanation"]


def test_pdf_sanity_prefers_statement_opening_text_over_derived():
    p = parse_pdf(_statement_pdf(opening_text="99,000.00", blank_page=False))
    assert p.sanity["openingBalance"] == "99000.00"
    assert p.sanity["computedClosing"] == "109154.33"
    assert p.sanity["ok"] is False
    assert "₹1,000.00 lower" in p.sanity["explanation"]
    assert "page" not in p.sanity["explanation"].split(".")[1]  # no missing pages -> generic cause


def test_pdf_sanity_derives_balances_from_rows_without_summary_text():
    p = parse_pdf(_statement_pdf(opening_text=None, closing_text=None, blank_page=False))
    assert p.sanity["openingBalance"] == "100000.00"  # 87,500 - (-12,500)
    assert p.sanity["closingBalance"] == "110154.33"  # last running balance
    assert p.sanity["ok"] is True


def test_pdf_without_blank_page_has_no_warnings():
    p = parse_pdf(_statement_pdf(blank_page=False))
    assert p.warnings == []
    assert p.sanity["ok"] is True


def test_pdf_garbage_raises_parse_error():
    with pytest.raises(ParseError):
        parse_pdf(b"%PDF-1.4 this is not really a pdf")
    with pytest.raises(ParseError):
        parse_pdf(b"hello")
