"""Read models. Every derived number is recomputed from the records on every read (mirrors mocks/db.ts)."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import ZERO, D
from app.db.models import AuditRow, CommentRow, FindingRow, RunRow, TxnRow
from app.normalize.fuzzy import js_round, vendor_similarity
from app.schemas import (
    CATEGORIES,
    AgentStep,
    Comment,
    DashboardData,
    EvidenceItem,
    FindingDetail,
    FindingView,
    Impact,
    MatchPairView,
    ModelRef,
    ReviewItem,
    ReviewProgress,
    Run,
    RunStage,
    RunStats,
    ScoreBreakdown,
    Signal,
    Txn,
    UnmatchedItem,
    UnmatchedResponse,
    VendorHistoryPoint,
)
from app.services.audit import to_entry
from app.services.repo import RunData, load_run

RESOLVED_EXPLAINED = {"approved", "auto_resolved"}
OPEN = {"open", "in_review", "escalated"}


def is_open(status: str) -> bool:
    return status in OPEN


def _d(s: str) -> date:
    return date.fromisoformat(s)


def txn_out(t: TxnRow) -> Txn:
    return Txn(
        id=t.id, source=t.source, date=t.date, amount=D(t.amount), description_raw=t.description_raw,
        vendor_norm=t.vendor_norm, reference=t.reference, account_id=t.account_id, gl_code=t.gl_code,
        source_file=t.source_file, source_page=t.source_page, raw_row=t.raw_row or {},
    )


# ----------------------------------------------------------------------------- run
def contribution(rd: RunData, f: FindingRow, matched: set[str] | None = None) -> Decimal:
    matched = rd.matched_ids() if matched is None else matched
    c = ZERO
    for tid in f.covered_txn_ids or []:
        if tid in matched:
            continue
        t = rd.txns.get(tid)
        if not t:
            continue
        c = c + D(t.amount) if t.source == "bank" else c - D(t.amount)
    return c


def run_view(rd: RunData) -> Run:
    r = rd.run
    matched = rd.matched_ids()
    bank_total = sum((D(rd.txns[i].amount) for i in rd.bank_ids), ZERO)
    ledger_total = sum((D(rd.txns[i].amount) for i in rd.ledger_ids), ZERO)
    tol = ZERO
    auto_bank = 0
    for p in rd.pairs:
        b = sum((D(rd.txns[i].amount) for i in p.bank_txn_ids if i in rd.txns), ZERO)
        lsum = sum((D(rd.txns[i].amount) for i in p.ledger_txn_ids if i in rd.txns), ZERO)
        tol += b - lsum
        if p.status == "auto" and p.score >= 0.9:
            auto_bank += len(p.bank_txn_ids)
    explained = tol
    for f in rd.findings:
        if f.status in RESOLVED_EXPLAINED:
            explained += contribution(rd, f, matched)
    cats = {c: 0 for c in CATEGORIES}
    for f in rd.findings:
        cats[f.human_category or f.category] = cats.get(f.human_category or f.category, 0) + 1
    human = [f for f in rd.findings if f.routing == "human_review"]
    resolved = sum(1 for f in human if f.status in ("approved", "rejected"))
    n_bank = len(rd.bank_ids)
    return Run(
        id=r.id, name=r.name, period=r.period, status=r.status, accounts=list(r.accounts or []),
        stats=RunStats(
            bank_count=n_bank, ledger_count=len(rd.ledger_ids), matched=len(rd.pairs),
            unmatched_bank=sum(1 for i in rd.bank_ids if i not in matched),
            unmatched_ledger=sum(1 for i in rd.ledger_ids if i not in matched),
            anomalies=len(rd.findings),
            auto_match_rate=js_round(auto_bank / n_bank, 3) if n_bank else 0,
            bank_total=bank_total, ledger_total=ledger_total, explained=explained,
        ),
        config=dict(r.config or {}), stages=[RunStage(**s) for s in (r.stages or [])], created_at=r.created_at,
        created_by=r.created_by, duration_ms=r.duration_ms, review=ReviewProgress(resolved=resolved, total=len(human)),
        category_counts=cats, archived=True if r.archived else None, tolerance_diff=tol,
    )


def unexplained(run: Run) -> Decimal:
    return run.stats.bank_total - run.stats.ledger_total - run.stats.explained


def matches_view(rd: RunData) -> list[MatchPairView]:
    out = []
    for p in rd.pairs:
        bank = [rd.txns[i] for i in p.bank_txn_ids if i in rd.txns]
        ledger = [rd.txns[i] for i in p.ledger_txn_ids if i in rd.txns]
        if not bank or not ledger:
            continue
        out.append(MatchPairView(
            id=p.id, bank_txn_ids=p.bank_txn_ids, ledger_txn_ids=p.ledger_txn_ids, score=p.score, pass_name=p.pass_name,
            breakdown=ScoreBreakdown(**p.breakdown), status=p.status, note=p.note, created_by=p.created_by,
            bank=[txn_out(t) for t in bank], ledger=[txn_out(t) for t in ledger],
            date_diff_days=(_d(bank[0].date) - _d(ledger[0].date)).days,
            vendor_similarity=js_round(p.breakdown["vendor"] / 0.25, 2),
            amount_diff=sum((D(t.amount) for t in bank), ZERO) - sum((D(t.amount) for t in ledger), ZERO),
        ))
    return out


def _signals(f: FindingRow, txn_id: str | None = None) -> list[Signal]:
    return [Signal(**{**s, "txnId": txn_id or s.get("txnId") or f.txn_id}) for s in (f.signals or [])]


def unmatched_view(rd: RunData) -> UnmatchedResponse:
    matched = rd.matched_ids()
    first: dict[str, FindingRow] = {}
    for f in rd.findings:
        for tid in f.covered_txn_ids or []:
            first.setdefault(tid, f)

    def item(t: TxnRow) -> UnmatchedItem:
        f = first.get(t.id)
        return UnmatchedItem(
            txn=txn_out(t), signals=_signals(f, t.id) if f else [], risk_score=f.risk_score if f else 0.1,
            finding_id=f.id if f else None, category=(f.human_category or f.category) if f else None,
        )

    return UnmatchedResponse(
        bank=[item(rd.txns[i]) for i in rd.bank_ids if i not in matched],
        ledger=[item(rd.txns[i]) for i in rd.ledger_ids if i not in matched],
    )


def finding_view(f: FindingRow, txn: TxnRow, period: str) -> FindingView:
    return FindingView(
        id=f.id, run_id=f.run_id, txn_id=f.txn_id, category=f.category, risk_score=f.risk_score, signals=_signals(f),
        explanation=f.explanation, evidence_txn_ids=list(f.evidence_txn_ids or []), suggested_action=f.suggested_action,
        confidence=f.confidence, routing=f.routing, routing_reason=f.routing_reason, status=f.status,
        agent_trace=[AgentStep(**s) for s in (f.agent_trace or [])], model=ModelRef(name=f.model_name, version=f.model_version),
        assignee=f.assignee, created_at=f.created_at, updated_at=f.updated_at, human_category=f.human_category,
        false_positive=f.false_positive, txn=txn_out(txn), run_period=period,
    )


def _evidence_sim(t: TxnRow, o: TxnRow) -> float:
    a, b = abs(D(t.amount)), abs(D(o.amount))
    amount_sim = 0.0 if a == 0 else max(0.0, 1 - float(((a - b).copy_abs() / a).quantize(Decimal("0.0001"), ROUND_HALF_UP)))
    date_sim = max(0.0, 1 - abs((_d(t.date) - _d(o.date)).days) * 0.1)
    return js_round(0.5 * amount_sim + 0.2 * date_sim + 0.3 * vendor_similarity(t.vendor_norm, o.vendor_norm), 2)


def evidence_for(rd: RunData, f: FindingRow) -> list[EvidenceItem]:
    t = rd.txns[f.txn_id]
    out: list[EvidenceItem] = []
    seen = {t.id}
    for eid in f.evidence_txn_ids or []:
        o = rd.txn_of(eid)
        if not o or eid in seen:
            continue
        seen.add(eid)
        ext = eid in rd.external
        rel = "period_boundary" if ext else ("duplicate" if f.category == "duplicate" and o.source == t.source else "candidate")
        out.append(EvidenceItem(txn=txn_out(o), relation=rel, similarity=_evidence_sim(t, o),
                                note=("Next-period entry (outside this run)" if _d(o.date) > _d(t.date) else "Entry outside this run") if ext else None))
    matched = rd.matched_ids()
    other_ids = rd.ledger_ids if t.source == "bank" else rd.bank_ids
    cands = [(rd.txns[i], _evidence_sim(t, rd.txns[i])) for i in other_ids if i not in matched and i not in seen]
    cands = [c for c in cands if c[1] >= 0.5]
    cands.sort(key=lambda x: -x[1])
    for o, s in cands[:3]:
        seen.add(o.id)
        out.append(EvidenceItem(txn=txn_out(o), relation="candidate", similarity=s))
    n = 0
    for o in rd.txns.values():
        if n >= 3:
            break
        if o.source == t.source and o.vendor_norm == t.vendor_norm and o.id not in seen:
            out.append(EvidenceItem(txn=txn_out(o), relation="vendor_history", similarity=_evidence_sim(t, o)))
            n += 1
    return out


def vendor_history(db: Session, f: FindingRow, t: TxnRow) -> list[VendorHistoryPoint]:
    rows = db.execute(
        select(TxnRow.id, TxnRow.run_id, TxnRow.date, TxnRow.amount)
        .join(RunRow, RunRow.id == TxnRow.run_id)
        .where(TxnRow.source == t.source, TxnRow.vendor_norm == t.vendor_norm, TxnRow.external.is_(False), RunRow.status != "failed")
    ).all()
    hist = sorted(rows, key=lambda r: (r.date, r.id))[-14:]
    return [VendorHistoryPoint(date=r.date, amount=D(r.amount), txn_id=r.id if (r.id == f.txn_id and r.run_id == f.run_id) else None) for r in hist]


def comments_for(db: Session, finding_id: str) -> list[Comment]:
    rows = db.execute(select(CommentRow).where(CommentRow.finding_id == finding_id).order_by(CommentRow.created_at, CommentRow.id)).scalars()
    return [Comment(id=c.id, author=c.author, body=c.body, created_at=c.created_at, mentions=c.mentions or []) for c in rows]


def finding_detail(db: Session, rd: RunData, f: FindingRow) -> FindingDetail:
    run = run_view(rd)
    t = rd.txns[f.txn_id]
    fv = finding_view(f, t, rd.run.period)
    hist = db.execute(select(AuditRow).where(AuditRow.target == f.id).order_by(AuditRow.ts, AuditRow.seq)).scalars()
    return FindingDetail(
        **fv.model_dump(),
        evidence=evidence_for(rd, f),
        vendor_history=vendor_history(db, f, t),
        comments=comments_for(db, f.id),
        history=[to_entry(a) for a in hist],
        impact=Impact(contribution=contribution(rd, f), unexplained_before=unexplained(run)),
    )


def locate_finding(db: Session, finding_id: str) -> tuple[RunData, FindingRow] | None:
    f = db.get(FindingRow, finding_id)
    if not f:
        return None
    rd = load_run(db, f.run_id)
    f2 = next(x for x in rd.findings if x.id == finding_id)
    return rd, f2


# ----------------------------------------------------------------------------- queue / dashboard
def priority(risk: float, amount: Decimal) -> float:
    a = abs(int(D(amount).quantize(Decimal("1"), ROUND_HALF_UP)))
    return risk * math.log10(max(10, a))


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _findings_with_txns(db: Session, where) -> list[tuple[FindingRow, TxnRow, str]]:
    fs = list(db.execute(select(FindingRow).join(RunRow, RunRow.id == FindingRow.run_id).where(where)).scalars())
    if not fs:
        return []
    keys = {(f.run_id, f.txn_id) for f in fs}
    run_ids = {k[0] for k in keys}
    txns = {(t.run_id, t.id): t for t in db.execute(select(TxnRow).where(TxnRow.run_id.in_(run_ids), TxnRow.id.in_({k[1] for k in keys}))).scalars()}
    periods = dict(db.execute(select(RunRow.id, RunRow.period).where(RunRow.id.in_(run_ids))).all())
    return [(f, txns[(f.run_id, f.txn_id)], periods[f.run_id]) for f in fs if (f.run_id, f.txn_id) in txns]


def review_queue(db: Session) -> list[ReviewItem]:
    now = datetime.now(UTC)
    out = []
    for f, t, period in _findings_with_txns(db, FindingRow.routing == "human_review"):
        out.append(ReviewItem(
            finding=finding_view(f, t, period),
            priority=js_round(priority(f.risk_score, D(t.amount)), 2),
            routing_reason=f.routing_reason or "Unknown category",
            waiting_days=max(0, math.floor((now - _parse_ts(f.created_at)).total_seconds() / 86400)),
        ))
    out.sort(key=lambda x: -x.priority)
    return out


def dashboard(db: Session) -> DashboardData:
    now = datetime.now(UTC)
    runs = list(db.execute(select(RunRow)).scalars())
    views = []
    for r in runs:
        views.append((r, run_view(load_run(db, r, lite=True))))
    ok = [(r, v) for r, v in views if v.status not in ("failed", "running", "queued")]
    ok.sort(key=lambda x: (x[1].period, x[1].created_at))
    by_period: dict[str, Run] = {}
    for _, v in ok:
        by_period[v.period] = v
    series = list(by_period.values())[-12:]
    open_rows = _findings_with_txns(db, FindingRow.status.in_(OPEN))
    attention = sorted(open_rows, key=lambda x: -priority(x[0].risk_score, D(x[1].amount)))[:5]
    unrec = sum((abs(unexplained(v)) for _, v in ok if v.status == "awaiting_review"), ZERO)
    hours = [(v.stats.matched * 1.2) / 60 for v in series]
    return DashboardData(
        runs_this_month=sum(1 for r in runs if (c := _parse_ts(r.created_at)).year == now.year and c.month == now.month),
        auto_match_rate=series[-1].stats.auto_match_rate if series else 0,
        open_anomalies=len(open_rows),
        pending_reviews=sum(1 for f, _, _ in open_rows if f.routing == "human_review"),
        unreconciled_amount=unrec,
        avg_hours_saved=js_round(sum(hours) / len(hours), 1) if hours else 0,
        trend=[{"period": v.period, "auto_match_rate": v.stats.auto_match_rate} for v in series],
        anomalies_by_month=[{"period": v.period, **v.category_counts} for v in series],
        attention=[finding_view(f, t, p) for f, t, p in attention],
    )


def stage_list(names: list[str]) -> list[dict]:
    return [{"name": n, "state": "pending"} for n in names]


def group_by(xs, key):
    d = defaultdict(list)
    for x in xs:
        d[key(x)].append(x)
    return d
