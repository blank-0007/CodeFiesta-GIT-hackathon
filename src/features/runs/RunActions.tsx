import * as React from "react";
import { Download, FileSpreadsheet, FileText, Loader2, Lock, RotateCcw, Settings2 } from "lucide-react";
import type { ReportType, Run } from "@/api/types";
import { useCreateReport, useFinalize, useRerun } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tip } from "@/components/ui/menus";
import { Input, Label, Slider } from "@/components/ui/form-controls";
import { AmountCell, useMoneyFormatter } from "@/components/shared/AmountCell";
import { Can } from "@/components/shared/misc";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { saveReport } from "@/features/reports/download";
import { DETECTOR_LABELS } from "@/lib/matching";
import { useCan } from "@/lib/permissions";
import { runDifference } from "./SummaryStrip";
import { big } from "@/lib/money";

export function ConfigSnapshotButton({ run }: { run: Run }) {
  const [open, setOpen] = React.useState(false);
  const money = useMoneyFormatter();
  const c = run.config;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Settings2 /> Config snapshot
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configuration snapshot</DialogTitle>
            <DialogDescription>The exact settings this run used — frozen at start for auditability.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <dl className="space-y-1 text-sm">
              {[
                ["Preset", c.preset],
                ["Date tolerance", `±${c.dateToleranceDays} days`],
                ["Amount", c.amountMode === "exact" ? "Exact" : `± ${money(c.amountTolerance)}`],
                ["Vendor threshold", `${Math.round(c.vendorThreshold * 100)}%`],
                ["Reference matching", c.referenceMatching ? "On" : "Off"],
                ["High-value threshold", money(c.highValueThreshold)],
                ["Approval limit", money(c.approvalLimit)],
                ["Mask account numbers", c.maskAccountNumbers === false ? "Off" : "On"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-border/50 py-1">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="num text-right capitalize">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <h3 className="mb-1 text-xs font-semibold">Passes</h3>
              <ol className="mb-3 space-y-1 text-xs">
                {c.passes.map((p) => (
                  <li key={p.name} className="num flex justify-between rounded bg-surface-2 px-2 py-1">
                    <span>{p.name}</span>
                    <span className="text-muted-foreground">±{p.dateToleranceDays}d · ±₹{p.amountTolerance} · ≥{Math.round(p.vendorThreshold * 100)}%</span>
                  </li>
                ))}
              </ol>
              <h3 className="mb-1 text-xs font-semibold">Detectors</h3>
              <ul className="flex flex-wrap gap-1">
                {Object.entries(c.detectors).map(([k, on]) => (
                  <li key={k} className={`rounded border px-1.5 py-0.5 text-2xs ${on ? "border-sys/30 text-sys" : "text-muted-foreground line-through"}`}>
                    {DETECTOR_LABELS[k] ?? k}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const EXPORTS: { type: ReportType; format: "csv" | "pdf"; label: string; icon: typeof FileText }[] = [
  { type: "reconciled_ledger", format: "csv", label: "Reconciled ledger (CSV)", icon: FileSpreadsheet },
  { type: "anomaly_report", format: "pdf", label: "Anomaly investigation report (PDF)", icon: FileText },
  { type: "audit_trail", format: "csv", label: "Audit trail (CSV)", icon: FileSpreadsheet },
  { type: "unresolved_items", format: "csv", label: "Unresolved items (CSV)", icon: FileSpreadsheet },
];

export function ExportMenu({ run }: { run: Run }) {
  const create = useCreateReport();
  const canExport = useCan("report.generate");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" disabled={!canExport || run.status === "running"}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Download />} Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Download</DropdownMenuLabel>
        {EXPORTS.map((e) => (
          <DropdownMenuItem
            key={e.type}
            onSelect={async () => {
              const r = await create.mutateAsync({ runId: run.id, type: e.type, format: e.format, includeAiExplanations: true, includeEvidence: true });
              saveReport(r);
            }}
          >
            <e.icon /> {e.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RerunButton({ run }: { run: Run }) {
  const [open, setOpen] = React.useState(false);
  const rerun = useRerun(run.id);
  const [date, setDate] = React.useState(Math.min(10, run.config.dateToleranceDays + 2));
  const [amount, setAmount] = React.useState("5000.00");
  const [vendor, setVendor] = React.useState(0.7);
  const unmatched = run.stats.unmatchedBank + run.stats.unmatchedLedger;
  const valid = /^\d+(\.\d{1,2})?$/.test(amount);
  return (
    <>
      <Can perm="run.rerun">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={run.status !== "awaiting_review" || unmatched === 0}>
          <RotateCcw /> Re-run with relaxed tolerances
        </Button>
      </Can>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!valid) return;
              await rerun.mutateAsync({ dateToleranceDays: date, amountTolerance: big(amount).toFixed(2), vendorThreshold: vendor });
              setOpen(false);
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Re-run with relaxed tolerances</DialogTitle>
              <DialogDescription>
                Only the <strong>{unmatched}</strong> unmatched items are re-matched. Existing matches and human decisions are kept. New matches are labelled “P5 · Relaxed re-run” so you can review them.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Date tolerance: ±{date} days <span className="text-muted-foreground">(was ±{run.config.dateToleranceDays})</span></Label>
              <Slider min={0} max={10} step={1} value={[date]} onValueChange={(v) => setDate(v[0])} thumbLabel="Date tolerance" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rr-amt">Amount tolerance <span className="text-muted-foreground">(was ±₹{run.config.amountTolerance})</span></Label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">±₹</span>
                <Input id="rr-amt" value={amount} onChange={(e) => setAmount(e.target.value)} className="num pl-8" aria-invalid={!valid} />
              </div>
              {!valid && <p className="text-xs text-crit">Enter an amount like 5000 or 0.50</p>}
            </div>
            <div className="space-y-2">
              <Label>Vendor threshold: {Math.round(vendor * 100)}% <span className="text-muted-foreground">(was {Math.round(run.config.vendorThreshold * 100)}%)</span></Label>
              <Slider min={0.5} max={1} step={0.01} value={[vendor]} onValueChange={(v) => setVendor(v[0])} thumbLabel="Vendor threshold" />
            </div>
            <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
              Wider tolerances increase the risk of false matches. Every relaxed match is logged and can be unmatched.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={rerun.isPending || !valid}>
                {rerun.isPending && <Loader2 className="animate-spin" />} Re-run unmatched
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function FinalizeButton({ run }: { run: Run }) {
  const [open, setOpen] = React.useState(false);
  const finalize = useFinalize(run.id);
  const canFinalize = useCan("run.finalize");
  const open_ = run.review.total - run.review.resolved;
  const { unexplained } = runDifference(run);
  const reason =
    run.status === "completed" ? "This run is already finalized." : run.status !== "awaiting_review" ? "Available once the run finishes." : open_ > 0 ? `${open_} finding${open_ === 1 ? "" : "s"} still need a human decision.` : null;
  const btn = (
    <Button size="sm" disabled={!!reason || !canFinalize} onClick={() => setOpen(true)}>
      <Lock /> Finalize run
    </Button>
  );
  return (
    <>
      {reason ? (
        <Tip content={reason}>
          <span tabIndex={0} className="inline-flex">{btn}</span>
        </Tip>
      ) : (
        <Can perm="run.finalize">{btn}</Can>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Finalize this reconciliation?"
        description="Finalizing locks the run: matches and decisions can no longer be changed. This cannot be undone."
        confirmLabel="Finalize"
        pending={finalize.isPending}
        onConfirm={async () => {
          await finalize.mutateAsync();
          setOpen(false);
        }}
      >
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">Unexplained difference</span>
          <AmountCell value={unexplained} colorize={false} emphasis={big(unexplained).eq(0) ? "none" : "warn"} />
        </div>
        {!big(unexplained).eq(0) && <p className="text-xs text-warn">Rejected items remain unexplained and will be carried into the report as open reconciling items.</p>}
      </ConfirmDialog>
    </>
  );
}
