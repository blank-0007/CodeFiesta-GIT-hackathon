/** Typed API surface. Swap the backend by setting VITE_API_BASE_URL — nothing else changes. */
import { get, post, put } from "./client";
import type {
  AuditEntry,
  CreateRunRequest,
  DashboardData,
  DecisionRequest,
  Detector,
  FindingDetail,
  FindingView,
  MatchPair,
  MatchPairView,
  ProposedRule,
  Report,
  ReportRequest,
  RerunRequest,
  ReviewItem,
  Rule,
  RulesResponse,
  Run,
  RunEvent,
  SearchResult,
  Settings,
  UnmatchedResponse,
  UploadedFile,
  Comment,
} from "./types";

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  dashboard: () => get<DashboardData>("/dashboard"),
  search: (q: string) => get<SearchResult>(`/search${qs({ q })}`),

  upload: (file: File, kind: "bank" | "ledger", accountId?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    if (accountId) fd.append("accountId", accountId);
    return post<UploadedFile>("/uploads", fd);
  },
  retryOcr: (uploadId: string) => post<UploadedFile>(`/uploads/${uploadId}/ocr`),

  runs: () => get<Run[]>("/runs"),
  run: (id: string) => get<Run>(`/runs/${id}`),
  createRun: (body: CreateRunRequest) => post<Run>("/runs", body as unknown as Record<string, unknown>),
  matches: (runId: string) => get<MatchPairView[]>(`/runs/${runId}/matches`),
  unmatched: (runId: string) => get<UnmatchedResponse>(`/runs/${runId}/unmatched`),
  findings: (runId: string) => get<FindingView[]>(`/runs/${runId}/findings`),
  activity: (runId: string) => get<{ events: RunEvent[]; audit: AuditEntry[] }>(`/runs/${runId}/activity`),
  rerun: (runId: string, body: RerunRequest) => post<{ matchesGained: number; pairIds: string[] }>(`/runs/${runId}/rerun`, body as unknown as Record<string, unknown>),
  finalize: (runId: string) => post<Run>(`/runs/${runId}/finalize`),
  archiveRuns: (ids: string[]) => post<{ archived: number }>("/runs/bulk-archive", { ids }),

  finding: (id: string) => get<FindingDetail>(`/findings/${id}`),
  decide: (id: string, body: DecisionRequest) => post<FindingDetail>(`/findings/${id}/decision`, body as unknown as Record<string, unknown>),
  bulkDecide: (ids: string[], action: "approve") => post<{ updated: number }>("/findings/bulk-decision", { ids, action }),
  comment: (id: string, body: string) => post<Comment>(`/findings/${id}/comments`, { body }),

  manualMatch: (body: { runId: string; bankTxnIds: string[]; ledgerTxnIds: string[]; note: string }) => post<MatchPair>("/matches/manual", body),
  unmatch: (pairId: string, runId: string, reason: string) => post<{ ok: true }>(`/matches/${pairId}/unmatch`, { runId, reason }),

  reviewQueue: () => get<ReviewItem[]>("/review-queue"),

  rules: () => get<RulesResponse>("/rules"),
  decideRule: (id: string, body: { action: "approve" | "edit_approve" | "reject"; params?: Record<string, unknown>; reason?: string }) => post<ProposedRule>(`/rules/${id}/decision`, body),
  updateRule: (id: string, body: Partial<Rule>) => put<Rule>(`/rules/${id}`, body as Record<string, unknown>),
  updateDetector: (id: string, body: Partial<Detector>) => put<Detector>(`/detectors/${id}`, body as Record<string, unknown>),
  testDetector: (id: string, body: { runId: string; threshold: number; weight: number; enabled: boolean }) =>
    post<{ flaggedNow: number; flaggedAfter: number; newlyFlagged: number; cleared: number; routedToReviewDelta: number; sample: { id: string; text: string }[] }>(`/detectors/${id}/test`, body),

  reports: () => get<Report[]>("/reports"),
  createReport: (body: ReportRequest) => post<Report>("/reports", body as unknown as Record<string, unknown>),
  downloadReport: (id: string) => get<Report>(`/reports/${id}/download`),

  audit: (f: { actor?: string; q?: string; from?: string; to?: string; runId?: string }) => get<AuditEntry[]>(`/audit${qs(f)}`),

  settings: () => get<Settings>("/settings"),
  updateSettings: (body: Partial<Settings>) => put<Settings>("/settings", body as Record<string, unknown>),
};

export const qk = {
  dashboard: ["dashboard"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["runs", id] as const,
  matches: (id: string) => ["runs", id, "matches"] as const,
  unmatched: (id: string) => ["runs", id, "unmatched"] as const,
  findings: (id: string) => ["runs", id, "findings"] as const,
  activity: (id: string) => ["runs", id, "activity"] as const,
  finding: (id: string) => ["findings", id] as const,
  reviewQueue: ["review-queue"] as const,
  rules: ["rules"] as const,
  reports: ["reports"] as const,
  audit: (f: object) => ["audit", f] as const,
  settings: ["settings"] as const,
};
