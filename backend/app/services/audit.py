"""Append-only audit log with a SHA-256 hash chain (each entry hashes the previous entry's hash)."""

import hashlib
import json
import threading
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import User
from app.db.models import AuditRow, utcnow
from app.schemas import AuditEntry

GENESIS = "0" * 64
_lock = threading.Lock()


def _canonical(e: dict[str, Any]) -> str:
    return json.dumps(e, sort_keys=True, separators=(",", ":"), default=str)


def add_audit(
    db: Session,
    *,
    actor_type: str,
    actor_name: str,
    action: str,
    target: str,
    before: Any = None,
    after: Any = None,
    run_id: str | None = None,
    model_version: str | None = None,
    ip: str | None = None,
    ts: str | None = None,
) -> AuditRow:
    with _lock:
        db.flush()
        last = db.execute(select(AuditRow.seq, AuditRow.hash).order_by(AuditRow.seq.desc()).limit(1)).first()
        n = (last.seq if last else 0) + 1
        prev = last.hash if last else GENESIS
        row = AuditRow(
            id=f"A-{n:05d}",
            ts=ts or utcnow(),
            actor_type=actor_type,
            actor_name=actor_name,
            action=action,
            target=target,
            before=before,
            after=after,
            run_id=run_id,
            model_version=model_version,
            ip=ip,
            prev_hash=prev,
        )
        row.hash = hashlib.sha256((prev + _canonical(_payload(row))).encode()).hexdigest()
        db.add(row)
        db.flush()
        return row


def audit_user(db: Session, user: User, action: str, target: str, **kw: Any) -> AuditRow:
    return add_audit(db, actor_type="user", actor_name=user.name, action=action, target=target, ip=user.ip, **kw)


def _payload(r: AuditRow) -> dict[str, Any]:
    return {
        "id": r.id, "ts": r.ts, "actor": [r.actor_type, r.actor_name], "action": r.action, "target": r.target,
        "before": r.before, "after": r.after, "runId": r.run_id, "modelVersion": r.model_version, "ip": r.ip,
    }


def verify_chain(db: Session) -> tuple[bool, int]:
    """Recompute the chain; returns (ok, entries checked)."""
    prev = GENESIS
    n = 0
    for r in db.execute(select(AuditRow).order_by(AuditRow.seq)).scalars():
        if r.prev_hash != prev or hashlib.sha256((prev + _canonical(_payload(r))).encode()).hexdigest() != r.hash:
            return False, n
        prev = r.hash
        n += 1
    return True, n


def to_entry(r: AuditRow) -> AuditEntry:
    return AuditEntry(
        id=r.id, ts=r.ts, actor={"type": r.actor_type, "name": r.actor_name}, action=r.action, target=r.target,
        before=r.before, after=r.after, run_id=r.run_id, model_version=r.model_version, ip=r.ip,
    )


def count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(AuditRow)) or 0
