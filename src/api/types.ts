/**
 * API contract shared with the FastAPI backend.
 * Money is ALWAYS a decimal string (e.g. "-124500.00"); never a float.
 * Negative = money leaving the account (debit), positive = credit.
 */
export type Money = string;

export type Side = "bank" | "ledger";

export interface Txn {
  id: string;
  source: Side;
  date: string; // ISO yyyy-MM-dd
  amount: Money; // signed
  descriptionRaw: string;
  vendorNorm: string;
  reference?: string;
  accountId: string;
  glCode?: string;
  sourceFile?: string;
  sourcePage?: number;
  rawRow: Record<string, unknown>;
}

export interface ScoreBreakdown {
  amount: number;
  date: number;
  vendor: number;
  reference: number;
}

export interface MatchPair {
  id: string;
  bankTxnIds: string[];
  ledgerTxnIds: string[];
  score: number;
  passName: string;
  breakdown: ScoreBreakdown;
  status: "auto" | "manual" | "unmatched_later";
  note?: string;
  createdBy?: string;
}

/** Pair with transactions embedded, as returned by GET /runs/:id/matches */
export interface MatchPairView extends MatchPair {
  bank: Txn[];
  ledger: Txn[];
  dateDiffDays: number;
  vendorSimilarity: number;
  amountDiff: Money; // sum(bank) - sum(ledger)
}

export interface Signal {
  txnId: string;
  detector: string;
  score: number;
  evidenceIds: string[];
  details: Record<string, unknown>;
  humanText: string;
}

export type Category = "duplicate" | "missing" | "timing" | "potential_fraud" | "unknown";

export type FindingStatus = "open" | "auto_resolved" | "in_review" | "approved" | "rejected" | "escalated";

export interface AgentStep {
  tool: string;
  input: unknown;
  outputSummary: string;
  ms: number;
}

export interface Finding {
  id: string;
  runId: string;
  txnId: string;
  category: Category;
  riskScore: number;
  signals: Signal[];
  explanation: string;
  evidenceTxnIds: string[];
  suggestedAction: string;
  confidence: number;
  routing: "auto_resolve" | "human_review";
  routingReason?: string;
  status: FindingStatus;
  agentTrace: AgentStep[];
  model: { name: string; version: string };
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  /** Category chosen by a human, if it differs from the AI's proposal. */
  humanCategory?: Category;
  falsePositive?: boolean;
}

export interface FindingView extends Finding {
  txn: Txn;
  runPeriod: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  mentions: string[];
}

export interface EvidenceItem {
  txn: Txn;
  relation: "candidate" | "duplicate" | "vendor_history" | "period_boundary";
  similarity: number;
  note?: string;
}

export interface FindingDetail extends FindingView {
  evidence: EvidenceItem[];
  vendorHistory: { date: string; amount: Money; txnId?: string }[];
  comments: Comment[];
  history: AuditEntry[];
  /** Effect on unexplained difference if this finding is approved. */
  impact: { contribution: Money; unexplainedBefore: Money };
}

export type DecisionAction =
  | "approve"
  | "change_category"
  | "reject"
  | "escalate"
  | "false_positive"
  | "reopen";

export interface DecisionRequest {
  action: DecisionAction;
  category?: Category;
  reason?: string;
  comment?: string;
}

export interface UnmatchedItem {
  txn: Txn;
  signals: Signal[];
  riskScore: number;
  findingId?: string;
  category?: Category;
}

export interface UnmatchedResponse {
  bank: UnmatchedItem[];
  ledger: UnmatchedItem[];
}

export type RunStatus = "queued" | "running" | "awaiting_review" | "completed" | "failed";
export type StageState = "pending" | "active" | "done" | "failed";

export interface RunStage {
  name: string;
  state: StageState;
  count?: number;
  ms?: number;
}

export interface RunStats {
  bankCount: number;
  ledgerCount: number;
  matched: number;
  unmatchedBank: number;
  unmatchedLedger: number;
  anomalies: number;
  autoMatchRate: number;
  bankTotal: Money;
  ledgerTotal: Money;
  explained: Money;
}

export interface Run {
  id: string;
  name: string;
  period: string; // yyyy-MM
  status: RunStatus;
  accounts: string[];
  stats: RunStats;
  config: MatchingConfig & Record<string, unknown>;
  stages: RunStage[];
  createdAt: string;
  createdBy: string;
  durationMs?: number;
  review: { resolved: number; total: number };
  categoryCounts: Record<Category, number>;
  archived?: boolean;
  /** Matched pairs whose bank/ledger amounts differ within tolerance. */
  toleranceDiff: Money;
}

export interface RunEvent {
  seq: number;
  ts: string;
  level: "info" | "warn" | "error" | "ai";
  stage: string;
  message: string;
}

export interface PassConfig {
  name: string;
  dateToleranceDays: number;
  amountTolerance: Money;
  vendorThreshold: number;
  confidence: number;
}

export interface MatchingConfig {
  preset: "strict" | "balanced" | "relaxed" | "custom";
  dateToleranceDays: number;
  amountMode: "exact" | "tolerance";
  amountTolerance: Money;
  vendorThreshold: number;
  referenceMatching: boolean;
  multiPass: boolean;
  passes: PassConfig[];
  highValueThreshold: Money;
  approvalLimit: Money;
  detectors: Record<string, boolean>;
  maskAccountNumbers?: boolean;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  kind: "bank" | "ledger";
  format: "pdf" | "csv";
  detectedFormat: string;
  status: "parsed" | "error" | "needs_mapping";
  accountId?: string;
  rowCount: number;
  columns: string[];
  autoMapped: boolean;
  previewRows: Record<string, string>[];
  sanity?: {
    openingBalance: Money;
    sumOfTxns: Money;
    closingBalance: Money;
    computedClosing: Money;
    ok: boolean;
    explanation?: string;
  };
  warnings: { page?: number; message: string; canRetryOcr?: boolean }[];
  error?: string;
}

export interface CreateRunRequest {
  name?: string;
  period: string;
  accounts: string[];
  fileIds: string[];
  ledgerSource: { type: "csv"; fileId?: string } | { type: "api"; connector: string; from: string; to: string };
  columnMapping?: Record<string, Record<string, string>>;
  signConvention?: "debit_negative" | "credit_negative";
  config: MatchingConfig;
  maskAccountNumbers: boolean;
}

export interface RerunRequest {
  dateToleranceDays: number;
  amountTolerance: Money;
  vendorThreshold: number;
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  scope: "vendor" | "account" | "global";
  scopeValue?: string;
  params: Record<string, unknown>;
  enabled: boolean;
  createdBy: { type: "human" | "ai"; name: string };
  hitCount: number;
  lastTriggered?: string;
  version: number;
}

export interface ProposedRule {
  id: string;
  runId: string;
  title: string;
  description: string;
  scope: string;
  params: Record<string, unknown>;
  supportingTxnIds: string[];
  supportingTxns: Txn[];
  simulation: { matchesGained: number; matchesChanged: number; examples: string[] };
  confidence: number;
  status: "proposed" | "approved" | "rejected";
  model: { name: string; version: string };
}

export interface Detector {
  id: string;
  name: string;
  description: string;
  example: string;
  enabled: boolean;
  threshold: number;
  weight: number;
}

export interface RuleVersion {
  id: string;
  ruleId: string;
  version: number;
  changedBy: string;
  changedAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  note: string;
}

export interface RulesResponse {
  active: Rule[];
  proposed: ProposedRule[];
  detectors: Detector[];
  versions: RuleVersion[];
}

export type RoutingReason = "High value" | "Potential fraud" | "Low AI confidence" | "Unknown category";

export interface ReviewItem {
  finding: FindingView;
  priority: number;
  routingReason: RoutingReason;
  waitingDays: number;
}

export type ReportType = "reconciled_ledger" | "anomaly_report" | "audit_trail" | "unresolved_items";

export interface ReportRequest {
  runId: string;
  type: ReportType;
  format: "csv" | "pdf";
  includeAiExplanations: boolean;
  includeEvidence: boolean;
}

export interface Report {
  id: string;
  runId: string;
  runPeriod: string;
  type: ReportType;
  format: "csv" | "pdf";
  name: string;
  size: number;
  createdAt: string;
  createdBy: string;
  content?: string; // CSV text or base64 PDF (mock only)
  shareUrl: string;
}

export type ActorType = "user" | "system" | "ai";

export interface AuditEntry {
  id: string;
  ts: string;
  actor: { type: ActorType; name: string };
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  runId?: string;
  modelVersion?: string;
  ip?: string;
}

export interface BankAccount {
  id: string;
  name: string;
  bank: string;
  last4: string;
  parserTemplate: string;
  currency: string;
}

export interface Settings {
  organization: {
    name: string;
    accounts: BankAccount[];
    connector: { type: "csv" | "api"; provider: string; status: "connected" | "disconnected" };
    approvalLimit: Money;
    highValueThreshold: Money;
  };
  ai: {
    provider: "gemini";
    defaultModel: string;
    escalationModel: string;
    sendDataToAi: boolean;
    maskAccountNumbers: boolean;
    maskPersonalNames: boolean;
    retentionDays: number;
    estCostPerRun: Money;
  };
  notifications: { email: boolean; slack: boolean; slackChannel: string; digest: "realtime" | "daily" };
}

export interface SearchResult {
  runs: { id: string; name: string; period: string }[];
  txns: { id: string; runId: string; description: string; amount: Money; findingId?: string }[];
  vendors: { name: string; count: number }[];
}

export interface DashboardData {
  runsThisMonth: number;
  autoMatchRate: number;
  openAnomalies: number;
  pendingReviews: number;
  unreconciledAmount: Money;
  avgHoursSaved: number;
  trend: { period: string; autoMatchRate: number }[];
  anomaliesByMonth: ({ period: string } & Record<Category, number>)[];
  attention: FindingView[];
}

export interface ApiErrorBody {
  error: string;
  detail?: string;
}
