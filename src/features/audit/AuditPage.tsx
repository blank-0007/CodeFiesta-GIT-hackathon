import * as React from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight, Download, Lock, ScrollText } from "lucide-react";
import { toast } from "sonner";
import type { AuditEntry } from "@/api/types";
import { useAudit, useRuns } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/form-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tip } from "@/components/ui/menus";
import { DataTable } from "@/components/shared/DataTable";
import { DiffView } from "@/components/shared/DiffView";
import { AIBadge } from "@/components/shared/badges";
import { Can, EmptyState, PageHeader } from "@/components/shared/misc";
import { MultiFilter, SearchInput } from "@/components/shared/filters";
import { ActorIcon } from "@/features/runs/tabs/ActivityTab";
import { useUrlList, useUrlParam } from "@/hooks/useUrlState";
import { fmtDateTime } from "@/lib/format";
import { cn, downloadBlob, toCsv } from "@/lib/utils";

/** Short FNV-1a fingerprint, chained with the previous entry — visual integrity cue. */
function fingerprint(e: AuditEntry, prev: string) {
  let h = 0x811c9dc5;
  const s = `${prev}|${e.id}|${e.ts}|${e.action}|${e.target}|${JSON.stringify(e.after ?? null)}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function summarize(v: unknown): string {
  if (v == null) return "—";
  if (typeof v !== "object") return String(v);
  const entries = Object.entries(v as Record<string, unknown>);
  return entries
    .slice(0, 3)
    .map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`)
    .join(", ");
}

export default function AuditPage() {
  const [q, setQ] = useUrlParam("q");
  const [actors, setActors] = useUrlList("actor");
  const [from, setFrom] = useUrlParam("from");
  const [to, setTo] = useUrlParam("to");
  const [runId, setRunId] = useUrlParam("run", "all");
  const [, setParams] = useSearchParams();
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const runs = useRuns();
  const filters = { q: q || undefined, actor: actors.join(",") || undefined, from: from || undefined, to: to || undefined, runId: runId === "all" ? undefined : runId };
  const { data, isLoading, isFetching, error, refetch } = useAudit(filters);

  const rows = React.useMemo(() => {
    if (!data) return undefined;
    // Fingerprints chain oldest → newest.
    const asc = [...data].sort((a, b) => a.ts.localeCompare(b.ts));
    let prev = "genesis";
    const fp = new Map<string, string>();
    asc.forEach((e) => {
      prev = fingerprint(e, prev);
      fp.set(e.id, prev);
    });
    return data.map((e) => ({ ...e, _fp: fp.get(e.id)! }));
  }, [data]);
  type Row = NonNullable<typeof rows>[number];

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "_x",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Expand</span>,
        cell: ({ row }) => (
          <button type="button" aria-expanded={expanded.has(row.id)} aria-label={`Show raw diff for ${row.id}`} onClick={(e) => { e.stopPropagation(); toggle(row.id); }} className="rounded p-0.5 text-muted-foreground hover:bg-surface-2">
            <ChevronRight className={cn("h-4 w-4 transition-transform", expanded.has(row.id) && "rotate-90")} />
          </button>
        ),
      },
      { id: "ts", accessorKey: "ts", header: "Timestamp", meta: { label: "Timestamp" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs">{fmtDateTime(row.original.ts)}</span> },
      {
        id: "actor",
        accessorFn: (e) => e.actor.name,
        header: "Actor",
        meta: { label: "Actor" },
        cell: ({ row }) => (
          <span className={cn("flex items-center gap-2 whitespace-nowrap text-sm", row.original.actor.type === "ai" && "text-ai")}>
            <ActorIcon type={row.original.actor.type} />
            {row.original.actor.name}
            {row.original.actor.type === "ai" && <AIBadge />}
          </span>
        ),
      },
      { id: "action", accessorKey: "action", header: "Action", meta: { label: "Action" }, cell: ({ row }) => <code className={cn("num whitespace-nowrap rounded px-1 py-0.5 text-xs", row.original.actor.type === "ai" ? "bg-ai/10 text-ai" : row.original.actor.type === "user" ? "bg-ok/10 text-ok" : "bg-surface-2")}>{row.original.action}</code> },
      { id: "target", accessorKey: "target", header: "Target", meta: { label: "Target" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs">{row.original.target}</span> },
      {
        id: "change",
        enableSorting: false,
        header: "Before → After",
        meta: { label: "Before / after" },
        cell: ({ row }) => (
          <Tip content={<pre className="num max-w-sm whitespace-pre-wrap text-2xs">{JSON.stringify({ before: row.original.before, after: row.original.after }, null, 2)}</pre>}>
            <span className="num block max-w-[320px] truncate text-2xs text-muted-foreground" tabIndex={0}>
              {row.original.before !== undefined && <><span className="text-crit/80">{summarize(row.original.before)}</span> → </>}
              <span className="text-foreground/80">{summarize(row.original.after)}</span>
            </span>
          </Tip>
        ),
      },
      { id: "run", accessorFn: (e) => e.runId ?? "", header: "Run", meta: { label: "Run ID" }, cell: ({ row }) => <span className="num whitespace-nowrap text-2xs text-muted-foreground">{row.original.runId ?? "—"}</span> },
      { id: "model", accessorFn: (e) => e.modelVersion ?? "", header: "Model", meta: { label: "Model version" }, cell: ({ row }) => <span className="num whitespace-nowrap text-2xs text-ai/90">{row.original.modelVersion ?? ""}</span> },
      { id: "ip", accessorFn: (e) => e.ip ?? "", header: "IP", meta: { label: "IP address" }, cell: ({ row }) => <span className="num text-2xs text-muted-foreground">{row.original.ip ?? "—"}</span> },
      { id: "fp", accessorKey: "_fp", enableSorting: false, header: "Hash", meta: { label: "Chain hash" }, cell: ({ row }) => <Tip content="Hash-chained fingerprint: changes to any earlier entry would change every hash after it."><span className="num text-2xs text-muted-foreground" tabIndex={0}>#{row.original._fp}</span></Tip> },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded],
  );

  const exportCsv = () => {
    if (!data?.length) return;
    downloadBlob(
      toCsv(data.map((e) => ({ id: e.id, timestamp: e.ts, actor_type: e.actor.type, actor: e.actor.name, action: e.action, target: e.target, before: e.before ?? "", after: e.after ?? "", run_id: e.runId ?? "", model_version: e.modelVersion ?? "", ip: e.ip ?? "" }))),
      `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv",
    );
    toast.success(`Exported ${data.length} audit entries`);
  };

  const isFiltered = !!q || actors.length > 0 || !!from || !!to || runId !== "all";

  return (
    <div>
      <PageHeader
        title="Audit log"
        breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Audit log" }]}
        description={
          <span className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Append-only record of every system, AI-agent and human action. Entries can't be edited or deleted.
          </span>
        }
        actions={
          <Can perm="audit.export">
            <Button variant="secondary" onClick={exportCsv} disabled={!data?.length}>
              <Download /> Export CSV
            </Button>
          </Can>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-label="Legend">
        <span className="flex items-center gap-1.5"><ActorIcon type="user" /> Human</span>
        <span className="flex items-center gap-1.5"><ActorIcon type="ai" /> AI agent</span>
        <span className="flex items-center gap-1.5"><ActorIcon type="system" /> System</span>
      </div>
      <div className="card overflow-hidden">
        <DataTable
          ariaLabel="Audit log entries"
          data={rows}
          columns={columns}
          getRowId={(e) => e.id}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
          onRowClick={(e) => toggle(e.id)}
          renderExpanded={(e) => (
            <div className="grid gap-3 p-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Raw JSON diff</p>
                <DiffView before={e.before ?? {}} after={e.after ?? {}} />
              </div>
              <div>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Entry</p>
                <pre className="num overflow-x-auto rounded-md border bg-background p-2 text-2xs">{JSON.stringify({ id: e.id, ts: e.ts, actor: e.actor, action: e.action, target: e.target, runId: e.runId, modelVersion: e.modelVersion, ip: e.ip, hash: e._fp }, null, 2)}</pre>
              </div>
            </div>
          )}
          expandedIds={expanded}
          urlKey="au_"
          defaultSort={[{ id: "ts", desc: true }]}
          isFiltered={isFiltered}
          onClearFilters={() => setParams({}, { replace: true })}
          rowClassName={(e) => (e.actor.type === "ai" ? "bg-ai/[0.025]" : undefined)}
          emptyState={<EmptyState icon={ScrollText} title="No audit entries yet" />}
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Action, target, actor, values…" label="Search audit log" />
              <MultiFilter label="Actor" value={actors} onChange={setActors} options={[{ value: "user", label: "Human" }, { value: "ai", label: "AI agent" }, { value: "system", label: "System" }]} />
              <Select value={runId} onValueChange={setRunId}>
                <SelectTrigger className="h-8 w-auto gap-2 text-xs" aria-label="Filter by run"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All runs</SelectItem>
                  {runs.data?.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Label htmlFor="au-from" className="sr-only">From date</Label>
                <Input id="au-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[136px] text-xs" />
                <span className="text-xs text-muted-foreground">–</span>
                <Label htmlFor="au-to" className="sr-only">To date</Label>
                <Input id="au-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[136px] text-xs" />
              </div>
              {isFetching && !isLoading && <span className="text-2xs text-muted-foreground" aria-live="polite">Updating…</span>}
            </>
          }
        />
      </div>
    </div>
  );
}
