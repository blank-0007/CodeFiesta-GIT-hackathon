"""SQLAlchemy 2 models. Money is stored as a 2-dp decimal string (portable across SQLite/Postgres, never float)."""

from datetime import UTC, datetime

from sqlalchemy import DDL, JSON, Boolean, Float, ForeignKey, Index, Integer, String, Text, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Base(DeclarativeBase):
    type_annotation_map = {dict: JSON, list: JSON}


class RunRow(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    period: Mapped[str] = mapped_column(String(7), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    accounts: Mapped[list] = mapped_column(JSON, default=list)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    stages: Mapped[list] = mapped_column(JSON, default=list)
    file_ids: Mapped[list] = mapped_column(JSON, default=list)
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)
    created_by: Mapped[str] = mapped_column(String(120))
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_usage: Mapped[dict] = mapped_column(JSON, default=dict)


class TxnRow(Base):
    __tablename__ = "txns"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(8))
    date: Mapped[str] = mapped_column(String(10))
    amount: Mapped[str] = mapped_column(String(24))
    description_raw: Mapped[str] = mapped_column(Text)
    vendor_norm: Mapped[str] = mapped_column(String(200), index=True)
    reference: Mapped[str | None] = mapped_column(String(80), nullable=True)
    account_id: Mapped[str] = mapped_column(String(40))
    gl_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    source_file: Mapped[str | None] = mapped_column(String(200), nullable=True)
    source_page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, default=dict)
    # Rows dated outside the run period (e.g. first days of next month) — evidence only, not in totals.
    external: Mapped[bool] = mapped_column(Boolean, default=False)
    ord: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (Index("ix_txns_run_txn", "run_id", "id", unique=True),)


class PairRow(Base):
    __tablename__ = "match_pairs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    bank_txn_ids: Mapped[list] = mapped_column(JSON)
    ledger_txn_ids: Mapped[list] = mapped_column(JSON)
    score: Mapped[float] = mapped_column(Float)
    pass_name: Mapped[str] = mapped_column(String(40))
    breakdown: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="auto")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)
    ord: Mapped[int] = mapped_column(Integer, default=0)


class FindingRow(Base):
    __tablename__ = "findings"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    txn_id: Mapped[str] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(20))
    risk_score: Mapped[float] = mapped_column(Float)
    signals: Mapped[list] = mapped_column(JSON, default=list)
    explanation: Mapped[str] = mapped_column(Text, default="")
    evidence_txn_ids: Mapped[list] = mapped_column(JSON, default=list)
    suggested_action: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float)
    routing: Mapped[str] = mapped_column(String(20))
    routing_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    prev_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    agent_trace: Mapped[list] = mapped_column(JSON, default=list)
    model_name: Mapped[str] = mapped_column(String(60))
    model_version: Mapped[str] = mapped_column(String(40))
    assignee: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)
    updated_at: Mapped[str] = mapped_column(String(30), default=utcnow)
    human_category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    false_positive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Internal only (never on the wire): every txn this finding explains.
    covered_txn_ids: Mapped[list] = mapped_column(JSON, default=list)
    ai_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    ord: Mapped[int] = mapped_column(Integer, default=0)


class CommentRow(Base):
    __tablename__ = "comments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    finding_id: Mapped[str] = mapped_column(ForeignKey("findings.id", ondelete="CASCADE"), index=True)
    author: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)
    mentions: Mapped[list] = mapped_column(JSON, default=list)


class EventRow(Base):
    __tablename__ = "run_events"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    ts: Mapped[str] = mapped_column(String(30))
    level: Mapped[str] = mapped_column(String(8))
    stage: Mapped[str] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(Text)


class ProposedRuleRow(Base):
    __tablename__ = "proposed_rules"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(200))
    params: Mapped[dict] = mapped_column(JSON)
    supporting_txn_ids: Mapped[list] = mapped_column(JSON, default=list)
    simulation: Mapped[dict] = mapped_column(JSON)
    confidence: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="proposed")
    model_name: Mapped[str] = mapped_column(String(60))
    model_version: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)


class RuleRow(Base):
    __tablename__ = "rules"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(20))
    scope_value: Mapped[str | None] = mapped_column(String(200), nullable=True)
    params: Mapped[dict] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[dict] = mapped_column(JSON)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    last_triggered: Mapped[str | None] = mapped_column(String(30), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    proposed_rule_id: Mapped[str | None] = mapped_column(String(40), nullable=True)


class RuleVersionRow(Base):
    __tablename__ = "rule_versions"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(40), unique=True)
    rule_id: Mapped[str] = mapped_column(String(20), index=True)
    version: Mapped[int] = mapped_column(Integer)
    changed_by: Mapped[str] = mapped_column(String(120))
    changed_at: Mapped[str] = mapped_column(String(30))
    before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict] = mapped_column(JSON)
    note: Mapped[str] = mapped_column(Text, default="")


class DetectorRow(Base):
    __tablename__ = "detectors"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text)
    example: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    threshold: Mapped[float] = mapped_column(Float)
    weight: Mapped[float] = mapped_column(Float)
    ord: Mapped[int] = mapped_column(Integer, default=0)


class AuditRow(Base):
    """Append-only (UPDATE/DELETE blocked by triggers) with a SHA-256 hash chain."""

    __tablename__ = "audit_log"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(20), unique=True)
    ts: Mapped[str] = mapped_column(String(30), index=True)
    actor_type: Mapped[str] = mapped_column(String(10))
    actor_name: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(60))
    target: Mapped[str] = mapped_column(String(120), index=True)
    before: Mapped[dict | list | str | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict | list | str | None] = mapped_column(JSON, nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    model_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class ReportRow(Base):
    __tablename__ = "reports"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    run_period: Mapped[str] = mapped_column(String(7))
    type: Mapped[str] = mapped_column(String(30))
    format: Mapped[str] = mapped_column(String(4))
    name: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[str] = mapped_column(String(30))
    created_by: Mapped[str] = mapped_column(String(120))
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    share_token: Mapped[str] = mapped_column(String(40), unique=True)
    share_expires_at: Mapped[str] = mapped_column(String(30))


class SettingsRow(Base):
    __tablename__ = "settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class UploadRow(Base):
    __tablename__ = "uploads"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    meta: Mapped[dict] = mapped_column(JSON)  # UploadedFile wire dict
    kind: Mapped[str] = mapped_column(String(8))
    format: Mapped[str] = mapped_column(String(4))
    detected: Mapped[str] = mapped_column(String(30))  # parser id: icici | tally | generic | hdfc_pdf | pdf
    path: Mapped[str] = mapped_column(String(400))
    columns: Mapped[list] = mapped_column(JSON, default=list)
    rows: Mapped[list] = mapped_column(JSON, default=list)  # all parsed rows keyed by original headers
    mapping: Mapped[dict] = mapped_column(JSON, default=dict)  # auto mapping canonical -> source column
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)


class AiCacheRow(Base):
    __tablename__ = "ai_cache"
    hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    model: Mapped[str] = mapped_column(String(60))
    response: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(30), default=utcnow)


# Append-only enforcement for the audit table (SQLite). The Alembic migration installs the
# equivalent for Postgres.
for _op in ("UPDATE", "DELETE"):
    event.listen(
        AuditRow.__table__,
        "after_create",
        DDL(
            f"CREATE TRIGGER IF NOT EXISTS audit_no_{_op.lower()} BEFORE {_op} ON audit_log "
            "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;"
        ).execute_if(dialect="sqlite"),
    )
