"""Report generation (CSV + PDF). CSV columns mirror buildReport() in src/api/mocks/handlers.ts exactly."""

from __future__ import annotations

import base64
import io
import json
import math
import re
from datetime import UTC, datetime
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import D, fmt, inr
from app.db.models import AuditRow
from app.normalize.fuzzy import js_round
from app.schemas import FindingView, Run
from app.services.repo import RunData, load_run
from app.services.views import finding_view, is_open, matches_view, run_view, unexplained, unmatched_view

REPORT_TYPES = ("reconciled_ledger", "anomaly_report", "audit_trail", "unresolved_items")
FORMATS = ("csv", "pdf")

LEDGER_COLUMNS = [
    "match_id", "pass", "confidence", "status", "bank_ids", "bank_date", "bank_description", "bank_amount",
    "ledger_ids", "ledger_date", "ledger_vendor", "gl_code", "ledger_amount", "difference",
]
AUDIT_COLUMNS = ["id", "timestamp", "actor_type", "actor", "action", "target", "before", "after", "model_version", "ip"]
FINDING_COLUMNS = ["finding_id", "txn_id", "date", "description", "amount", "category", "risk", "ai_confidence", "status", "assignee"]
FINDING_AI_COLUMNS = ["ai_explanation", "suggested_action", "model"]
FINDING_EVIDENCE_COLUMNS = ["evidence_ids", "signals"]

TITLES = {
    "reconciled_ledger": "Reconciled Ledger",
    "anomaly_report": "Anomaly Investigation Report",
    "audit_trail": "Audit Trail",
    "unresolved_items": "Unresolved Items",
}


# ----------------------------------------------------------------------------- JS-compatible primitives
def js_num(x: float | int) -> str:
    """String(number) as JS prints it for the ranges we use (1.0 -> "1", 0.95 -> "0.95")."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Infinity" if x > 0 else "-Infinity"
        if x.is_integer():
            return str(int(x))
        return repr(x)
    return str(x)


def _jsify(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return int(v) if v.is_integer() else v
    if isinstance(v, dict):
        return {str(k): _jsify(x) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_jsify(x) for x in v]
    return v


def js_json(v: Any) -> str:
    """JSON.stringify(v ?? "")."""
    return json.dumps(_jsify("" if v is None else v), ensure_ascii=False, separators=(",", ":"), default=str)


_NEEDS_QUOTE = re.compile(r'[",\n]')


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, int | float):
        return js_num(v)
    return str(v)


def _esc(v: Any) -> str:
    s = _cell(v)
    return '"' + s.replace('"', '""') + '"' if _NEEDS_QUOTE.search(s) else s


def to_csv(rows: list[dict[str, Any]]) -> str:
    """Port of the mock's csv(): header from the first row's keys, quote only on [",\\n]."""
    if not rows:
        return ""
    h = list(rows[0].keys())
    return "\n".join([",".join(h), *(",".join(_esc(r.get(k)) for k in h) for r in rows)])


# ----------------------------------------------------------------------------- row builders
def ledger_rows(rd: RunData) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in matches_view(rd):
        rows.append({
            "match_id": p.id,
            "pass": p.pass_name,
            "confidence": p.score,
            "status": p.status,
            "bank_ids": " ".join(p.bank_txn_ids),
            "bank_date": p.bank[0].date,
            "bank_description": p.bank[0].description_raw,
            "bank_amount": fmt(sum((t.amount for t in p.bank), D(0))),
            "ledger_ids": " ".join(p.ledger_txn_ids),
            "ledger_date": p.ledger[0].date,
            "ledger_vendor": p.ledger[0].vendor_norm,
            "gl_code": p.ledger[0].gl_code or "",
            "ledger_amount": fmt(sum((t.amount for t in p.ledger), D(0))),
            "difference": fmt(p.amount_diff),
        })
    um = unmatched_view(rd)
    for side in (um.bank, um.ledger):
        for u in side:
            t = u.txn
            bank, ledger = t.source == "bank", t.source == "ledger"
            rows.append({
                "match_id": "",
                "pass": "UNMATCHED",
                "confidence": "",
                "status": u.category or "unclassified",
                "bank_ids": t.id if bank else "",
                "bank_date": t.date if bank else "",
                "bank_description": t.description_raw if bank else "",
                "bank_amount": fmt(t.amount) if bank else "",
                "ledger_ids": t.id if ledger else "",
                "ledger_date": t.date if ledger else "",
                "ledger_vendor": t.vendor_norm if ledger else "",
                "gl_code": t.gl_code or "",
                "ledger_amount": fmt(t.amount) if ledger else "",
                "difference": "",
            })
    return rows


def audit_rows(db: Session, run_id: str) -> list[dict[str, Any]]:
    q = select(AuditRow).where(AuditRow.run_id == run_id).order_by(AuditRow.ts.desc(), AuditRow.seq.desc())
    return [
        {
            "id": a.id, "timestamp": a.ts, "actor_type": a.actor_type, "actor": a.actor_name, "action": a.action,
            "target": a.target, "before": js_json(a.before), "after": js_json(a.after),
            "model_version": a.model_version or "", "ip": a.ip or "",
        }
        for a in db.execute(q).scalars()
    ]


def findings_views(rd: RunData) -> list[FindingView]:
    out = []
    for f in rd.findings:
        t = rd.txn_of(f.txn_id)
        if t is not None:
            out.append(finding_view(f, t, rd.run.period))
    return out


def finding_columns(include_ai: bool, include_evidence: bool) -> list[str]:
    return FINDING_COLUMNS + (FINDING_AI_COLUMNS if include_ai else []) + (FINDING_EVIDENCE_COLUMNS if include_evidence else [])


def finding_rows(findings: list[FindingView], include_ai: bool, include_evidence: bool) -> list[dict[str, Any]]:
    rows = []
    for f in findings:
        r: dict[str, Any] = {
            "finding_id": f.id, "txn_id": f.txn_id, "date": f.txn.date, "description": f.txn.description_raw,
            "amount": fmt(f.txn.amount), "category": f.human_category or f.category, "risk": f.risk_score,
            "ai_confidence": f.confidence, "status": f.status, "assignee": f.assignee or "",
        }
        if include_ai:
            r |= {"ai_explanation": f.explanation, "suggested_action": f.suggested_action, "model": f"{f.model.name}@{f.model.version}"}
        if include_evidence:
            r |= {"evidence_ids": " ".join(f.evidence_txn_ids), "signals": " | ".join(s.human_text for s in f.signals)}
        rows.append(r)
    return rows


def _table_data(db: Session, rd: RunData, type: str, include_ai: bool, include_evidence: bool) -> tuple[list[str], list[dict[str, Any]]]:
    if type == "reconciled_ledger":
        return LEDGER_COLUMNS, ledger_rows(rd)
    if type == "audit_trail":
        return AUDIT_COLUMNS, audit_rows(db, rd.run.id)
    findings = findings_views(rd)
    if type == "unresolved_items":
        findings = [f for f in findings if is_open(f.status)]
    return finding_columns(include_ai, include_evidence), finding_rows(findings, include_ai, include_evidence)


# ----------------------------------------------------------------------------- PDF helpers
INK = colors.HexColor("#0f172a")
BRAND = colors.HexColor("#4338ca")
MUTED = colors.HexColor("#64748b")
ZEBRA = colors.HexColor("#f1f5f9")
GRID = colors.HexColor("#cbd5e1")
HEAD_BG = colors.HexColor("#1e293b")

FONT, BOLD, ITALIC = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"


def _plain(s: Any) -> str:
    """Base-14 fonts lack the rupee glyph."""
    return _cell(s).replace("₹", "Rs ")


def _p(s: Any) -> str:
    return _xml_escape(_plain(s))


def _rs(x: Any) -> str:
    d = D(x)
    return f"{'-' if d < 0 else ''}Rs {inr(d)[1:]}"


def _pct(x: float) -> int:
    return int(js_round(x * 100, 0))


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=base["Title"], fontName=BOLD, fontSize=20, leading=25, textColor=INK, alignment=0, spaceAfter=4),
        "sub": ParagraphStyle("s", parent=base["Normal"], fontName=BOLD, fontSize=12, leading=16, textColor=BRAND),
        "meta": ParagraphStyle("m", parent=base["Normal"], fontName=FONT, fontSize=9, leading=12, textColor=MUTED),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName=BOLD, fontSize=13, leading=17, textColor=INK, spaceBefore=10, spaceAfter=6),
        "body": ParagraphStyle("b", parent=base["Normal"], fontName=FONT, fontSize=9, leading=12, textColor=INK),
        "small": ParagraphStyle("sm", parent=base["Normal"], fontName=FONT, fontSize=8.5, leading=11, textColor=INK),
        "bullet": ParagraphStyle("bl", parent=base["Normal"], fontName=FONT, fontSize=8.5, leading=11, textColor=INK, leftIndent=12, bulletIndent=3),
        "note": ParagraphStyle("n", parent=base["Normal"], fontName=ITALIC, fontSize=9, leading=12, textColor=MUTED),
        "right": ParagraphStyle("r", parent=base["Normal"], fontName=FONT, fontSize=9, leading=12, alignment=TA_RIGHT),
    }


def _decorator(title: str, run: Run, generated: str, generated_by: str):
    def draw(canvas, doc):
        w, h = doc.pagesize
        canvas.saveState()
        canvas.setFillColor(HEAD_BG)
        canvas.rect(0, h - 26, w, 26, stroke=0, fill=1)
        canvas.setFillColor(BRAND)
        canvas.rect(0, h - 29, w, 3, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont(BOLD, 11)
        canvas.drawString(doc.leftMargin, h - 17, "ReconAI")
        canvas.setFont(FONT, 9)
        canvas.drawRightString(w - doc.rightMargin, h - 17, _plain(f"{title} - {run.name}")[:110])
        canvas.setStrokeColor(GRID)
        canvas.line(doc.leftMargin, 22, w - doc.rightMargin, 22)
        canvas.setFillColor(MUTED)
        canvas.setFont(FONT, 7.5)
        canvas.drawString(doc.leftMargin, 12, _plain(f"Run {run.id} ({run.period}) | Generated {generated} by {generated_by}")[:150])
        canvas.drawRightString(w - doc.rightMargin, 12, f"Page {doc.page}")
        canvas.restoreState()

    return draw


def _kv_table(rows: list[tuple[str, str]], width: float) -> Table:
    t = Table([[k, v] for k, v in rows], colWidths=[width * 0.55, width * 0.45], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), FONT), ("FONTNAME", (1, 0), (1, -1), BOLD), ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, ZEBRA]),
        ("LINEABOVE", (0, 0), (-1, 0), 1.2, BRAND), ("LINEBELOW", (0, -1), (-1, -1), 0.6, GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _grid_table(data: list[list[Any]], col_widths: list[float], font_size: float = 9, numeric_cols: tuple[int, ...] = ()) -> Table:
    t = Table(data, colWidths=col_widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("FONTNAME", (0, 0), (-1, 0), BOLD), ("FONTNAME", (0, 1), (-1, -1), FONT), ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("LEADING", (0, 0), (-1, -1), font_size + 2),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
        ("LINEBELOW", (0, -1), (-1, -1), 0.6, GRID), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    for c in numeric_cols:
        style.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
    t.setStyle(TableStyle(style))
    return t


def _truncate(s: str, width: float, font: str, size: float) -> str:
    if stringWidth(s, font, size) <= width:
        return s
    ell = "..."
    lo, hi = 0, len(s)
    while lo < hi:  # longest prefix that fits with the ellipsis
        mid = (lo + hi + 1) // 2
        if stringWidth(s[:mid] + ell, font, size) <= width:
            lo = mid
        else:
            hi = mid - 1
    return s[:lo] + ell


def _summary_rows(run: Run) -> list[tuple[str, str]]:
    s = run.stats
    return [
        ("Bank total", _rs(s.bank_total)),
        ("Ledger total", _rs(s.ledger_total)),
        ("Difference", _rs(s.bank_total - s.ledger_total)),
        ("Explained", _rs(s.explained)),
        ("Unexplained", _rs(unexplained(run))),
        ("Auto-match rate", f"{s.auto_match_rate * 100:.1f}%"),
        ("Matched pairs", str(s.matched)),
        ("Anomalies", str(s.anomalies)),
    ]


def _cover(st, run: Run, title: str, generated: str, generated_by: str, width: float, extra: list[str]) -> list:
    out: list = [
        Spacer(1, 6 * mm),
        Paragraph(_p(f"ReconAI — {title}"), st["title"]),
        Paragraph(_p(run.name), st["sub"]),
        Paragraph(_p(f"Period {run.period} | Run {run.id} | Status {run.status}"), st["meta"]),
        Paragraph(_p(f"Generated {generated} by {generated_by}"), st["meta"]),
    ]
    for e in extra:
        out.append(Paragraph(_p(e), st["meta"]))
    out += [Spacer(1, 6 * mm), Paragraph("Totals", st["h2"]), _kv_table(_summary_rows(run), min(width, 110 * mm))]
    return out


def _render(pagesize, title: str, run: Run, generated: str, generated_by: str, story: list) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=pagesize, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=18 * mm, bottomMargin=14 * mm,
        title=f"ReconAI — {title}", author=_plain(generated_by), subject=_plain(run.name), creator="ReconAI",
    )
    deco = _decorator(title, run, generated, generated_by)
    doc.build(story, onFirstPage=deco, onLaterPages=deco)
    return buf.getvalue()


def _options_line(include_ai: bool, include_evidence: bool) -> str:
    return f"AI explanations: {'included' if include_ai else 'excluded'} | Evidence: {'included' if include_evidence else 'excluded'}"


def anomaly_pdf(rd: RunData, include_ai: bool, include_evidence: bool, generated_by: str, generated: str) -> bytes:
    run = run_view(rd)
    st = _styles()
    pagesize = A4
    width = pagesize[0] - 28 * mm
    title = TITLES["anomaly_report"]
    story = _cover(st, run, title, generated, generated_by, width, [_options_line(include_ai, include_evidence)])

    cat_rows = [["Category", "Count"]] + [[k.replace("_", " ").capitalize(), str(v)] for k, v in run.category_counts.items()]
    story += [Paragraph("Anomalies by category", st["h2"]), _grid_table(cat_rows, [70 * mm, 40 * mm], 9.5, (1,)), Spacer(1, 8 * mm),
              Paragraph(_p("Deterministic code decides what is true. The AI explains why. Humans decide anything risky."), st["note"]),
              PageBreak(), Paragraph("Detailed findings", st["h2"])]

    findings = sorted(findings_views(rd), key=lambda f: -f.risk_score)
    if not findings:
        story.append(Paragraph("No findings in this run.", st["body"]))
    for f in findings:
        risk = _pct(f.risk_score)
        accent = colors.HexColor("#dc2626") if risk >= 70 else colors.HexColor("#d97706") if risk >= 40 else colors.HexColor("#16a34a")
        head = Table(
            [[f.id, (f.human_category or f.category).replace("_", " ").upper(), f"Risk {risk}", f"Status {f.status.replace('_', ' ')}"]],
            colWidths=[width * 0.22, width * 0.30, width * 0.18, width * 0.30],
        )
        head.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), BOLD), ("FONTSIZE", (0, 0), (-1, -1), 9), ("TEXTCOLOR", (0, 0), (-1, -1), INK),
            ("TEXTCOLOR", (2, 0), (2, 0), accent), ("BACKGROUND", (0, 0), (-1, -1), ZEBRA),
            ("LINEBEFORE", (0, 0), (0, 0), 3, accent), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        block: list = [head, Spacer(1, 2),
                       Paragraph(f"<b>{_p(f.txn.date)}</b> &nbsp; {_p(f.txn.id)} &nbsp; {_p(f.txn.description_raw)} &nbsp; <b>{_p(_rs(f.txn.amount))}</b>", st["small"])]
        if include_ai:
            block.append(Paragraph(
                f"<b>AI explanation</b> <font color='#64748b'>({_pct(f.confidence)}% confidence, {_p(f.model.name)}@{_p(f.model.version)})</font>: "
                f"{_p(f.explanation) or '<i>none</i>'}", st["small"]))
            block.append(Paragraph(f"<b>Suggested action:</b> {_p(f.suggested_action) or '<i>none</i>'}", st["small"]))
        if include_evidence:
            if f.signals:
                block.append(Paragraph("<b>Signals</b>", st["small"]))
                block += [Paragraph(_p(s.human_text), st["bullet"], bulletText="•") for s in f.signals]
            block.append(Paragraph(f"<b>Evidence:</b> {_p(', '.join(f.evidence_txn_ids)) or '<i>none</i>'}", st["small"]))
        block.append(Spacer(1, 7))
        story.append(KeepTogether(block))
    return _render(pagesize, title, run, generated, generated_by, story)


def table_pdf(db: Session, rd: RunData, type: str, include_ai: bool, include_evidence: bool, generated_by: str, generated: str) -> bytes:
    run = run_view(rd)
    st = _styles()
    pagesize = landscape(A4)
    width = pagesize[0] - 28 * mm
    title = TITLES[type]
    headers, rows = _table_data(db, rd, type, include_ai, include_evidence)
    extra = [f"Rows: {len(rows)}"]
    if type in ("unresolved_items", "anomaly_report"):
        extra.append(_options_line(include_ai, include_evidence))
    story = _cover(st, run, title, generated, generated_by, width, extra)
    story += [PageBreak(), Paragraph(_p(title), st["h2"])]

    size = 7.0 if len(headers) <= 10 else 6.2
    cells = [[_plain(r.get(h)).replace("\n", " ") for h in headers] for r in rows]
    # Natural column widths (sampled), capped, then scaled to fill the page width.
    sample = cells[:500]
    natural = []
    for i, h in enumerate(headers):
        w = max([stringWidth(h, BOLD, size)] + [stringWidth(c[i], FONT, size) for c in sample]) + 7
        natural.append(min(max(w, 22.0), 190.0))
    scale = width / sum(natural)
    widths = [w * scale for w in natural]
    data: list[list[str]] = [[_truncate(h, w - 6, BOLD, size) for h, w in zip(headers, widths, strict=True)]]
    for c in cells:
        data.append([_truncate(v, w - 6, FONT, size) for v, w in zip(c, widths, strict=True)])
    if not rows:
        story.append(Paragraph("No rows for this report.", st["body"]))
    numeric = tuple(i for i, h in enumerate(headers) if h in {"bank_amount", "ledger_amount", "difference", "amount", "confidence", "risk", "ai_confidence"})
    # Chunk into moderate tables so layout stays linear for long reports.
    chunk = 60
    for start in range(0, max(len(data) - 1, 0), chunk):
        story.append(_grid_table([data[0], *data[1 + start:1 + start + chunk]], widths, size, numeric))
    return _render(pagesize, title, run, generated, generated_by, story)


# ----------------------------------------------------------------------------- entry point
def build_report(
    db: Session, run_id: str, type: str, format: str, include_ai: bool, include_evidence: bool, generated_by: str
) -> tuple[str, int]:
    """Returns (content, size). CSV -> plain text content, size=len(content).
    PDF -> base64-encoded PDF bytes as content, size=len(raw pdf bytes)."""
    if type not in REPORT_TYPES:
        raise ValueError(f"Unknown report type: {type}")
    if format not in FORMATS:
        raise ValueError(f"Unknown report format: {format}")
    rd = load_run(db, run_id)
    if format == "csv":
        _, rows = _table_data(db, rd, type, include_ai, include_evidence)
        c = to_csv(rows)
        return c, len(c)
    generated = datetime.now(UTC).strftime("%d %b %Y %H:%M UTC")
    if type == "anomaly_report":
        pdf = anomaly_pdf(rd, include_ai, include_evidence, generated_by, generated)
    else:
        pdf = table_pdf(db, rd, type, include_ai, include_evidence, generated_by, generated)
    return base64.b64encode(pdf).decode("ascii"), len(pdf)
