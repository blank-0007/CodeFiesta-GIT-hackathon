"""Mutations: finding decisions, comments, manual matches, rules, detectors, settings."""

from __future__ import annotations

import re
from copy import deepcopy

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import ESCALATION_USER, User
from app.core.errors import conflict, invalid, not_found
from app.core.money import ZERO, D, fmt
from app.db.models import (
    CommentRow,
    DetectorRow,
    FindingRow,
    PairRow,
    ProposedRuleRow,
    RuleRow,
    RuleVersionRow,
    RunRow,
    SettingsRow,
    TxnRow,
    utcnow,
)
from app.matching.score import score_pair
from app.schemas import (
    Comment,
    Detector,
    DetectorTestResponse,
    MatchPair,
    ModelRef,
    ProposedRule,
    Rule,
    ScoreBreakdown,
    SettingsModel,
    Simulation,
)
from app.services.audit import audit_user
from app.services.repo import load_run, next_pair_seq, next_rule_id, rand, settings_data, ym
from app.services.views import finding_detail, is_open, locate_finding, txn_out

MENTION = re.compile(r"@([A-Z][a-z]+ [A-Z][a-z]+)")


# ----------------------------------------------------------------------------- comments
def add_comment(db: Session, finding_id: str, author: str, body: str) -> CommentRow:
    c = CommentRow(id=f"c{rand(8)}", finding_id=finding_id, author=author, body=body, created_at=utcnow(), mentions=MENTION.findall(body))
    db.add(c)
    db.flush()
    return c


def comment_out(c: CommentRow) -> Comment:
    return Comment(id=c.id, author=c.author, body=c.body, created_at=c.created_at, mentions=c.mentions or [])


# ----------------------------------------------------------------------------- decisions
def _high_value_threshold(db: Session, run_config: dict):
    v = (run_config or {}).get("highValueThreshold")
    return D(v) if v else D(settings_data(db)["organization"]["highValueThreshold"])


def decide(db: Session, finding_id: str, body, user: User):
    loc = locate_finding(db, finding_id)
    if not loc:
        raise not_found("Finding")
    rd, f = loc
    txn = rd.txns[f.txn_id]
    high_value = abs(D(txn.amount)) >= _high_value_threshold(db, rd.run.config)
    reason = (body.reason or "").strip()
    needs_notes = (f.category == "potential_fraud" or high_value) and body.action in ("approve", "change_category", "false_positive")
    if (body.action == "reject" or needs_notes) and len(reason) < 5:
        raise invalid("A reason is required to reject." if body.action == "reject" else "Resolution notes are required for potential fraud and high-value items.")
    if body.action == "change_category" and not body.category:
        raise invalid("category is required")
    if rd.run.status == "completed" and body.action != "reopen":
        raise conflict("Run is finalized")
    before = {"status": f.status, "category": f.human_category or f.category}
    prev = f.prev_status
    f.prev_status = f.status
    a = body.action
    if a == "approve":
        f.status = "approved"
    elif a == "change_category":
        f.human_category = body.category
        f.status = "approved"
    elif a == "reject":
        f.status = "rejected"
    elif a == "escalate":
        f.status = "escalated"
        f.assignee = ESCALATION_USER
    elif a == "false_positive":
        f.status = "approved"
        f.false_positive = True
    elif a == "reopen":
        if rd.run.status == "completed":
            raise conflict("Run is finalized")
        f.status = prev if prev and prev != f.status else "open"
        f.false_positive = False
        f.human_category = None
    f.updated_at = utcnow()
    if body.comment and body.comment.strip():
        add_comment(db, f.id, user.name, body.comment.strip())
    if reason and a != "reopen":
        add_comment(db, f.id, user.name, f"[{a.replace('_', ' ', 1)}] {reason}")
    audit_user(db, user, "finding.undo" if a == "reopen" else f"finding.{a}", f.id, before=before,
               after={"status": f.status, "category": f.human_category or f.category, "reason": body.reason}, run_id=rd.run.id)
    db.commit()
    return finding_detail(db, load_run(db, rd.run.id), db.get(FindingRow, f.id))


def bulk_approve(db: Session, ids: list[str], user: User) -> int:
    done = 0
    for fid in ids:
        f = db.get(FindingRow, fid)
        if not f or not is_open(f.status) or f.category == "potential_fraud":
            continue
        run_cfg = (db.get(RunRow, f.run_id).config or {})
        txn = db.execute(select(TxnRow).where(TxnRow.run_id == f.run_id, TxnRow.id == f.txn_id)).scalar_one_or_none()
        if txn is not None and abs(D(txn.amount)) >= _high_value_threshold(db, run_cfg):
            continue  # high-value items need individual resolution notes
        before = f.status
        f.prev_status = f.status
        f.status = "approved"
        f.updated_at = utcnow()
        audit_user(db, user, "finding.approve", fid, before={"status": before}, after={"status": "approved", "bulk": True}, run_id=f.run_id)
        done += 1
    db.commit()
    return done


# ----------------------------------------------------------------------------- matches
def manual_match(db: Session, body, user: User) -> MatchPair:
    rd = load_run(db, body.run_id)
    note = (body.note or "").strip()
    if len(note) < 5:
        raise invalid("A note of at least 5 characters is required for manual matches.")
    if not body.bank_txn_ids or not body.ledger_txn_ids:
        raise invalid("Select at least one bank and one ledger transaction.")
    if rd.run.status == "completed":
        raise conflict("Run is finalized")
    matched = rd.matched_ids()
    already = [i for i in body.bank_txn_ids + body.ledger_txn_ids if i in matched]
    if already:
        raise conflict(f"Already matched: {', '.join(already)}")
    bank = [rd.txns.get(i) for i in body.bank_txn_ids]
    ledger = [rd.txns.get(i) for i in body.ledger_txn_ids]
    if any(t is None for t in bank + ledger):
        raise not_found("Transaction")
    if any(t.source != "bank" for t in bank) or any(t.source != "ledger" for t in ledger):
        raise invalid("bankTxnIds must be bank transactions and ledgerTxnIds ledger transactions")
    from app.services.runs import _mtxn

    breakdown, score = score_pair([_mtxn(t) for t in bank], [_mtxn(t) for t in ledger], None)
    prefix = f"M-{ym(rd.run.period)}-"
    pid = f"{prefix}{next_pair_seq(db, prefix) + 1:04d}"
    pair = PairRow(id=pid, run_id=rd.run.id, bank_txn_ids=body.bank_txn_ids, ledger_txn_ids=body.ledger_txn_ids, score=score,
                   pass_name="Manual", breakdown=breakdown, status="manual", note=note, created_by=user.name,
                   ord=max((p.ord for p in rd.pairs), default=0) + 1)
    db.add(pair)
    ids = set(body.bank_txn_ids) | set(body.ledger_txn_ids)
    for f in rd.findings:
        if is_open(f.status) and ids & set(f.covered_txn_ids or []):
            f.prev_status = f.status
            f.status = "approved"
            f.updated_at = utcnow()
            add_comment(db, f.id, user.name, f"Resolved by manual match {pid}: {note}")
    audit_user(db, user, "match.manual", pid, after={"bank": body.bank_txn_ids, "ledger": body.ledger_txn_ids, "note": note}, run_id=rd.run.id)
    db.commit()
    return MatchPair(id=pid, bank_txn_ids=pair.bank_txn_ids, ledger_txn_ids=pair.ledger_txn_ids, score=score, pass_name="Manual",
                     breakdown=ScoreBreakdown(**breakdown), status="manual", note=note, created_by=user.name)


def unmatch(db: Session, pair_id: str, body, user: User) -> None:
    reason = (body.reason or "").strip()
    if len(reason) < 5:
        raise invalid("A reason is required to unmatch.")
    rd = load_run(db, body.run_id)
    if rd.run.status == "completed":
        raise conflict("Run is finalized")
    p = next((x for x in rd.pairs if x.id == pair_id), None)
    if not p:
        raise not_found("Match")
    before = {"bank": p.bank_txn_ids, "ledger": p.ledger_txn_ids, "score": p.score}
    db.delete(p)
    audit_user(db, user, "match.unmatched", pair_id, before=before, after={"reason": reason}, run_id=rd.run.id)
    db.commit()


# ----------------------------------------------------------------------------- rules
def rule_out(r: RuleRow) -> Rule:
    return Rule(id=r.id, name=r.name, description=r.description, scope=r.scope, scope_value=r.scope_value, params=r.params or {},
                enabled=r.enabled, created_by=r.created_by, hit_count=r.hit_count or 0, last_triggered=r.last_triggered, version=r.version)


def proposed_out(db: Session, p: ProposedRuleRow, txn_cache: dict | None = None) -> ProposedRule:
    ids = list(p.supporting_txn_ids or [])
    rows = list(db.execute(select(TxnRow).where(TxnRow.run_id == p.run_id, TxnRow.id.in_(ids[:12]))).scalars()) if ids else []
    order = {i: n for n, i in enumerate(ids)}
    rows.sort(key=lambda t: order.get(t.id, 0))
    return ProposedRule(id=p.id, run_id=p.run_id, title=p.title, description=p.description, scope=p.scope, params=p.params or {},
                        supporting_txn_ids=ids, supporting_txns=[txn_out(t) for t in rows[:6]], simulation=Simulation(**p.simulation),
                        confidence=p.confidence, status=p.status, model=ModelRef(name=p.model_name, version=p.model_version))


def decide_rule(db: Session, pid: str, body, user: User) -> ProposedRule:
    pr = db.get(ProposedRuleRow, pid)
    if not pr:
        raise not_found("Proposed rule")
    if pr.status != "proposed":
        raise conflict(f"Rule proposal is already {pr.status}")
    if body.action == "reject":
        if not body.reason or len(body.reason.strip()) < 5:
            raise invalid("A reason is required to reject a rule.")
        pr.status = "rejected"
    else:
        pr.status = "approved"
        params = body.params if body.action == "edit_approve" and body.params else pr.params
        scope_vendor = pr.scope.startswith("vendor")
        rule = RuleRow(id=next_rule_id(db), name=pr.title, description=pr.description, scope="vendor" if scope_vendor else "global",
                       scope_value=pr.scope.split(": ", 1)[1] if ": " in pr.scope else None, params=params, enabled=True,
                       created_by={"type": "ai", "name": pr.model_name}, hit_count=0, version=1, proposed_rule_id=pr.id)
        if rule.scope == "vendor" and not rule.scope_value:
            rule.scope_value = params.get("canonical") or params.get("vendor")
        db.add(rule)
        db.flush()
        db.add(RuleVersionRow(id=f"v{rand(10)}", rule_id=rule.id, version=1, changed_by=user.name, changed_at=utcnow(),
                              before=pr.params if body.action == "edit_approve" else None, after=params,
                              note="AI proposal edited and approved" if body.action == "edit_approve" else "AI proposal approved"))
    audit_user(db, user, "rule.rejected" if body.action == "reject" else "rule.approved", pr.id, before={"status": "proposed", "params": pr.params},
               after={"status": pr.status, "params": body.params or pr.params, "reason": body.reason}, run_id=pr.run_id)
    db.commit()
    return proposed_out(db, pr)


def update_rule(db: Session, rid: str, body, user: User) -> Rule:
    r = db.get(RuleRow, rid)
    if not r:
        raise not_found("Rule")
    before = {"enabled": r.enabled, "params": deepcopy(r.params)}
    if body.enabled is not None:
        r.enabled = body.enabled
    if body.params is not None:
        r.params = body.params
    r.version = (r.version or 1) + 1
    after = {"enabled": r.enabled, "params": r.params}
    note = "Disabled" if body.enabled is False else "Enabled" if body.enabled else "Parameters updated"
    if body.params is not None and body.enabled is not None:
        note = "Parameters updated"
    db.add(RuleVersionRow(id=f"v{rand(10)}", rule_id=r.id, version=r.version, changed_by=user.name, changed_at=utcnow(), before=before, after=after, note=note))
    audit_user(db, user, "rule.updated", r.id, before=before, after=after)
    db.commit()
    return rule_out(r)


# ----------------------------------------------------------------------------- detectors
def detector_out(d: DetectorRow) -> Detector:
    return Detector(id=d.id, name=d.name, description=d.description, example=d.example, enabled=d.enabled, threshold=d.threshold, weight=d.weight)


def update_detector(db: Session, did: str, body, user: User) -> Detector:
    d = db.get(DetectorRow, did)
    if not d:
        raise not_found("Detector")
    before = {"enabled": d.enabled, "threshold": d.threshold, "weight": d.weight}
    for k in ("enabled", "threshold", "weight"):
        v = getattr(body, k)
        if v is not None:
            setattr(d, k, v)
    audit_user(db, user, "detector.updated", d.id, before=before, after={"enabled": d.enabled, "threshold": d.threshold, "weight": d.weight})
    db.commit()
    return detector_out(d)


def test_detector(db: Session, did: str, body) -> DetectorTestResponse:
    """Real dry run: re-evaluate this detector on the run's current unmatched items with the proposed
    settings and recompute category/routing deterministically. Nothing is persisted."""
    from datetime import date

    from app.agent.fallback import prior_category
    from app.detect.detectors import DetectContext, DetectorCfg, Sig, month_bounds, run_detectors
    from app.services.pipeline import route
    from app.services.runs import _mtxn

    d = db.get(DetectorRow, did)
    if not d:
        raise not_found("Detector")
    rd = load_run(db, body.run_id)
    matched = rd.matched_ids()
    txns = {i: _mtxn(t) for i, t in rd.txns.items()}
    unmatched = {i for i in txns if i not in matched}
    start, end = month_bounds(rd.run.period)
    cfg = {x.id: DetectorCfg(x.id, x.enabled, x.threshold, x.weight) for x in db.execute(select(DetectorRow)).scalars()}
    cfg.setdefault("amount_mismatch", DetectorCfg("amount_mismatch", True, 0.05, 1.0))
    hist_rows = db.execute(
        select(TxnRow.source, TxnRow.vendor_norm, TxnRow.date, TxnRow.amount)
        .join(RunRow, RunRow.id == TxnRow.run_id)
        .where(TxnRow.external.is_(False), TxnRow.run_id != rd.run.id)
    ).all()
    history: dict = {}
    first: dict = {}
    known: set[str] = set()
    for side, vendor, dd, a in hist_rows:
        dt = date.fromisoformat(dd)
        if dt < start:
            history.setdefault((side, vendor), []).append((dt, D(a)))
            first[vendor] = min(first.get(vendor, dt), dt)
            if side == "ledger":
                known.add(vendor)
    for t in txns.values():
        if t.source == "ledger":
            known.add(t.vendor)
            first[t.vendor] = min(first.get(t.vendor, t.date), t.date)
    ext = [_mtxn(t) for t in rd.external.values()]
    hv = _high_value_threshold(db, rd.run.config)
    al = D(rd.run.config.get("approvalLimit") or settings_data(db)["organization"]["approvalLimit"])

    def ctx_with(c: DetectorCfg) -> DetectContext:
        cc = dict(cfg)
        cc[did] = c
        return DetectContext(start, end, txns, unmatched, ext, history, known, first, al, hv, cc, dict(rd.run.config.get("detectors") or {}))

    now_ctx = ctx_with(cfg[did])
    new_ctx = ctx_with(DetectorCfg(did, body.enabled, body.threshold, body.weight))
    flagged_now: set[str] = set()
    flagged_after: dict[str, Sig] = {}
    routed_delta = 0
    for tid in unmatched:
        t = txns[tid]
        s_now = run_detectors(t, now_ctx)
        s_new = run_detectors(t, new_ctx)
        if any(s.detector == did for s in s_now):
            flagged_now.add(tid)
        hit = next((s for s in s_new if s.detector == did), None)
        if hit:
            flagged_after[tid] = hit
        r_now = route(prior_category(s_now), 0.9, t.amount, hv)[0]
        r_new = route(prior_category(s_new), 0.9, t.amount, hv)[0]
        if r_now != r_new:
            routed_delta += 1 if r_new == "human_review" else -1
    by_txn = {}
    for f in rd.findings:
        for tid in f.covered_txn_ids or []:
            by_txn.setdefault(tid, f.id)
    newly = [t for t in flagged_after if t not in flagged_now]
    cleared = [t for t in flagged_now if t not in flagged_after]
    sample_ids = (newly + [t for t in flagged_after if t not in newly])[:3]
    return DetectorTestResponse(
        flagged_now=len(flagged_now), flagged_after=len(flagged_after), newly_flagged=len(newly), cleared=len(cleared),
        routed_to_review_delta=routed_delta,
        sample=[{"id": by_txn.get(t, t), "text": flagged_after[t].text} for t in sample_ids]
        or [{"id": by_txn.get(t, t), "text": f"Would no longer be flagged ({t})"} for t in cleared[:3]],
    )


# ----------------------------------------------------------------------------- settings
def update_settings(db: Session, body: dict, user: User) -> SettingsModel:
    row = db.get(SettingsRow, 1)
    before = deepcopy(row.data)
    data = deepcopy(row.data)
    for section in ("organization", "ai", "notifications"):
        if isinstance(body.get(section), dict):
            data[section] = {**data[section], **body[section]}
    for k in ("approvalLimit", "highValueThreshold"):
        data["organization"][k] = fmt(data["organization"][k])
    data["ai"]["estCostPerRun"] = fmt(data["ai"]["estCostPerRun"])
    validated = SettingsModel.model_validate(data)  # 422 on bad shapes
    row.data = validated.model_dump(by_alias=True, mode="json")
    section = next((k for k in body if k in ("organization", "ai", "notifications")), "settings")
    audit_user(db, user, "settings.updated", section, before=before.get(section), after=row.data.get(section))
    db.commit()
    return validated


def comment_count(db: Session, finding_id: str) -> int:
    return db.scalar(select(func.count()).select_from(CommentRow).where(CommentRow.finding_id == finding_id)) or 0


__all__ = ["ZERO"]
