"""Database initialisation: schema (Alembic when available, else create_all) + reference data."""

import logging

from sqlalchemy import inspect

from app.db.models import Base
from app.db.session import engine, session_scope

log = logging.getLogger("reconai.db")


def init_db(use_alembic: bool = True) -> None:
    eng = engine()
    done = False
    if use_alembic:
        try:
            from pathlib import Path

            from alembic.config import Config

            from alembic import command

            ini = Path(__file__).resolve().parents[2] / "alembic.ini"
            if ini.exists() and (ini.parent / "alembic" / "versions").exists() and any((ini.parent / "alembic" / "versions").glob("*.py")):
                cfg = Config(str(ini))
                cfg.set_main_option("script_location", str(ini.parent / "alembic"))
                cfg.attributes["connection"] = None
                command.upgrade(cfg, "head")
                done = True
        except Exception as e:  # pragma: no cover - fall back to create_all
            log.warning("Alembic upgrade failed (%s); falling back to create_all", e)
    if not done or not inspect(eng).has_table("runs"):
        Base.metadata.create_all(eng)
    from app.services.bootstrap import ensure_reference_data

    with session_scope() as db:
        ensure_reference_data(db)
