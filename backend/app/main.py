"""ReconAI API — drop-in replacement for the frontend's MSW mock layer (all routes under /api)."""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routers import findings, misc, rules, runs
from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.db.init import init_db
from app.db.models import EventRow, RunRow, utcnow
from app.db.session import get_db, session_scope

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("reconai")


def _recover_interrupted_runs() -> None:
    """Runs left queued/running by a previous process can never finish — mark them failed."""
    with session_scope() as db:
        for r in db.execute(select(RunRow).where(RunRow.status.in_(["queued", "running"]))).scalars():
            r.status = "failed"
            r.error = "Server restarted while the run was in progress"
            r.stages = [{**s, "state": "failed"} if s.get("state") == "active" else s for s in (r.stages or [])]
            seq = max((e.seq for e in db.execute(select(EventRow).where(EventRow.run_id == r.id)).scalars()), default=0)
            db.add(EventRow(run_id=r.id, seq=seq + 1, ts=utcnow(), level="error", stage="Ingest", message=r.error))


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    _recover_interrupted_runs()
    s = get_settings()
    log.info("ReconAI API ready (auth=%s, ai=%s)", s.auth_mode, "configured" if s.has_gemini_key else "offline fallback")
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="ReconAI API", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    install_error_handlers(app)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Accept", "Content-Type", "X-Demo-Role", "Authorization"],
    )
    for r in (runs.router, findings.router, rules.router, misc.router):
        app.include_router(r, prefix="/api")

    @app.get("/s/{token}", include_in_schema=False)
    def share(token: str, db: Session = Depends(get_db)):
        return misc.share_view(token, db)

    return app


app = create_app()
