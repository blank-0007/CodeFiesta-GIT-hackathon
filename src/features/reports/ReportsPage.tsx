import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Copy, Download, FileSpreadsheet, FileText, Link2, Loader2, ScrollText, ListChecks } from "lucide-react";
import { toast } from "sonner";
import type { Report, ReportType } from "@/api/types";
import { useCreateReport, useFindings, useReports, useRun, useRuns, toastError } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Label, Switch, FieldError } from "@/components/ui/form-controls";
import { Segmented, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { DataTable } from "@/components/shared/DataTable";
import { AmountCell } from "@/components/shared/AmountCell";
import { AIBadge, CATEGORIES, CATEGORY_META } from "@/components/shared/badges";
import { Can, EmptyState, PageHeader } from "@/components/shared/misc";
import { runDifference } from "@/features/runs/SummaryStrip";
import { fmtBytes, fmtDate, fmtDateTime, fmtPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import { downloadReport, saveReport } from "./download";

const TYPES: { id: ReportType; label: string; description: string; formats: ("csv" | "pdf")[]; icon: typeof FileText }[] = [
  { id: "reconciled_ledger", label: "Reconciled ledger", description: "Every matched pair and unmatched item with pass, confidence and GL code.", formats: ["csv"], icon: FileSpreadsheet },
  { id: "anomaly_report", label: "Anomaly investigation report", description: "Cover summary, totals, anomalies by category and detailed findings.", formats: ["pdf", "csv"], icon: FileText },
  { id: "audit_trail", label: "Audit trail", description: "Every system, AI and human action for the run, with before/after values.", formats: ["csv"], icon: ScrollText },
  { id: "unresolved_items", label: "Unresolved items", description: "Open findings still awaiting a decision — for carry-forward.", formats: ["csv"], icon: ListChecks },
];
/** Fixed print colours — the preview is a white "paper" regardless of theme. */
const PAPER_COLORS = { duplicate: "#FB923C", missing: "#60A5FA", timing: "#FBBF24", potential_fraud: "#F87171", unknown: "#94A3B8" } as const;
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label])) as Record<ReportType, string>;

const schema = z.object({
  runId: z.string().min(1, "Choose a run"),
  type: z.enum(["reconciled_ledger", "anomaly_report", "audit_trail", "unresolved_items"]),
  format: z.enum(["csv", "pdf"]),
  includeAiExplanations: z.boolean(),
  includeEvidence: z.boolean(),
});
type Values = z.infer<typeof schema>;

function copyLink(r: Report) {
  navigator.clipboard?.writeText(r.shareUrl).then(
    () => toast.success("Shareable link copied", { description: `${r.shareUrl} (mock — expires in 7 days)` }),
    () => toast.error("Couldn't access the clipboard"),
  );
}

function Preview({ v }: { v: Values }) {
  const { data: run } = useRun(v.runId || undefined);
  const { data: findings } = useFindings(v.runId, run);
  if (!run) return <div className="skeleton aspect-[1/1.414] w-full" />;
  const { difference, unexplained } = runDifference(run);
  const total = CATEGORIES.reduce((a, c) => a + run.categoryCounts[c], 0) || 1;
  const top = [...(findings ?? [])].sort((a, b) => b.riskScore - a.riskScore).slice(0, 4);
  return (
    <div className="mx-auto aspect-[1/1.414] w-full max-w-[520px] overflow-hidden rounded-md bg-white p-7 text-[10px] leading-snug text-slate-800 shadow-2xl" role="img" aria-label={`Preview of ${TYPE_LABEL[v.type]} for ${run.name}`}>
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <span className="font-semibold text-slate-900">ReconAI</span>
        <span className="text-slate-500">{TYPE_LABEL[v.type]} · {v.format.toUpperCase()}</span>
      </div>
      <h2 className="mt-4 text-[15px] font-semibold text-slate-900">{run.name}</h2>
      <p className="text-slate-500">Period {fmtPeriod(run.period)} · generated {fmtDate(new Date().toISOString())}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          ["Bank total", run.stats.bankTotal],
          ["Ledger total", run.stats.ledgerTotal],
          ["Difference", difference],
          ["Explained", run.stats.explained],
          ["Unexplained", unexplained],
        ].map(([k, val]) => (
          <div key={k} className="rounded border border-slate-200 p-1.5">
            <div className="text-[8px] uppercase tracking-wide text-slate-500">{k}</div>
            <AmountCell value={val} colorize={false} className={cn("text-[10px] font-semibold", k === "Unexplained" && unexplained !== "0.00" ? "text-red-600" : "text-slate-900")} />
          </div>
        ))}
        <div className="rounded border border-slate-200 p-1.5">
          <div className="text-[8px] uppercase tracking-wide text-slate-500">Auto-match</div>
          <span className="font-mono font-semibold">{(run.stats.autoMatchRate * 100).toFixed(1)}%</span>
        </div>
      </div>
      <h3 className="mt-4 font-semibold text-slate-900">Anomalies by category</h3>
      <div className="mt-1 flex h-2.5 overflow-hidden rounded">
        {CATEGORIES.map((c) => <div key={c} style={{ width: `${(run.categoryCounts[c] / total) * 100}%`, background: PAPER_COLORS[c] }} />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-slate-600">
        {CATEGORIES.map((c) => <span key={c}>{CATEGORY_META[c].label}: {run.categoryCounts[c]}</span>)}
      </div>
      <h3 className="mt-4 font-semibold text-slate-900">Detailed findings</h3>
      <ul className="mt-1 space-y-2">
        {top.map((f) => (
          <li key={f.id} className="border-l-2 border-slate-300 pl-2">
            <div className="flex justify-between font-medium text-slate-900">
              <span>{f.id} · {CATEGORY_META[f.humanCategory ?? f.category].label} · risk {Math.round(f.riskScore * 100)}</span>
              <AmountCell value={f.txn.amount} colorize={false} className="text-[10px]" />
            </div>
            <div className="truncate text-slate-500">{f.txn.descriptionRaw}</div>
            {v.includeAiExplanations && <p className="mt-0.5 line-clamp-2 text-violet-700">AI ({Math.round(f.confidence * 100)}%): {f.explanation}</p>}
            {v.includeEvidence && <p className="truncate text-slate-500">Evidence: {f.signals.map((s) => s.humanText).join(" · ")}</p>}
          </li>
        ))}
      </ul>
      {v.includeEvidence && <p className="mt-3 text-slate-400">+ Evidence appendix: {findings?.length ?? 0} findings with signals and related transactions</p>}
    </div>
  );
}

export default function ReportsPage() {
  const runs = useRuns();
  const reports = useReports();
  const create = useCreateReport();
  const [last, setLast] = React.useState<Report | null>(null);
  const eligible = (runs.data ?? []).filter((r) => r.status === "awaiting_review" || r.status === "completed");
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { runId: "", type: "anomaly_report", format: "pdf", includeAiExplanations: true, includeEvidence: true } });
  const v = form.watch();
  const type = TYPES.find((t) => t.id === v.type)!;

  React.useEffect(() => {
    if (!v.runId && eligible[0]) form.setValue("runId", eligible[0].id);
  }, [eligible, v.runId, form]);
  React.useEffect(() => {
    if (!type.formats.includes(v.format)) form.setValue("format", type.formats[0]);
  }, [type, v.format, form]);

  const submit = form.handleSubmit(async (values) => {
    try {
      const r = await create.mutateAsync(values);
      setLast(r);
      saveReport(r);
    } catch {
      /* toast in hook */
    }
  });

  const columns = React.useMemo<ColumnDef<Report>[]>(
    () => [
      { accessorKey: "name", header: "Report", meta: { label: "Report" }, cell: ({ row }) => <span className="flex items-center gap-2"><span className={cn("rounded px-1 text-[10px] font-semibold uppercase", row.original.format === "pdf" ? "bg-crit/10 text-crit" : "bg-ok/10 text-ok")}>{row.original.format}</span><span className="num text-xs">{row.original.name}</span></span> },
      { id: "type", accessorKey: "type", header: "Type", meta: { label: "Type" }, cell: ({ row }) => <span className="text-xs">{TYPE_LABEL[row.original.type]}</span> },
      { accessorKey: "runPeriod", header: "Period", meta: { label: "Period" }, cell: ({ row }) => <span className="whitespace-nowrap text-xs">{fmtPeriod(row.original.runPeriod)}</span> },
      { accessorKey: "size", header: "Size", meta: { label: "Size", align: "right" }, cell: ({ row }) => <span className="num text-xs text-muted-foreground">{fmtBytes(row.original.size)}</span> },
      { accessorKey: "createdAt", header: "Generated", meta: { label: "Generated" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span> },
      { accessorKey: "createdBy", header: "By", meta: { label: "By" }, cell: ({ row }) => <span className="whitespace-nowrap text-xs">{row.original.createdBy}</span> },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <span className="flex justify-end gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Download ${row.original.name}`} onClick={() => downloadReport(row.original.id).catch((e) => toastError(e, "Download failed"))}><Download /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Copy shareable link for ${row.original.name}`} onClick={() => copyLink(row.original)}><Link2 /></Button>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader title="Reports" breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Reports" }]} description="Generate audit-ready exports for any finished run." />
      <div className="grid gap-5 xl:grid-cols-[1fr_560px]">
        <form onSubmit={submit} className="card space-y-5 p-4" noValidate aria-label="Report generator">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Report type</legend>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <div role="radiogroup" aria-label="Report type" className="grid gap-2 sm:grid-cols-2">
                  {TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={field.value === t.id}
                      onClick={() => field.onChange(t.id)}
                      className={cn("flex gap-3 rounded-lg border p-3 text-left hover:border-muted-foreground/50", field.value === t.id && "border-sys bg-sys/5 ring-1 ring-sys/30")}
                    >
                      <t.icon className="mt-0.5 h-4 w-4 shrink-0 text-sys" aria-hidden />
                      <span>
                        <span className="block text-sm font-medium">{t.label}</span>
                        <span className="block text-2xs text-muted-foreground">{t.description}</span>
                        <span className="num mt-1 block text-[10px] uppercase text-muted-foreground">{t.formats.join(" / ")}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            />
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="rep-run">Run</Label>
              <Controller
                control={form.control}
                name="runId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="rep-run" className="mt-1" aria-invalid={!!form.formState.errors.runId}><SelectValue placeholder="Choose a run" /></SelectTrigger>
                    <SelectContent>{eligible.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              />
              <FieldError message={form.formState.errors.runId?.message} />
            </div>
            <div>
              <Label>Format</Label>
              <Controller control={form.control} name="format" render={({ field }) => <Segmented className="mt-1" label="Format" value={field.value} onChange={field.onChange} options={type.formats.map((f) => ({ value: f, label: f.toUpperCase() }))} />} />
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="rep-ai" className="flex items-center gap-2 font-normal">Include AI explanations <AIBadge /></Label>
              <Controller control={form.control} name="includeAiExplanations" render={({ field }) => <Switch id="rep-ai" checked={field.value} onCheckedChange={field.onChange} disabled={v.type === "reconciled_ledger" || v.type === "audit_trail"} />} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="rep-ev" className="font-normal">Include evidence appendix</Label>
              <Controller control={form.control} name="includeEvidence" render={({ field }) => <Switch id="rep-ev" checked={field.value} onCheckedChange={field.onChange} disabled={v.type === "reconciled_ledger" || v.type === "audit_trail"} />} />
            </div>
            <p className="text-2xs text-muted-foreground">AI explanations are always labelled with model, version and confidence in exports.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Can perm="report.generate">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <Download />} Generate & download
              </Button>
            </Can>
            {last && (
              <>
                <span className="flex items-center gap-1 text-xs text-ok"><Check className="h-3.5 w-3.5" /> {last.name}</span>
                <Button variant="secondary" size="sm" onClick={() => copyLink(last)}><Copy /> Copy shareable link</Button>
              </>
            )}
          </div>
        </form>

        <section aria-label="Report preview" className="rounded-lg border bg-surface-2/50 p-4">
          <p className="mb-3 text-xs font-medium text-muted-foreground">Preview{v.format === "csv" && " (layout of the PDF equivalent — CSV contains the same rows)"}</p>
          {v.runId ? <Preview v={v} /> : <EmptyState title="Choose a run to preview" />}
        </section>
      </div>

      <section className="mt-6" aria-labelledby="hist-h">
        <h2 id="hist-h" className="mb-2 text-sm font-semibold">History</h2>
        <div className="card overflow-hidden">
          <DataTable
            ariaLabel="Generated reports"
            data={reports.data}
            columns={columns}
            getRowId={(r) => r.id}
            isLoading={reports.isLoading}
            error={reports.error}
            onRetry={() => reports.refetch()}
            urlKey="rep_"
            defaultSort={[{ id: "createdAt", desc: true }]}
            maxHeight="420px"
            emptyState={<EmptyState icon={FileText} title="No reports yet" description="Generated reports appear here for re-download." />}
          />
        </div>
      </section>
    </div>
  );
}
