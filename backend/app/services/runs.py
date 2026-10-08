"""Run lifecycle: create (queued) → pipeline job → awaiting_review → finalize; relaxed re-run; archive."""

from __future__ import annotations

import copy
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.auth import User
from app.core.errors import conflict, invalid
from app.core.money import D, fmt, inr
from app.db.models import EventRow, FindingRow, PairRow, RunRow, utcnow
from app.matching.engine import P5, Matcher, PassSpec, ref_match
from app.matching.rules import compile_rules
from app.matching.score import MTxn
from app.services.audit import add_audit, audit_user
from app.services.pipeline import STAGES, run_name
from app.services.repo import RunData, load_run, next_pair_seq, rand, settings_data, ym
from app.services.views import is_open, run_view, unexplained

DEFAULT_CONFIG = {
    "preset": "balanced",
    "dateToleranceDays": 3,
    "amountMode": "tolerance",
    "amountTolerance": "1.00",
    "vendorThreshold": 0.85,
    "referenceMatching": True,
    "multiPass": True,
    "passes": [
        {"name": "P1 · Exact", "dateToleranceDays": 0, "amountTolerance": "0.00", "vendorThreshold": 0.9, "confidence": 0.97},
        {"name": "P2 · Date ±3d", "dateToleranceDays": 3, "amountTolerance": "1.00", "vendorThreshold": 0.85, "confidence": 0.92},
        {"name": "P3 · Fuzzy vendor", "dateToleranceDays": 3, "amountTolerance": "1.00", "vendorThreshold": 0.55, "confidence": 0.8},
        {"name": "P4 · Group sum", "dateToleranceDays": 2, "amountTolerance": "0.00", "vendorThreshold": 0.8, "confidence": 0.9},
    ],
    "highValueThreshold": "500000.00",
    "approvalLimit": "50000.00",
    "detectors": {k: True for k in ("duplicate_detector", "approval_limit", "new_vendor", "weekend_payment", "high_value",
                                    "period_boundary", "amount_outlier", "round_amount", "no_counterpart")},
    "maskAccountNumbers": True,
}


def create_run_record(db: Session, body: dict, created_by: str, *, created_at: str | None = None, ip: str | None = None) -> RunRow:
    """body: CreateRunRequest wire dict (camelCase). Returns the queued RunRow (committed)."""
    period = body.get("period")
    accounts = body.get("accounts") or []
    if not period or not accounts:
        raise invalid("period and at least one account are required")
    try:
        datetime.strptime(period, "%Y-%m")
    except ValueError as e:
        raise invalid("period must be yyyy-MM") from e
    settings = settings_data(db)
    known = {a["id"] for a in settings["organization"]["accounts"]}
    bad = [a for a in accounts if a not in known]
    if bad:
        raise invalid(f"Unknown account(s): {', '.join(bad)}")
    config = copy.deepcopy(DEFAULT_CONFIG)
    config["highValueThreshold"] = settings["organization"]["highValueThreshold"]
    config["approvalLimit"] = settings["organization"]["approvalLimit"]
    config.update(copy.deepcopy(body.get("config") or {}))
    config["maskAccountNumbers"] = bool(body.get("maskAccountNumbers", True))
    for k in ("amountTolerance", "highValueThreshold", "approvalLimit"):
        if k in config:
            config[k] = fmt(config[k])
    rid = f"run_{period.replace('-', '_')}_{rand(4)}"
    run = RunRow(
        id=rid, name=(body.get("name") or "").strip() or run_name(period, accounts, settings), period=period, status="queued",
        accounts=accounts, config=config, stages=[{"name": n, "state": "pending"} for n in STAGES],
        file_ids=list(body.get("fileIds") or []), request=body, created_at=created_at or utcnow(), created_by=created_by,
    )
    db.add(run)
    db.flush()
    add_audit(db, actor_type="user", actor_name=created_by, action="run.created", target=rid,
              after={"period": period, "accounts": accounts, "files": run.file_ids}, run_id=rid, ip=ip, ts=run.created_at)
    db.add(EventRow(run_id=rid, seq=1, ts=run.created_at, level="info", stage="Ingest", message=f"Run queued with {len(run.file_ids)} file(s)"))
    db.commit()
    return run


def _mtxn(t) -> MTxn:
    from datetime import date

    from app.normalize.vendors import channel_of

    return MTxn(t.id, t.source, date.fromisoformat(t.date), D(t.amount), t.vendor_norm, t.description_raw, t.reference, t.account_id,
                channel_of(t.description_raw) if t.source == "bank" else None)


def rerun(db: Session, run_id: str, body, user: User) -> tuple[int, list[str]]:
    rd = load_run(db, run_id)
    if rd.run.status in ("queued", "running", "failed"):
        raise conflict("Re-run is only available once the run has finished")
    if rd.run.status == "completed":
        raise conflict("Run is finalized")
    matched = rd.matched_ids()
    bank = [_mtxn(rd.txns[i]) for i in rd.bank_ids if i not in matched]
    ledger = [_mtxn(rd.txns[i]) for i in rd.ledger_ids if i not in matched]
    settings = settings_data(db)
    from sqlalchemy import select

    from app.db.models import RuleRow

    compiled = compile_rules(list(db.execute(select(RuleRow)).scalars()), rd.run.config, settings["organization"]["accounts"])
    # Same rule as the pipeline: confine matching to one account when every ledger row names its bank account.
    ledger_rows = [rd.txns[i] for i in rd.ledger_ids]
    compiled.ruleset.same_account = bool(ledger_rows) and all((t.raw_row or {}).get("Ledger") for t in ledger_rows)
    m = Matcher(bank, ledger, compiled.ruleset)
    m.run_pass(PassSpec(P5, int(body.date_tolerance_days), D(body.amount_tolerance), float(body.vendor_threshold), "relaxed"))
    prefix = f"M-{ym(rd.run.period)}-"
    seq = next_pair_seq(db, prefix)
    gained: list[str] = []
    order = max((p.ord for p in rd.pairs), default=0)
    now = utcnow()
    new_ids: set[str] = set()
    for p in m.pairs:
        seq += 1
        order += 1
        pid = f"{prefix}{seq:04d}"
        diff = sum((t.amount for t in p.bank), D(0)) - sum((t.amount for t in p.ledger), D(0))
        note = f"Matched with relaxed tolerance (±{body.date_tolerance_days}d, ₹{fmt(body.amount_tolerance)}); difference {inr(diff)}"
        db.add(PairRow(id=pid, run_id=run_id, bank_txn_ids=[t.id for t in p.bank], ledger_txn_ids=[t.id for t in p.ledger], score=p.score,
                       pass_name=P5 if p.pass_name != "P2 · Date ±3d" else p.pass_name, breakdown=p.breakdown, status="auto", note=p.note or note,
                       created_at=now, ord=order))
        gained.append(pid)
        new_ids.update(t.id for t in p.bank + p.ledger)
    for f in rd.findings:
        if is_open(f.status) and new_ids & set(f.covered_txn_ids or []):
            f.prev_status = f.status
            f.status = "auto_resolved"
            f.updated_at = now
            add_audit(db, actor_type="system", actor_name="matcher", action="finding.auto_resolved", target=f.id,
                      before={"status": f.prev_status}, after={"status": "auto_resolved", "via": "relaxed re-run"}, run_id=run_id)
    from sqlalchemy import func

    last = db.scalar(select(func.max(EventRow.seq)).where(EventRow.run_id == run_id)) or 0
    db.add(EventRow(run_id=run_id, seq=last + 1, ts=now, level="info", stage="Match P5",
                    message=f"Relaxed re-run (±{body.date_tolerance_days}d, ₹{fmt(body.amount_tolerance)}, vendor ≥ {round(body.vendor_threshold * 100)}%) on unmatched items: {len(gained)} new matches"))
    audit_user(db, user, "run.rerun", run_id, after={"dateToleranceDays": body.date_tolerance_days, "amountTolerance": fmt(body.amount_tolerance),
                                                     "vendorThreshold": body.vendor_threshold, "matchesGained": len(gained)}, run_id=run_id)
    db.commit()
    return len(gained), gained


def finalize(db: Session, run_id: str, user: User):
    rd = load_run(db, run_id)
    if rd.run.status in ("queued", "running", "failed"):
        raise conflict("Only finished runs can be finalized")
    n_open = sum(1 for f in rd.findings if is_open(f.status))
    if n_open:
        raise conflict(f"{n_open} findings are still unresolved")
    view = run_view(rd)
    u = unexplained(view)
    if u != 0:
        raise conflict(f"Unexplained difference of {inr(u)} remains — re-open rejected items or match them before finalizing")
    before = rd.run.status
    rd.run.status = "completed"
    audit_user(db, user, "run.finalized", run_id, before={"status": before}, after={"status": "completed"}, run_id=run_id)
    db.commit()
    return run_view(load_run(db, run_id))


def manual_pair_score(bank, ledger):
    from app.matching.score import score_pair

    return score_pair(bank, ledger, None)


def approve_all_for_seed(db: Session, rd: RunData, who: str, ts: str | None = None) -> None:
    """Seeding helper: resolve every open finding as a reviewer would, then finalize."""
    for f in rd.findings:
        if is_open(f.status):
            f.prev_status = f.status
            f.status = "approved"
            f.updated_at = ts or utcnow()
            add_audit(db, actor_type="user", actor_name=who, action="finding.approve", target=f.id, before={"status": "open"},
                      after={"status": "approved", "category": f.category}, run_id=rd.run.id, ts=ts)


__all__ = ["create_run_record", "rerun", "finalize", "DEFAULT_CONFIG", "ref_match", "FindingRow", "UTC"]
