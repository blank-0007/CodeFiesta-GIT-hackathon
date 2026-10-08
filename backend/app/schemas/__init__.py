"""Pydantic v2 wire schemas mirroring src/api/types.ts (camelCase on the wire, money as 2-dp strings)."""

from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer
from pydantic.alias_generators import to_camel

from app.core.money import D, fmt


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


def _to_money(v: Any) -> Decimal:
    if isinstance(v, bool):
        raise ValueError("Money must be a decimal string")
    return D(v)


Money = Annotated[Decimal, BeforeValidator(_to_money), PlainSerializer(fmt, return_type=str, when_used="always")]

Side = Literal["bank", "ledger"]
Category = Literal["duplicate", "missing", "timing", "potential_fraud", "unknown"]
FindingStatus = Literal["open", "auto_resolved", "in_review", "approved", "rejected", "escalated"]
RunStatus = Literal["queued", "running", "awaiting_review", "completed", "failed"]
StageState = Literal["pending", "active", "done", "failed"]
RoutingReason = Literal["High value", "Potential fraud", "Low AI confidence", "Unknown category"]
ReportType = Literal["reconciled_ledger", "anomaly_report", "audit_trail", "unresolved_items"]
ActorType = Literal["user", "system", "ai"]
DecisionAction = Literal["approve", "change_category", "reject", "escalate", "false_positive", "reopen"]

CATEGORIES: tuple[str, ...] = ("duplicate", "missing", "timing", "potential_fraud", "unknown")


class Txn(Camel):
    id: str
    source: Side
    date: str
    amount: Money
    description_raw: str
    vendor_norm: str
    reference: str | None = None
    account_id: str
    gl_code: str | None = None
    source_file: str | None = None
    source_page: int | None = None
    raw_row: dict[str, Any] = Field(default_factory=dict)


class ScoreBreakdown(Camel):
    amount: float
    date: float
    vendor: float
    reference: float


class MatchPair(Camel):
    id: str
    bank_txn_ids: list[str]
    ledger_txn_ids: list[str]
    score: float
    pass_name: str
    breakdown: ScoreBreakdown
    status: Literal["auto", "manual", "unmatched_later"]
    note: str | None = None
    created_by: str | None = None


class MatchPairView(MatchPair):
    bank: list[Txn]
    ledger: list[Txn]
    date_diff_days: int
    vendor_similarity: float
    amount_diff: Money


class Signal(Camel):
    txn_id: str
    detector: str
    score: float
    evidence_ids: list[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)
    human_text: str


class AgentStep(Camel):
    tool: str
    input: Any = None
    output_summary: str
    ms: int


class ModelRef(Camel):
    name: str
    version: str


class Finding(Camel):
    id: str
    run_id: str
    txn_id: str
    category: Category
    risk_score: float
    signals: list[Signal]
    explanation: str
    evidence_txn_ids: list[str]
    suggested_action: str
    confidence: float
    routing: Literal["auto_resolve", "human_review"]
    routing_reason: str | None = None
    status: FindingStatus
    agent_trace: list[AgentStep]
    model: ModelRef
    assignee: str | None = None
    created_at: str
    updated_at: str
    human_category: Category | None = None
    false_positive: bool | None = None


class FindingView(Finding):
    txn: Txn
    run_period: str


class Comment(Camel):
    id: str
    author: str
    body: str
    created_at: str
    mentions: list[str] = Field(default_factory=list)


class EvidenceItem(Camel):
    txn: Txn
    relation: Literal["candidate", "duplicate", "vendor_history", "period_boundary"]
    similarity: float
    note: str | None = None


class VendorHistoryPoint(Camel):
    date: str
    amount: Money
    txn_id: str | None = None


class Impact(Camel):
    contribution: Money
    unexplained_before: Money


class AuditEntry(Camel):
    id: str
    ts: str
    actor: dict[str, str]
    action: str
    target: str
    before: Any = None
    after: Any = None
    run_id: str | None = None
    model_version: str | None = None
    ip: str | None = None


class FindingDetail(FindingView):
    evidence: list[EvidenceItem]
    vendor_history: list[VendorHistoryPoint]
    comments: list[Comment]
    history: list[AuditEntry]
    impact: Impact


class DecisionRequest(Camel):
    action: DecisionAction
    category: Category | None = None
    reason: str | None = None
    comment: str | None = None


class UnmatchedItem(Camel):
    txn: Txn
    signals: list[Signal]
    risk_score: float
    finding_id: str | None = None
    category: Category | None = None


class UnmatchedResponse(Camel):
    bank: list[UnmatchedItem]
    ledger: list[UnmatchedItem]


class RunStage(Camel):
    name: str
    state: StageState
    count: int | None = None
    ms: int | None = None


class RunStats(Camel):
    bank_count: int
    ledger_count: int
    matched: int
    unmatched_bank: int
    unmatched_ledger: int
    anomalies: int
    auto_match_rate: float
    bank_total: Money
    ledger_total: Money
    explained: Money


class ReviewProgress(Camel):
    resolved: int
    total: int


class Run(Camel):
    id: str
    name: str
    period: str
    status: RunStatus
    accounts: list[str]
    stats: RunStats
    config: dict[str, Any]
    stages: list[RunStage]
    created_at: str
    created_by: str
    duration_ms: int | None = None
    review: ReviewProgress
    category_counts: dict[str, int]
    archived: bool | None = None
    tolerance_diff: Money

    # categoryCounts keys are category ids (snake_case) — never camelize dict keys.


class RunEvent(Camel):
    seq: int
    ts: str
    level: Literal["info", "warn", "error", "ai"]
    stage: str
    message: str


class PassConfig(Camel):
    name: str
    date_tolerance_days: int
    amount_tolerance: Money
    vendor_threshold: float
    confidence: float


class MatchingConfig(Camel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="allow")
    preset: Literal["strict", "balanced", "relaxed", "custom"] = "balanced"
    date_tolerance_days: int = 3
    amount_mode: Literal["exact", "tolerance"] = "tolerance"
    amount_tolerance: Money = Decimal("1.00")
    vendor_threshold: float = 0.85
    reference_matching: bool = True
    multi_pass: bool = True
    passes: list[PassConfig] = Field(default_factory=list)
    high_value_threshold: Money = Decimal("500000.00")
    approval_limit: Money = Decimal("50000.00")
    detectors: dict[str, bool] = Field(default_factory=dict)
    mask_account_numbers: bool | None = None


class SanityCheck(Camel):
    opening_balance: Money
    sum_of_txns: Money
    closing_balance: Money
    computed_closing: Money
    ok: bool
    explanation: str | None = None


class UploadWarning(Camel):
    page: int | None = None
    message: str
    can_retry_ocr: bool | None = None


class UploadedFile(Camel):
    id: str
    name: str
    size: int
    kind: Side
    format: Literal["pdf", "csv"]
    detected_format: str
    status: Literal["parsed", "error", "needs_mapping"]
    account_id: str | None = None
    row_count: int
    columns: list[str]
    auto_mapped: bool
    preview_rows: list[dict[str, str]]
    sanity: SanityCheck | None = None
    warnings: list[UploadWarning] = Field(default_factory=list)
    error: str | None = None


class LedgerSourceCsv(Camel):
    type: Literal["csv"]
    file_id: str | None = None


class LedgerSourceApi(Camel):
    type: Literal["api"]
    connector: str
    from_: str = Field(alias="from")
    to: str


class CreateRunRequest(Camel):
    name: str | None = None
    period: str | None = None
    accounts: list[str] = Field(default_factory=list)
    file_ids: list[str] = Field(default_factory=list)
    ledger_source: LedgerSourceCsv | LedgerSourceApi | None = None
    # Keys are upload ids (or client-local ids); inner keys are canonical fields or source columns.
    column_mapping: dict[str, dict[str, str]] | None = None
    sign_convention: Literal["debit_negative", "credit_negative"] | None = None
    config: dict[str, Any] | None = None
    mask_account_numbers: bool = True


class RerunRequest(Camel):
    date_tolerance_days: int = Field(ge=0, le=60)
    amount_tolerance: Money
    vendor_threshold: float = Field(ge=0, le=1)


class RerunResponse(Camel):
    matches_gained: int
    pair_ids: list[str]


class BulkArchiveRequest(Camel):
    ids: list[str]


class BulkDecisionRequest(Camel):
    ids: list[str]
    action: Literal["approve"]


class CommentRequest(Camel):
    body: str


class ManualMatchRequest(Camel):
    run_id: str
    bank_txn_ids: list[str] = Field(default_factory=list)
    ledger_txn_ids: list[str] = Field(default_factory=list)
    note: str = ""


class UnmatchRequest(Camel):
    run_id: str
    reason: str = ""


class Rule(Camel):
    id: str
    name: str
    description: str
    scope: Literal["vendor", "account", "global"]
    scope_value: str | None = None
    params: dict[str, Any]
    enabled: bool
    created_by: dict[str, str]
    hit_count: int
    last_triggered: str | None = None
    version: int


class RuleUpdate(Camel):
    enabled: bool | None = None
    params: dict[str, Any] | None = None


class Simulation(Camel):
    matches_gained: int
    matches_changed: int
    examples: list[str]


class ProposedRule(Camel):
    id: str
    run_id: str
    title: str
    description: str
    scope: str
    params: dict[str, Any]
    supporting_txn_ids: list[str]
    supporting_txns: list[Txn]
    simulation: Simulation
    confidence: float
    status: Literal["proposed", "approved", "rejected"]
    model: ModelRef


class RuleDecisionRequest(Camel):
    action: Literal["approve", "edit_approve", "reject"]
    params: dict[str, Any] | None = None
    reason: str | None = None


class Detector(Camel):
    id: str
    name: str
    description: str
    example: str
    enabled: bool
    threshold: float
    weight: float


class DetectorUpdate(Camel):
    enabled: bool | None = None
    threshold: float | None = None
    weight: float | None = Field(default=None, ge=0, le=1)


class DetectorTestRequest(Camel):
    run_id: str
    threshold: float
    weight: float = Field(ge=0, le=1)
    enabled: bool


class DetectorTestSample(Camel):
    id: str
    text: str


class DetectorTestResponse(Camel):
    flagged_now: int
    flagged_after: int
    newly_flagged: int
    cleared: int
    routed_to_review_delta: int
    sample: list[DetectorTestSample]


class RuleVersion(Camel):
    id: str
    rule_id: str
    version: int
    changed_by: str
    changed_at: str
    before: dict[str, Any] | None = None
    after: dict[str, Any]
    note: str


class RulesResponse(Camel):
    active: list[Rule]
    proposed: list[ProposedRule]
    detectors: list[Detector]
    versions: list[RuleVersion]


class ReviewItem(Camel):
    finding: FindingView
    priority: float
    routing_reason: str
    waiting_days: int


class ReportRequest(Camel):
    run_id: str
    type: ReportType
    format: Literal["csv", "pdf"] | None = None
    include_ai_explanations: bool = True
    include_evidence: bool = True


class Report(Camel):
    id: str
    run_id: str
    run_period: str
    type: ReportType
    format: Literal["csv", "pdf"]
    name: str
    size: int
    created_at: str
    created_by: str
    content: str | None = None
    share_url: str


class BankAccount(Camel):
    id: str
    name: str
    bank: str
    last4: str
    parser_template: str
    currency: str


class Connector(Camel):
    type: Literal["csv", "api"]
    provider: str
    status: Literal["connected", "disconnected"]


class OrgSettings(Camel):
    name: str
    accounts: list[BankAccount]
    connector: Connector
    approval_limit: Money
    high_value_threshold: Money


class AiSettings(Camel):
    provider: Literal["gemini"]
    default_model: str
    escalation_model: str
    send_data_to_ai: bool
    mask_account_numbers: bool
    mask_personal_names: bool
    retention_days: int
    est_cost_per_run: Money


class NotificationSettings(Camel):
    email: bool
    slack: bool
    slack_channel: str
    digest: Literal["realtime", "daily"]


class SettingsModel(Camel):
    organization: OrgSettings
    ai: AiSettings
    notifications: NotificationSettings


class SearchRun(Camel):
    id: str
    name: str
    period: str


class SearchTxn(Camel):
    id: str
    run_id: str
    description: str
    amount: Money
    finding_id: str | None = None


class SearchVendor(Camel):
    name: str
    count: int


class SearchResult(Camel):
    runs: list[SearchRun]
    txns: list[SearchTxn]
    vendors: list[SearchVendor]


class TrendPoint(Camel):
    period: str
    auto_match_rate: float


class DashboardData(Camel):
    runs_this_month: int
    auto_match_rate: float
    open_anomalies: int
    pending_reviews: int
    unreconciled_amount: Money
    avg_hours_saved: float
    trend: list[TrendPoint]
    # each item: {"period": ..., <category>: n} — category keys stay snake_case
    anomalies_by_month: list[dict[str, Any]]
    attention: list[FindingView]


class ActivityResponse(Camel):
    events: list[RunEvent]
    audit: list[AuditEntry]


class Ok(Camel):
    ok: bool = True
