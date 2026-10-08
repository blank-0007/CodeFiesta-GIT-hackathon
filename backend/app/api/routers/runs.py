import asyncio
import json

from fastapi import Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routers import Router
from app.core.auth import User, current_user, require
from app.core.config import get_settings
from app.db.models import AuditRow, EventRow, RunRow
from app.db.session import SessionLocal, get_db
from app.jobs.runner import get_runner
from app.schemas import (
    ActivityResponse,
    BulkArchiveRequest,
    CreateRunRequest,
    FindingView,
    MatchPairView,
    RerunRequest,
    RerunResponse,
    Run,
    RunEvent,
    UnmatchedResponse,
)
from app.services import runs as run_svc
from app.services.audit import audit_user, to_entry
from app.services.pipeline import run_pipeline
from app.services.repo import get_run, load_run
from app.services.views import finding_view, matches_view, run_view, unmatched_view

router = Router(prefix="/runs", tags=["runs"])


def event_out(e: EventRow) -> RunEvent:
    return RunEvent(seq=e.seq, ts=e.ts, level=e.level, stage=e.stage, message=e.message)


@router.get("", response_model=list[Run])
def list_runs(db: Session = Depends(get_db)):
    runs = [run_view(load_run(db, r, lite=True)) for r in db.execute(select(RunRow)).scalars()]
    return sorted(runs, key=lambda r: r.created_at, reverse=True)


@router.post("", response_model=Run, status_code=201)
async def create_run(body: CreateRunRequest, request: Request, user: User = Depends(require("run.create"))):
    db = SessionLocal()
    try:
        run = run_svc.create_run_record(db, body.model_dump(by_alias=True, exclude_none=True), user.name, ip=user.ip)
        out = run_view(load_run(db, run.id))
    finally:
        db.close()
    if get_settings().inline_jobs:
        await run_pipeline(run.id)
        db = SessionLocal()
        try:
            out = run_view(load_run(db, run.id))
        finally:
            db.close()
    else:
        get_runner().submit(f"pipeline:{run.id}", lambda: run_pipeline(run.id))
    return out


@router.post("/bulk-archive")
def bulk_archive(body: BulkArchiveRequest, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = 0
    for rid in body.ids:
        r = db.get(RunRow, rid)
        if r:
            r.archived = True
            n += 1
    if n:
        audit_user(db, user, "run.archived", ",".join(body.ids)[:120], after={"ids": body.ids})
    db.commit()
    return {"archived": n}


@router.get("/{run_id}", response_model=Run)
def get_run_view(run_id: str, db: Session = Depends(get_db)):
    return run_view(load_run(db, run_id))


@router.get("/{run_id}/matches", response_model=list[MatchPairView])
def get_matches(run_id: str, db: Session = Depends(get_db)):
    return matches_view(load_run(db, run_id))


@router.get("/{run_id}/unmatched", response_model=UnmatchedResponse)
def get_unmatched(run_id: str, db: Session = Depends(get_db)):
    return unmatched_view(load_run(db, run_id))


@router.get("/{run_id}/findings", response_model=list[FindingView])
def get_findings(run_id: str, db: Session = Depends(get_db)):
    rd = load_run(db, run_id)
    return [finding_view(f, rd.txns[f.txn_id], rd.run.period) for f in rd.findings if f.txn_id in rd.txns]


@router.get("/{run_id}/activity", response_model=ActivityResponse)
def get_activity(run_id: str, db: Session = Depends(get_db)):
    get_run(db, run_id)
    events = db.execute(select(EventRow).where(EventRow.run_id == run_id).order_by(EventRow.seq)).scalars()
    audit = db.execute(select(AuditRow).where(AuditRow.run_id == run_id).order_by(AuditRow.seq.desc())).scalars()
    return ActivityResponse(events=[event_out(e) for e in events], audit=[to_entry(a) for a in audit])


@router.get("/{run_id}/events")
async def stream_events(run_id: str, request: Request):
    """SSE: replay past logs, stream new ones, re-send `stages` every ~2s, `done` when finished.
    Frames are `event: <name>\\ndata: <json>\\n\\n` (LF only). No auth header is sent by the client."""
    db = SessionLocal()
    try:
        get_run(db, run_id)
    finally:
        db.close()

    def snapshot(after_seq: int):
        s = SessionLocal()
        try:
            run = s.get(RunRow, run_id)
            evs = list(s.execute(select(EventRow).where(EventRow.run_id == run_id, EventRow.seq > after_seq).order_by(EventRow.seq)).scalars())
            return run.status, list(run.stages or []), [event_out(e).model_dump(mode="json") for e in evs]
        finally:
            s.close()

    def frame(name: str, data) -> bytes:
        return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'), ensure_ascii=False)}\n\n".encode()

    async def gen():
        last_seq = 0
        last_stages_at = 0.0
        last_stages = None
        loop = asyncio.get_running_loop()
        while True:
            if await request.is_disconnected():
                return
            status, stages, events = await asyncio.to_thread(snapshot, last_seq)
            for e in events:
                last_seq = max(last_seq, e["seq"])
                yield frame("log", e)
            now = loop.time()
            if stages != last_stages or now - last_stages_at >= 2.0:
                yield frame("stages", {"status": status, "stages": stages})
                last_stages, last_stages_at = stages, now
            if status not in ("queued", "running"):
                yield frame("done", {})
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@router.post("/{run_id}/rerun", response_model=RerunResponse)
def rerun(run_id: str, body: RerunRequest, user: User = Depends(require("run.rerun")), db: Session = Depends(get_db)):
    n, ids = run_svc.rerun(db, run_id, body, user)
    return RerunResponse(matches_gained=n, pair_ids=ids)


@router.post("/{run_id}/finalize", response_model=Run)
def finalize(run_id: str, user: User = Depends(require("run.finalize")), db: Session = Depends(get_db)):
    return run_svc.finalize(db, run_id, user)
