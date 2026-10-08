import { Controller, useFormContext } from "react-hook-form";
import { Clock, Lock, ShieldCheck, Sparkles } from "lucide-react";
import type { FileEntry, WizardValues } from "./schema";
import { totalRows } from "./UploadStep";
import { Switch, Label } from "@/components/ui/form-controls";
import { AIBadge } from "@/components/shared/badges";
import { useMoneyFormatter } from "@/components/shared/AmountCell";
import { useSettings } from "@/api/queries";
import { fmtPeriod } from "@/lib/format";
import { ACCOUNT_LABEL } from "@/lib/accounts";
import { DETECTOR_LABELS, PRESETS } from "@/lib/matching";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}

export function ReviewStep({ files }: { files: FileEntry[] }) {
  const { watch, control } = useFormContext<WizardValues>();
  const v = watch();
  const money = useMoneyFormatter();
  const { data: settings } = useSettings();
  const rows = totalRows(files) || 1200;
  const minutes = Math.max(2, Math.round((rows / 600) * 1.6 + 1));
  const accounts = [...new Set(files.filter((f) => f.kind === "bank").map((f) => f.accountId!))];
  const detectorsOn = Object.entries(v.config.detectors).filter(([, on]) => on);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <section className="card p-4" aria-labelledby="sum-src">
          <h2 id="sum-src" className="mb-1 text-sm font-semibold">Sources</h2>
          <dl className="divide-y">
            <Row k="Period" v={fmtPeriod(v.period)} />
            <Row k="Run name" v={v.name || <span className="text-muted-foreground">Auto</span>} />
            <Row k="Bank accounts" v={<span className="num text-xs">{accounts.map((a) => ACCOUNT_LABEL[a] ?? a).join(" · ")}</span>} />
            <Row k="Files" v={<ul className="text-xs">{files.map((f) => <li key={f.localId} className="truncate">{f.file.name} <span className="num text-muted-foreground">({f.result?.rowCount ?? 0} rows)</span></li>)}</ul>} />
            <Row k="Ledger source" v={v.ledgerSource === "api" ? `API · ${v.connector} (${v.apiFrom} → ${v.apiTo})` : "CSV upload"} />
            {Object.keys(v.mappings).length > 0 && <Row k="Column mapping" v={`${Object.keys(v.mappings).length} file(s) mapped · ${v.signConvention === "debit_negative" ? "debits negative" : "credits negative"}`} />}
          </dl>
        </section>
        <section className="card p-4" aria-labelledby="sum-rules">
          <h2 id="sum-rules" className="mb-1 text-sm font-semibold">Matching rules</h2>
          <dl className="divide-y">
            <Row k="Preset" v={v.config.preset === "custom" ? "Custom" : PRESETS[v.config.preset].label} />
            <Row k="Date tolerance" v={`±${v.config.dateToleranceDays} days`} />
            <Row k="Amount" v={v.config.amountMode === "exact" ? "Exact" : `± ${money(v.config.amountTolerance)}`} />
            <Row k="Fuzzy vendor threshold" v={`${Math.round(v.config.vendorThreshold * 100)}%`} />
            <Row k="Reference matching" v={v.config.referenceMatching ? "On" : "Off"} />
            <Row k="Passes" v={v.config.multiPass ? v.config.passes.map((p) => p.name).join(" → ") : "Single pass"} />
            <Row k="High-value threshold" v={<span className="num">{money(v.config.highValueThreshold)}</span>} />
            <Row k="Approval limit" v={<span className="num">{money(v.config.approvalLimit)}</span>} />
            <Row k="Detectors" v={`${detectorsOn.length} of ${Object.keys(DETECTOR_LABELS).length} enabled`} />
          </dl>
        </section>
      </div>

      <div className="space-y-5">
        <section className="card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4 text-sys" /> Estimated runtime</h2>
          <p className="num text-2xl font-semibold">≈ {minutes}–{minutes + 2} min</p>
          <p className="mt-1 text-xs text-muted-foreground">{rows.toLocaleString()} rows · AI investigation usually takes ~60% of the time. You can leave this page; we'll keep running.</p>
          {settings && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AIBadge /> Est. model cost <span className="num text-foreground">{money(settings.ai.estCostPerRun)}</span> ({settings.ai.defaultModel})
            </p>
          )}
        </section>
        <section className="card border-ai/30 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-ok" /> Privacy</h2>
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor="mask" className="text-sm font-normal leading-snug">Account numbers are masked before AI analysis</Label>
            <Controller control={control} name="maskAccountNumbers" render={({ field }) => <Switch id="mask" checked={field.value} onCheckedChange={field.onChange} />} />
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-2xs text-muted-foreground">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" /> Only unmatched items are sent to the AI agent. Matching itself is deterministic and runs entirely on our servers.
          </p>
        </section>
        <section className="rounded-lg border border-ai/30 bg-ai/5 p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-ai"><Sparkles className="h-3.5 w-3.5" /> How decisions are made</p>
          <p className="mt-1">Deterministic code decides what is true. The AI explains why. Humans decide anything risky — potential fraud and high-value items always come to you.</p>
        </section>
      </div>
    </div>
  );
}
