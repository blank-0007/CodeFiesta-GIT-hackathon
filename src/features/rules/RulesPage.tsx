import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation } from "@tanstack/react-query";
import { Bot, FlaskConical, History, Loader2, Save, ShieldAlert, Sparkles, User } from "lucide-react";
import type { Detector, Rule, RuleVersion } from "@/api/types";
import { api } from "@/api/endpoints";
import { toastError, useRules, useRuns, useUpdateDetector, useUpdateRule } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Slider, Switch } from "@/components/ui/form-controls";
import { Segmented, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/menus";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/shared/DataTable";
import { DiffView } from "@/components/shared/DiffView";
import { AIBadge } from "@/components/shared/badges";
import { Can, EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/shared/misc";
import { useUrlParam } from "@/hooks/useUrlState";
import { useCan } from "@/lib/permissions";
import { fmtDateTime, fmtPeriod, fmtRelative } from "@/lib/format";
import { ProposedRuleCard } from "./ProposedRuleCard";

function VersionList({ versions }: { versions: RuleVersion[] }) {
  if (!versions.length) return <EmptyState icon={History} title="No changes recorded" />;
  return (
    <ol className="space-y-3">
      {versions.map((v) => (
        <li key={v.id} className="rounded-md border">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
            <Badge tone="sys">{v.ruleId} · v{v.version}</Badge>
            <span className="font-medium">{v.changedBy}</span>
            <span className="num text-muted-foreground">{fmtDateTime(v.changedAt)}</span>
            <span className="text-muted-foreground">— {v.note}</span>
          </div>
          <div className="p-2">
            <DiffView before={v.before} after={v.after} label={`Changes in ${v.ruleId} version ${v.version}`} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function ActiveRules({ rules, versions }: { rules: Rule[]; versions: RuleVersion[] }) {
  const update = useUpdateRule();
  const canToggle = useCan("rule.toggle");
  const [history, setHistory] = React.useState<Rule | null>(null);
  const columns = React.useMemo<ColumnDef<Rule>[]>(
    () => [
      {
        id: "enabled",
        accessorKey: "enabled",
        header: "On",
        meta: { label: "Enabled" },
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={!canToggle}
            aria-label={`${row.original.enabled ? "Disable" : "Enable"} ${row.original.name}`}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(v) => update.mutate({ id: row.original.id, enabled: v })}
          />
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Rule",
        meta: { label: "Rule" },
        cell: ({ row }) => (
          <div className="min-w-0 max-w-[420px]">
            <div className="truncate text-sm font-medium">{row.original.name}</div>
            <div className="truncate text-2xs text-muted-foreground" title={row.original.description}>{row.original.description}</div>
          </div>
        ),
      },
      { id: "scope", accessorKey: "scope", header: "Scope", meta: { label: "Scope" }, cell: ({ row }) => <span className="flex flex-col"><Badge tone="neutral" className="w-fit capitalize">{row.original.scope}</Badge>{row.original.scopeValue && <span className="mt-0.5 truncate text-2xs text-muted-foreground">{row.original.scopeValue}</span>}</span> },
      {
        id: "createdBy",
        accessorFn: (r) => r.createdBy.type,
        header: "Created by",
        meta: { label: "Created by" },
        cell: ({ row }) =>
          row.original.createdBy.type === "ai" ? (
            <span className="flex items-center gap-1.5 text-xs text-ai"><Bot className="h-3.5 w-3.5" aria-hidden /> AI <span className="text-muted-foreground">(human-approved)</span></span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs"><User className="h-3.5 w-3.5 text-ok" aria-hidden /> {row.original.createdBy.name}</span>
          ),
      },
      { id: "hits", accessorKey: "hitCount", header: "Hits", meta: { label: "Hit count", align: "right" }, cell: ({ getValue }) => <span className="num">{getValue<number>().toLocaleString()}</span> },
      { id: "last", accessorFn: (r) => r.lastTriggered ?? "", header: "Last triggered", meta: { label: "Last triggered" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{row.original.lastTriggered ? fmtRelative(row.original.lastTriggered) : "Never"}</span> },
      {
        id: "version",
        accessorKey: "version",
        header: "Version",
        meta: { label: "Version" },
        cell: ({ row }) => (
          <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); setHistory(row.original); }} aria-label={`Version history for ${row.original.name}`}>
            <History /> v{row.original.version}
          </Button>
        ),
      },
    ],
    [canToggle, update],
  );
  return (
    <>
      <div className="card overflow-hidden">
        <DataTable ariaLabel="Active matching rules" data={rules} columns={columns} getRowId={(r) => r.id} urlKey="ar_" maxHeight="none" rowClassName={(r) => (!r.enabled ? "opacity-60" : undefined)} />
      </div>
      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription>{history?.name}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <VersionList versions={versions.filter((v) => v.ruleId === history?.id)} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DetectorCard({ d, runOptions }: { d: Detector; runOptions: { id: string; label: string }[] }) {
  const save = useUpdateDetector();
  const canEdit = useCan("detector.configure");
  const [enabled, setEnabled] = React.useState(d.enabled);
  const [threshold, setThreshold] = React.useState(String(d.threshold));
  const [weight, setWeight] = React.useState(d.weight);
  const [runId, setRunId] = React.useState(runOptions[0]?.id ?? "");
  const test = useMutation({ mutationFn: () => api.testDetector(d.id, { runId, threshold: Number(threshold), weight, enabled }), onError: (e) => toastError(e, "Test failed") });
  const dirty = enabled !== d.enabled || Number(threshold) !== d.threshold || weight !== d.weight;
  const valid = threshold.trim() !== "" && Number.isFinite(Number(threshold)) && Number(threshold) >= 0;
  const id = `det-${d.id}`;

  return (
    <article className="card flex flex-col" aria-labelledby={`${id}-h`}>
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 id={`${id}-h`} className="text-sm font-semibold">{d.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.description}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} aria-label={`Enable ${d.name}`} />
      </div>
      <div className="flex-1 space-y-3 px-4 py-3">
        <p className="rounded bg-surface-2 px-2 py-1 text-2xs"><span className="text-muted-foreground">Example: </span>{d.example}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`${id}-t`}>Threshold</Label>
            <Input id={`${id}-t`} inputMode="decimal" className="num mt-1 h-8 text-xs" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!canEdit} aria-invalid={!valid} />
          </div>
          <div>
            <Label>Weight: <span className="num">{weight.toFixed(2)}</span></Label>
            <Slider className="mt-2.5" min={0} max={1} step={0.05} value={[weight]} onValueChange={(v) => setWeight(v[0])} disabled={!canEdit} thumbLabel={`${d.name} weight`} />
          </div>
        </div>
        {test.data && (
          <div className="rounded-md border border-sys/30 bg-sys/5 p-2.5 text-xs" role="status">
            <p className="font-medium">Impact on {runOptions.find((r) => r.id === runId)?.label}</p>
            <p className="num mt-1">
              Flagged: {test.data.flaggedNow} → <strong>{test.data.flaggedAfter}</strong>
              {test.data.newlyFlagged > 0 && <span className="text-attn"> (+{test.data.newlyFlagged} new)</span>}
              {test.data.cleared > 0 && <span className="text-ok"> (−{test.data.cleared} cleared)</span>}
              {" · "}review queue {test.data.routedToReviewDelta >= 0 ? "+" : ""}{test.data.routedToReviewDelta}
            </p>
            {test.data.sample.length > 0 && <ul className="mt-1 space-y-0.5 text-muted-foreground">{test.data.sample.map((s) => <li key={s.id} className="truncate">• {s.id}: {s.text}</li>)}</ul>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        <Select value={runId} onValueChange={setRunId}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Run to test on"><SelectValue placeholder="Choose run" /></SelectTrigger>
          <SelectContent>{runOptions.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={!runId || !valid || test.isPending}>
          {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />} Test on run
        </Button>
        <Can perm="detector.configure">
          <Button size="sm" className="ml-auto" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate({ id: d.id, enabled, threshold: Number(threshold), weight })}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </Can>
      </div>
    </article>
  );
}

export default function RulesPage() {
  const { data, isLoading, error, refetch } = useRules();
  const runs = useRuns();
  const [tab, setTab] = useUrlParam("tab", "active");
  const [show, setShow] = useUrlParam("show", "proposed");
  const pending = data?.proposed.filter((p) => p.status === "proposed").length ?? 0;
  const runOptions = (runs.data ?? []).filter((r) => r.status === "awaiting_review" || r.status === "completed").map((r) => ({ id: r.id, label: fmtPeriod(r.period) }));

  return (
    <div>
      <PageHeader
        title="Rules"
        breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Rules" }]}
        description="Deterministic matching rules, AI proposals awaiting approval, and detector configuration."
      />
      {isLoading ? (
        <div className="card"><SkeletonRows rows={8} cols={5} /></div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : data ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Rules sections">
            <TabsTrigger value="active">Active rules <span className="num text-2xs text-muted-foreground">{data.active.length}</span></TabsTrigger>
            <TabsTrigger value="proposed"><Sparkles className="text-ai" /> Proposed by AI {pending > 0 && <span className="num rounded-full bg-ai/15 px-1.5 text-2xs text-ai">{pending}</span>}</TabsTrigger>
            <TabsTrigger value="detectors">Detectors</TabsTrigger>
            <TabsTrigger value="history"><History /> Version history</TabsTrigger>
          </TabsList>
          <TabsContent value="active"><ActiveRules rules={data.active} versions={data.versions} /></TabsContent>
          <TabsContent value="proposed">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-md border border-ai/30 bg-ai/5 px-3 py-2 text-xs">
                <ShieldAlert className="h-4 w-4 text-ai" aria-hidden />
                <span><strong>Rules never activate without human approval.</strong> The agent proposes; you decide.</span>
                <AIBadge />
              </div>
              <Segmented label="Show" value={show as "proposed" | "all"} onChange={setShow} options={[{ value: "proposed", label: "Pending", count: pending }, { value: "all", label: "All", count: data.proposed.length }]} className="ml-auto" />
            </div>
            {(() => {
              const list = data.proposed.filter((p) => show === "all" || p.status === "proposed");
              return list.length ? <div className="space-y-4">{list.map((r) => <ProposedRuleCard key={r.id} rule={r} />)}</div> : <div className="card"><EmptyState icon={Sparkles} title="No pending proposals" description="You've reviewed every rule the agent suggested." /></div>;
            })()}
          </TabsContent>
          <TabsContent value="detectors">
            <p className="mb-3 text-xs text-muted-foreground">
              Detectors are deterministic checks that produce signals; their scores are combined with noisy-OR into a risk score. Changes apply to future runs — use <em>Test on run</em> to preview the impact first.
            </p>
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {data.detectors.map((d) => <DetectorCard key={d.id} d={d} runOptions={runOptions} />)}
            </div>
          </TabsContent>
          <TabsContent value="history">
            <div className="card p-4"><VersionList versions={data.versions} /></div>
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
