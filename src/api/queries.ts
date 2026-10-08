import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, qk } from "./endpoints";
import { streamEvents } from "./client";
import type {
  AuditEntry,
  DecisionAction,
  DecisionRequest,
  FindingDetail,
  FindingStatus,
  FindingView,
  ReviewItem,
  Run,
  RunEvent,
  RunStage,
  Settings,
  Detector,
  Rule,
} from "./types";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export function toastError(e: unknown, title = "Action failed") {
  toast.error(title, { description: errorMessage(e) });
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */
export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard });
export const useRuns = () => useQuery({ queryKey: qk.runs, queryFn: api.runs });

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: qk.run(id ?? ""),
    queryFn: () => api.run(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" || q.state.data?.status === "queued" ? 2000 : false),
  });
}

const notRunning = (run?: Run) => !!run && run.status !== "running" && run.status !== "queued";

export function useMatches(runId: string, run?: Run) {
  return useQuery({ queryKey: qk.matches(runId), queryFn: () => api.matches(runId), enabled: notRunning(run) });
}
export function useUnmatched(runId: string, run?: Run) {
  return useQuery({ queryKey: qk.unmatched(runId), queryFn: () => api.unmatched(runId), enabled: notRunning(run) });
}
export function useFindings(runId: string, run?: Run) {
  return useQuery({ queryKey: qk.findings(runId), queryFn: () => api.findings(runId), enabled: notRunning(run) });
}
export const useActivity = (runId: string) => useQuery({ queryKey: qk.activity(runId), queryFn: () => api.activity(runId) });
export const useFinding = (id: string | undefined) =>
  useQuery({ queryKey: qk.finding(id ?? ""), queryFn: () => api.finding(id!), enabled: !!id });
export const useReviewQueue = () => useQuery({ queryKey: qk.reviewQueue, queryFn: api.reviewQueue });
export const useRules = () => useQuery({ queryKey: qk.rules, queryFn: api.rules });
export const useReports = () => useQuery({ queryKey: qk.reports, queryFn: api.reports });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings });
export function useAudit(f: { actor?: string; q?: string; from?: string; to?: string; runId?: string }) {
  return useQuery<AuditEntry[]>({ queryKey: qk.audit(f), queryFn: () => api.audit(f), placeholderData: (prev) => prev });
}

/** Live progress over SSE; falls back to useRun's polling if the stream fails. */
export function useRunStream(runId: string, active: boolean) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!active) return;
    setEvents([]);
    setConnected(true);
    const stop = streamEvents(
      `/runs/${runId}/events`,
      (event, data) => {
        if (event === "log") setEvents((prev) => (prev.some((e) => e.seq === (data as RunEvent).seq) ? prev : [...prev, data as RunEvent]));
        if (event === "stages") {
          const d = data as { status: Run["status"]; stages: RunStage[] };
          qc.setQueryData<Run>(qk.run(runId), (old) => (old ? { ...old, status: d.status, stages: d.stages } : old));
        }
        if (event === "done") {
          setConnected(false);
          invalidateRun(qc, runId);
          qc.invalidateQueries({ queryKey: qk.runs });
        }
      },
      () => setConnected(false),
    );
    return () => {
      stop();
      setConnected(false);
    };
  }, [runId, active, qc]);
  return { events, connected };
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */
export function invalidateRun(qc: QueryClient, runId?: string) {
  if (runId) qc.invalidateQueries({ queryKey: ["runs", runId] });
  qc.invalidateQueries({ queryKey: qk.reviewQueue });
  qc.invalidateQueries({ queryKey: qk.dashboard });
  qc.invalidateQueries({ queryKey: ["audit"] });
}

export const DECISION_STATUS: Record<DecisionAction, FindingStatus> = {
  approve: "approved",
  change_category: "approved",
  reject: "rejected",
  escalate: "escalated",
  false_positive: "approved",
  reopen: "open",
};

/** Optimistically updates every cached copy of the finding, rolls back on error. */
export function useDecision(findingId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DecisionRequest) => api.decide(findingId, body),
    onMutate: async (body) => {
      const status = DECISION_STATUS[body.action];
      await Promise.all([
        qc.cancelQueries({ queryKey: qk.finding(findingId) }),
        qc.cancelQueries({ queryKey: qk.findings(runId) }),
        qc.cancelQueries({ queryKey: qk.reviewQueue }),
      ]);
      const prev = {
        detail: qc.getQueryData<FindingDetail>(qk.finding(findingId)),
        list: qc.getQueryData<FindingView[]>(qk.findings(runId)),
        queue: qc.getQueryData<ReviewItem[]>(qk.reviewQueue),
      };
      const patch = <T extends FindingView>(f: T): T =>
        f.id === findingId ? { ...f, status, humanCategory: body.category ?? f.humanCategory } : f;
      if (prev.detail) qc.setQueryData(qk.finding(findingId), patch(prev.detail));
      if (prev.list) qc.setQueryData(qk.findings(runId), prev.list.map(patch));
      if (prev.queue) qc.setQueryData(qk.reviewQueue, prev.queue.map((i) => ({ ...i, finding: patch(i.finding) })));
      return prev;
    },
    onError: (e, _body, prev) => {
      if (prev?.detail) qc.setQueryData(qk.finding(findingId), prev.detail);
      if (prev?.list) qc.setQueryData(qk.findings(runId), prev.list);
      if (prev?.queue) qc.setQueryData(qk.reviewQueue, prev.queue);
      toastError(e, "Decision not saved — changes rolled back");
    },
    onSuccess: (data) => qc.setQueryData(qk.finding(findingId), data),
    onSettled: () => {
      invalidateRun(qc, runId);
      qc.invalidateQueries({ queryKey: qk.finding(findingId) });
    },
  });
}

export function useBulkApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDecide(ids, "approve"),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.reviewQueue });
      const prev = qc.getQueryData<ReviewItem[]>(qk.reviewQueue);
      if (prev)
        qc.setQueryData(
          qk.reviewQueue,
          prev.map((i) => (ids.includes(i.finding.id) ? { ...i, finding: { ...i.finding, status: "approved" as const } } : i)),
        );
      return prev;
    },
    onError: (e, _ids, prev) => {
      if (prev) qc.setQueryData(qk.reviewQueue, prev);
      toastError(e, "Bulk approve failed — changes rolled back");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      invalidateRun(qc);
    },
  });
}

export function useComment(findingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.comment(findingId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.finding(findingId) }),
    onError: (e) => toastError(e, "Comment not posted"),
  });
}

export function useManualMatch(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { bankTxnIds: string[]; ledgerTxnIds: string[]; note: string }) => api.manualMatch({ runId, ...body }),
    onSuccess: (pair) => {
      toast.success("Manual match created", { description: `${pair.id} · ${pair.bankTxnIds.length} bank ↔ ${pair.ledgerTxnIds.length} ledger` });
      invalidateRun(qc, runId);
    },
    onError: (e) => toastError(e, "Manual match failed"),
  });
}

export function useUnmatch(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pairId, reason }: { pairId: string; reason: string }) => api.unmatch(pairId, runId, reason),
    onSuccess: () => {
      toast.success("Pair unmatched", { description: "Both sides moved to Unmatched." });
      invalidateRun(qc, runId);
    },
    onError: (e) => toastError(e, "Unmatch failed"),
  });
}

export function useRerun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.rerun>[1]) => api.rerun(runId, body),
    onSuccess: (r) => {
      toast.success(r.matchesGained ? `Re-run matched ${r.matchesGained} more item${r.matchesGained === 1 ? "" : "s"}` : "Re-run found no new matches", {
        description: r.matchesGained ? "New pairs are in the Matched tab under “P5 · Relaxed re-run”." : "Try a wider amount tolerance.",
      });
      invalidateRun(qc, runId);
    },
    onError: (e) => toastError(e, "Re-run failed"),
  });
}

export function useFinalize(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.finalize(runId),
    onSuccess: () => {
      toast.success("Run finalized", { description: "The reconciliation is locked and recorded in the audit log." });
      invalidateRun(qc, runId);
      qc.invalidateQueries({ queryKey: qk.runs });
    },
    onError: (e) => toastError(e, "Could not finalize"),
  });
}

export function useRuleDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "approve" | "edit_approve" | "reject"; params?: Record<string, unknown>; reason?: string }) =>
      api.decideRule(id, body),
    onSuccess: (r) => {
      toast.success(r.status === "approved" ? "Rule approved and activated" : "Rule rejected", { description: r.title });
      qc.invalidateQueries({ queryKey: qk.rules });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (e) => toastError(e, "Rule decision failed"),
  });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Rule> & { id: string }) => api.updateRule(id, body),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.rules });
      const prev = qc.getQueryData<Awaited<ReturnType<typeof api.rules>>>(qk.rules);
      if (prev && enabled !== undefined)
        qc.setQueryData(qk.rules, { ...prev, active: prev.active.map((r) => (r.id === id ? { ...r, enabled } : r)) });
      return prev;
    },
    onError: (e, _v, prev) => {
      if (prev) qc.setQueryData(qk.rules, prev);
      toastError(e, "Rule not updated — rolled back");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.rules }),
  });
}

export function useUpdateDetector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Detector> & { id: string }) => api.updateDetector(id, body),
    onSuccess: (d) => {
      toast.success("Detector saved", { description: d.name });
      qc.invalidateQueries({ queryKey: qk.rules });
    },
    onError: (e) => toastError(e, "Detector not saved"),
  });
}

export function useCreateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createReport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reports });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (e) => toastError(e, "Report generation failed"),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Settings>) => api.updateSettings(body),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (e) => toastError(e, "Settings not saved"),
  });
}
