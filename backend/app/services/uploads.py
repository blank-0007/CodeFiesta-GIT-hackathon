"""Upload persistence: raw file on disk + parsed rows in the DB, keyed by upload id ("up_xxxxxxx")."""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import ApiError, not_found
from app.db.models import UploadRow
from app.ingest.parsers import ParseError, mapping_complete, ocr_pages, parse_csv, parse_pdf, sanity_from_rows
from app.schemas import UploadedFile
from app.services.repo import rand, settings_data


def _guess_account(name: str, accounts: list[dict]) -> str | None:
    up = name.upper()
    for a in accounts:
        if a["bank"].split()[0].upper() in up or a["last4"] in up:
            return a["id"]
    return None


def _preview(rows: list[dict]) -> list[dict[str, str]]:
    return [{k: str(v) for k, v in r.items() if not k.startswith("_")} for r in rows[:20]]


def create_upload(db: Session, *, data: bytes, name: str, kind: str, account_id: str | None) -> tuple[UploadedFile, int]:
    uid = f"up_{rand(7)}"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[-120:] or "upload"
    path = get_settings().upload_dir / f"{uid}_{safe}"
    path.write_bytes(data)
    accounts = settings_data(db)["organization"]["accounts"]
    if kind == "bank" and not account_id:
        account_id = _guess_account(name, accounts)
    is_pdf = name.lower().endswith(".pdf") or data[:5] == b"%PDF-"
    is_csv = bool(re.search(r"\.(csv|txt)$", name, re.I))
    base = {"id": uid, "name": name, "size": len(data), "kind": kind, "accountId": account_id, "rowCount": 0, "columns": [],
            "autoMapped": False, "previewRows": [], "warnings": []}

    def fail(fmt_: str, label: str, msg: str) -> tuple[UploadedFile, int]:
        meta = {**base, "format": fmt_, "detectedFormat": label, "status": "error", "error": msg}
        db.add(UploadRow(id=uid, meta=meta, kind=kind, format=fmt_, detected="error", path=str(path)))
        db.commit()
        return UploadedFile.model_validate(meta), 422

    if not is_pdf and not is_csv:
        return fail("csv", "Unknown", "Unsupported file type. Upload a PDF statement or a CSV export.")
    try:
        parsed = parse_pdf(data) if is_pdf else parse_csv(data, kind)
    except ParseError as e:
        return fail("pdf" if is_pdf else "csv", "PDF" if is_pdf else "CSV", str(e))
    rows = [{**(parsed.row_meta[i] if i < len(parsed.row_meta) else {}), **r} for i, r in enumerate(parsed.rows)]
    if is_pdf and kind == "bank" and not account_id and parsed.detected == "hdfc_pdf":
        account_id = next((a["id"] for a in accounts if a["bank"].upper().startswith("HDFC")), None)
    status = "parsed" if parsed.auto_mapped else "needs_mapping"
    meta = {**base, "accountId": account_id, "format": "pdf" if is_pdf else "csv", "detectedFormat": parsed.detected_format, "status": status,
            "rowCount": len(rows), "columns": parsed.columns, "autoMapped": parsed.auto_mapped, "previewRows": _preview(rows),
            "warnings": parsed.warnings}
    if parsed.sanity and kind == "bank":
        meta["sanity"] = parsed.sanity
    db.add(UploadRow(id=uid, meta=meta, kind=kind, format=meta["format"], detected=parsed.detected, path=str(path), columns=parsed.columns,
                     rows=rows, mapping=parsed.mapping))
    db.commit()
    return UploadedFile.model_validate(meta), 201


def retry_ocr(db: Session, upload_id: str) -> UploadedFile:
    up = db.get(UploadRow, upload_id)
    if not up:
        raise not_found("Upload")
    meta = dict(up.meta)
    if up.format != "pdf":
        raise ApiError(422, "validation_error", "OCR is only available for PDF statements")
    pages = [w["page"] for w in meta.get("warnings", []) if w.get("canRetryOcr") and w.get("page")]
    if not pages:
        return UploadedFile.model_validate(meta)
    raw = Path(up.path).read_bytes()
    new_rows, new_meta, errors = ocr_pages(raw, pages, up.columns)
    ok_pages = {m["_page"] for m in new_meta}
    rows = list(up.rows) + [{**m, **r} for m, r in zip(new_meta, new_rows, strict=True)]
    rows.sort(key=lambda r: (r.get("_page", 0), r.get("_line", 0)))
    warnings = [w for w in meta.get("warnings", []) if w.get("page") not in ok_pages]
    failed = {int(re.search(r"Page (\d+)", e).group(1)): e for e in errors if re.search(r"Page (\d+)", e)}
    warnings = [{**w, "message": failed[w["page"]], "canRetryOcr": False} if w.get("page") in failed else w for w in warnings]
    for e in errors:
        if not re.search(r"Page (\d+)", e):
            warnings.append({"message": e, "canRetryOcr": False})
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    if meta.get("sanity") is not None or up.kind == "bank":
        s = sanity_from_rows(clean, up.mapping, up.detected, text=_pdf_text(raw), missing_pages=[w["page"] for w in warnings if w.get("page")])
        if s:
            meta["sanity"] = s
    meta.update(rowCount=len(rows), warnings=warnings, previewRows=_preview(rows),
                status="parsed" if mapping_complete(up.mapping) else meta["status"])
    up.rows = rows
    up.meta = meta
    db.commit()
    return UploadedFile.model_validate(meta)


def _pdf_text(raw: bytes) -> str:
    import io

    import pdfplumber

    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)
