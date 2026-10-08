"""Uploads, reports, audit, settings, dashboard, search, samples, health."""

import base64
import json
from datetime import UTC, datetime, timedelta

from fastapi import Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routers import Router
from app.core.auth import User, current_user, forbidden, require
from app.core.config import get_settings
from app.core.errors import conflict, invalid, not_found
from app.db.models import AuditRow, FindingRow, ReportRow, RunRow, TxnRow, utcnow
from app.db.session import get_db
from app.schemas import AuditEntry, DashboardData, Report, ReportRequest, SearchResult, SettingsModel, UploadedFile
from app.services import actions
from app.services.audit import audit_user, to_entry, verify_chain
from app.services.repo import next_report_id, rand, settings_data
from app.services.uploads import create_upload, retry_ocr
from app.services.views import dashboard

router = Router(tags=["misc"])

DEFAULT_FORMAT = {"reconciled_ledger": "csv", "anomaly_report": "pdf", "audit_trail": "csv", "unresolved_items": "csv"}
TYPE_NAME = {"reconciled_ledger": "reconciled-ledger", "anomaly_report": "anomaly-report", "audit_trail": "audit-trail", "unresolved_items": "unresolved-items"}
SHARE_DAYS = 7


# ----------------------------------------------------------------------------- uploads
@router.post("/uploads", response_model=UploadedFile, status_code=201)
async def upload(file: UploadFile = File(...), kind: str = Form("bank"), accountId: str | None = Form(None), db: Session = Depends(get_db)):  # noqa: N803
    if kind not in ("bank", "ledger"):
        raise invalid("kind must be 'bank' or 'ledger'")
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise invalid("File too large (max 25 MB)")
    out, status = create_upload(db, data=data, name=file.filename or "upload", kind=kind, account_id=accountId or None)
    if status != 201:
        return JSONResponse(out.model_dump(by_alias=True, exclude_none=True, mode="json"), status_code=status)
    return out


@router.post("/uploads/{upload_id}/ocr", response_model=UploadedFile)
def ocr(upload_id: str, db: Session = Depends(get_db)):
    return retry_ocr(db, upload_id)


# ----------------------------------------------------------------------------- reports
def _report_out(r: ReportRow, with_content: bool) -> Report:
    base = get_settings().public_base_url.rstrip("/")
    return Report(id=r.id, run_id=r.run_id, run_period=r.run_period, type=r.type, format=r.format, name=r.name, size=r.size,
                  created_at=r.created_at, created_by=r.created_by, content=r.content if with_content else None,
                  share_url=f"{base}/s/{r.share_token}")


@router.get("/reports", response_model=list[Report])
def list_reports(db: Session = Depends(get_db)):
    rows = db.execute(select(ReportRow).order_by(ReportRow.created_at.desc())).scalars()
    return [_report_out(r, False) for r in rows]


@router.post("/reports", response_model=Report, status_code=201)
def create_report(body: ReportRequest, user: User = Depends(require("report.generate")), db: Session = Depends(get_db)):
    from app.reports.builder import build_report

    run = db.get(RunRow, body.run_id)
    if not run:
        raise not_found("Run")
    if run.status in ("running", "queued", "failed"):
        raise conflict("Reports can only be generated for runs that have finished.")
    fmt_ = body.format or DEFAULT_FORMAT[body.type]
    content, size = build_report(db, run.id, body.type, fmt_, body.include_ai_explanations, body.include_evidence, user.name)
    r = ReportRow(id=next_report_id(db), run_id=run.id, run_period=run.period, type=body.type, format=fmt_,
                  name=f"{TYPE_NAME[body.type]}-{run.period}.{fmt_}", size=size, created_at=utcnow(), created_by=user.name, content=content,
                  options={"includeAiExplanations": body.include_ai_explanations, "includeEvidence": body.include_evidence},
                  share_token=rand(10), share_expires_at=(datetime.now(UTC) + timedelta(days=SHARE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ"))
    db.add(r)
    db.flush()
    audit_user(db, user, "report.generated", r.id, after={"type": body.type, "format": fmt_, "includeAi": body.include_ai_explanations}, run_id=run.id)
    db.commit()
    return _report_out(r, True)


@router.get("/reports/{report_id}/download", response_model=Report)
def download_report(report_id: str, db: Session = Depends(get_db)):
    r = db.get(ReportRow, report_id)
    if not r:
        raise not_found("Report")
    return _report_out(r, True)


def share_view(token: str, db: Session) -> Response:
    """Public, expiring share link: GET /s/{token} serves the report file."""
    r = db.execute(select(ReportRow).where(ReportRow.share_token == token)).scalar_one_or_none()
    if not r:
        return HTMLResponse("<h1>Link not found</h1>", status_code=404)
    if r.share_expires_at < datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"):
        return HTMLResponse("<h1>This share link has expired</h1>", status_code=410)
    data = base64.b64decode(r.content) if r.format == "pdf" else (r.content or "").encode()
    mt = "application/pdf" if r.format == "pdf" else "text/csv; charset=utf-8"
    return Response(data, media_type=mt, headers={"Content-Disposition": f'inline; filename="{r.name}"'})


# ----------------------------------------------------------------------------- audit
@router.get("/audit", response_model=list[AuditEntry])
def audit(actor: str | None = None, q: str | None = None, from_: str | None = Query(None, alias="from"), to: str | None = None,
          runId: str | None = None, db: Session = Depends(get_db)):  # noqa: N803
    stmt = select(AuditRow).order_by(AuditRow.ts.desc(), AuditRow.seq.desc())
    if actor:
        stmt = stmt.where(AuditRow.actor_type.in_([a.strip() for a in actor.split(",") if a.strip()]))
    if runId:
        stmt = stmt.where(AuditRow.run_id == runId)
    if from_:
        stmt = stmt.where(AuditRow.ts >= from_)
    if to:
        stmt = stmt.where(AuditRow.ts <= (to if "T" in to else f"{to}T23:59:59.999Z"))
    rows = db.execute(stmt).scalars()
    needle = (q or "").strip().lower()
    out = []
    for a in rows:
        if needle and needle not in f"{a.action} {a.target} {a.actor_name} {a.run_id or ''} {json.dumps(a.after if a.after is not None else '', ensure_ascii=False)}".lower():
            continue
        out.append(to_entry(a))
    return out


@router.get("/audit/verify")
def audit_verify(db: Session = Depends(get_db)):
    ok, n = verify_chain(db)
    return {"ok": ok, "entries": n}


# ----------------------------------------------------------------------------- settings
@router.get("/settings", response_model=SettingsModel)
def get_settings_view(db: Session = Depends(get_db)):
    return SettingsModel.model_validate(settings_data(db))


@router.put("/settings", response_model=SettingsModel)
def put_settings(body: dict, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if "organization" in body and not user.can("settings.org"):
        raise forbidden(user.role, "settings.org")
    if "ai" in body and not user.can("settings.ai"):
        raise forbidden(user.role, "settings.ai")
    return actions.update_settings(db, body, user)


# ----------------------------------------------------------------------------- dashboard & search
@router.get("/dashboard", response_model=DashboardData)
def get_dashboard(db: Session = Depends(get_db)):
    return dashboard(db)


@router.get("/search", response_model=SearchResult)
def search(q: str = "", db: Session = Depends(get_db)):
    q = q.strip().lower()
    out = {"runs": [], "txns": [], "vendors": []}
    if len(q) < 2:
        return out
    like = f"%{q}%"
    runs = db.execute(select(RunRow).order_by(RunRow.created_at.desc())).scalars()
    out["runs"] = [{"id": r.id, "name": r.name, "period": r.period} for r in runs if q in f"{r.id} {r.name} {r.period}".lower()][:5]
    vendors: dict[str, int] = {}
    for (v,) in db.execute(select(TxnRow.vendor_norm).where(TxnRow.vendor_norm.ilike(like), TxnRow.external.is_(False))).all():
        vendors[v] = vendors.get(v, 0) + 1
    out["vendors"] = [{"name": n, "count": c} for n, c in sorted(vendors.items(), key=lambda x: -x[1])[:6]]
    rows = db.execute(select(TxnRow).where(TxnRow.external.is_(False), (TxnRow.id.ilike(like)) | (TxnRow.description_raw.ilike(like)))
                      .order_by(TxnRow.run_id.desc(), TxnRow.ord).limit(8)).scalars()
    cover: dict[tuple[str, str], str] = {}
    for f in db.execute(select(FindingRow.id, FindingRow.run_id, FindingRow.covered_txn_ids)).all():
        for t in f.covered_txn_ids or []:
            cover.setdefault((f.run_id, t), f.id)
    out["txns"] = [{"id": t.id, "runId": t.run_id, "description": t.description_raw, "amount": t.amount, "findingId": cover.get((t.run_id, t.id))} for t in rows]
    exact = db.execute(select(FindingRow).where(FindingRow.id.ilike(q))).scalars().first()
    if exact and not any(x["findingId"] == exact.id for x in out["txns"]):
        t = db.execute(select(TxnRow).where(TxnRow.run_id == exact.run_id, TxnRow.id == exact.txn_id)).scalar_one_or_none()
        if t:
            out["txns"].insert(0, {"id": t.id, "runId": t.run_id, "description": t.description_raw, "amount": t.amount, "findingId": exact.id})
    return SearchResult.model_validate(out)


# ----------------------------------------------------------------------------- samples & health
@router.get("/samples")
def samples():
    d = get_settings().data_dir / "samples"
    idx = d / "index.json"
    if idx.exists():
        return json.loads(idx.read_text())
    return [{"name": p.name, "kind": "ledger" if "tally" in p.name.lower() or "ledger" in p.name.lower() else "bank"} for p in sorted(d.glob("*")) if p.suffix in (".pdf", ".csv")] if d.exists() else []


@router.get("/samples/{name}")
def sample_file(name: str):
    d = (get_settings().data_dir / "samples").resolve()
    p = (d / name).resolve()
    if p.parent != d or not p.is_file():
        raise not_found("Sample file")
    return FileResponse(p, filename=name, media_type="application/pdf" if p.suffix == ".pdf" else "text/csv")


@router.get("/health")
def health(db: Session = Depends(get_db)):
    s = get_settings()
    n = db.query(RunRow).count()
    return {"status": "ok", "runs": n, "ai": "configured" if s.has_gemini_key else "offline", "authMode": s.auth_mode}
