from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine: Engine | None = None
_factory: sessionmaker[Session] | None = None


def _resolve_sqlite(url: str) -> str:
    """Relative SQLite paths (sqlite:///./reconai.db) resolve against backend/, not the process cwd."""
    import os
    import shutil
    from pathlib import Path
    from app.core.config import BACKEND_DIR

    prefix = "sqlite:///"
    path = url[len(prefix):]
    if url.startswith(prefix) and path and not path.startswith("/") and path != ":memory:":
        if os.environ.get("VERCEL"):
            tmp_db = Path("/tmp/reconai.db")
            seed_db = BACKEND_DIR / path
            if not tmp_db.exists() and seed_db.exists():
                try:
                    shutil.copyfile(seed_db, tmp_db)
                except Exception:
                    pass
            return f"sqlite:///{tmp_db}"
        return prefix + str((BACKEND_DIR / path).resolve())
    return url


def _make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        url = _resolve_sqlite(url)
        eng = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30}, future=True)

        @event.listens_for(eng, "connect")
        def _pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

        return eng
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return create_engine(url, pool_pre_ping=True, future=True)


def engine() -> Engine:
    global _engine, _factory
    if _engine is None:
        _engine = _make_engine(get_settings().database_url)
        _factory = sessionmaker(_engine, expire_on_commit=False, future=True)
    return _engine


def reset_engine() -> None:
    """Tests: drop the cached engine so a new DATABASE_URL takes effect."""
    global _engine, _factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _factory = None


def SessionLocal() -> Session:
    engine()
    assert _factory is not None
    return _factory()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
