import { useParams } from "react-router-dom";
import { AlertOctagon, BarChart3, GitMerge, History, SearchX, Sparkles } from "lucide-react";
import { useActivity, useFindings, useRun, useRunStream } from "@/api/queries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/menus";
import { ErrorState, PageHeader } from "@/components/shared/misc";
import { StatusBadge } from "@/components/shared/badges";
import { Skeleton } from "@/components/ui/form-controls";
import { ApiError } from "@/api/client";
import { NotFound } from "@/routes/NotFound";
import { useUrlParam } from "@/hooks/useUrlState";
import { fmtDateTime, fmtPeriod } from "@/lib/format";
import { ACCOUNT_LABEL } from "@/lib/accounts";
import { SummaryStrip } from "./SummaryStrip";
import { CollapsiblePipeline, LogPanel, PipelineView } from "./PipelineView";
import { ConfigSnapshotButton, ExportMenu, FinalizeButton, RerunButton } from "./RunActions";
import { OverviewTab } from "./tabs/OverviewTab";
import { ActivityTab } from "./tabs/ActivityTab";
import { MatchedTab } from "@/features/matches/MatchedTab";
import { UnmatchedTab } from "@/features/matches/UnmatchedTab";
import { AnomaliesTab } from "@/features/anomalies/AnomaliesTab";
import { RunRulesTab } from "@/features/rules/RunRulesTab";

const TABS = ["overview", "matched", "unmatched", "anomalies", "rules", "activity"] as const;

function Count({ n, tone }: { n?: number; tone?: string }) {
  if (n == null) return null;
  return <span className={`num rounded-full bg-surface-2 px-1.5 text-2xs ${tone ?? "text-muted-foreground"}`}>{n}</span>;
}

export default function RunDetailPage() {
  const { runId = "" } = useParams();
  const { data: run, isLoading, error, refetch } = useRun(runId);
  const [tab, setTab] = useUrlParam("tab", "overview");
  const running = run?.status === "running" || run?.status === "queued";
  const stream = useRunStream(runId, !!running);
  const activity = useActivity(runId);
  const findings = useFindings(runId, run);

  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !run)
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-16" />
        <Skeleton className="h-96" />
      </div>
    );

  const openFindings = findings.data?.filter((f) => ["open", "in_review", "escalated"].includes(f.status)).length;
  const activeTab = (TABS as readonly string[]).includes(tab) ? tab : "overview";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "Runs", to: "/runs" }, { label: run.name }]}
        title={run.name}
        badge={<StatusBadge status={run.status} />}
        description={
          <span className="num text-xs">
            {fmtPeriod(run.period)} · {run.accounts.map((a) => ACCOUNT_LABEL[a] ?? a).join(" · ")} · started {fmtDateTime(run.createdAt)} by {run.createdBy} · {run.id}
          </span>
        }
        actions={
          <>
            <ConfigSnapshotButton run={run} />
            <ExportMenu run={run} />
            <RerunButton run={run} />
            <FinalizeButton run={run} />
          </>
        }
      />

      {run.status === "failed" ? (
        <div className="space-y-3">
          <div className="card border-crit/40 p-4" role="alert">
            <p className="flex items-center gap-2 text-sm font-medium text-crit"><AlertOctagon className="h-4 w-4" /> This run failed during ingestion</p>
            <p className="mt-1 text-sm text-muted-foreground">Nothing was matched or changed. Fix the file and start a new run.</p>
          </div>
          <PipelineView stages={run.stages} />
          <LogPanel events={activity.data?.events ?? []} />
        </div>
      ) : running ? (
        <section className="card space-y-4 p-4" aria-label="Live progress">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Reconciling…</h2>
            <span className="text-xs text-muted-foreground">{stream.connected ? "Streaming live updates" : "Polling for updates"}</span>
          </div>
          <PipelineView stages={run.stages} />
          <LogPanel events={stream.events} live />
          <p className="text-xs text-muted-foreground">Results, totals and findings appear here as soon as verification completes. You can safely leave this page.</p>
        </section>
      ) : (
        <>
          <SummaryStrip run={run} />
          <CollapsiblePipeline stages={run.stages} durationMs={run.durationMs}>
            <LogPanel events={activity.data?.events ?? []} />
          </CollapsiblePipeline>

          <Tabs value={activeTab} onValueChange={setTab}>
            <TabsList aria-label="Run sections">
              <TabsTrigger value="overview"><BarChart3 /> Overview</TabsTrigger>
              <TabsTrigger value="matched"><GitMerge /> Matched <Count n={run.stats.matched} tone="text-sys" /></TabsTrigger>
              <TabsTrigger value="unmatched"><SearchX /> Unmatched <Count n={run.stats.unmatchedBank + run.stats.unmatchedLedger} tone="text-attn" /></TabsTrigger>
              <TabsTrigger value="anomalies"><AlertOctagon /> Anomalies <Count n={openFindings} tone="text-crit" /></TabsTrigger>
              <TabsTrigger value="rules"><Sparkles /> Rules</TabsTrigger>
              <TabsTrigger value="activity"><History /> Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><OverviewTab run={run} /></TabsContent>
            <TabsContent value="matched"><MatchedTab run={run} /></TabsContent>
            <TabsContent value="unmatched"><UnmatchedTab run={run} /></TabsContent>
            <TabsContent value="anomalies"><AnomaliesTab run={run} /></TabsContent>
            <TabsContent value="rules"><RunRulesTab runId={run.id} /></TabsContent>
            <TabsContent value="activity"><ActivityTab run={run} /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
