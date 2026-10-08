import * as React from "react";
import { Controller, useFormContext } from "react-hook-form";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  ScanText,
  Trash2,
  UploadCloud,
  XCircle,
} from "lucide-react";
import type { WizardValues, FileEntry } from "./schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Switch } from "@/components/ui/form-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Segmented } from "@/components/ui/menus";
import { Sheet, SheetContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AmountCell } from "@/components/shared/AmountCell";
import { InfoTip } from "@/components/shared/misc";
import { ACCOUNT_OPTIONS } from "@/lib/accounts";
import { fmtBytes } from "@/lib/format";
import { big, subMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

const CONNECTORS = [
  { id: "tally", label: "Tally Prime (ODBC bridge)" },
  { id: "zoho", label: "Zoho Books API" },
  { id: "quickbooks", label: "QuickBooks Online" },
  { id: "netsuite", label: "Oracle NetSuite" },
];

function Dropzone({
  label,
  hint,
  accept,
  multiple,
  onFiles,
  icon: Icon,
  id,
}: {
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  onFiles: (f: File[]) => void;
  icon: typeof UploadCloud;
  id: string;
}) {
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 sm:py-8 text-center transition-colors",
        over ? "border-sys bg-sys/5" : "border-border hover:border-muted-foreground/50",
      )}
    >
      <Icon className={cn("h-8 w-8", over ? "text-sys" : "text-muted-foreground")} aria-hidden />
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Button variant="secondary" size="sm" className="mt-1" onClick={() => inputRef.current?.click()} aria-describedby={`${id}-hint`}>
        Browse files
      </Button>
      <span id={`${id}-hint`} className="sr-only">{hint}</span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function StatusPill({ entry }: { entry: FileEntry }) {
  if (entry.status === "uploading")
    return (
      <Badge tone="sys">
        <Loader2 className="animate-spin" /> Uploading & parsing…
      </Badge>
    );
  if (entry.status === "error")
    return (
      <Badge tone="crit">
        <XCircle /> Error
      </Badge>
    );
  if (entry.status === "needs_mapping")
    return (
      <Badge tone="warn">
        <AlertTriangle /> Needs column mapping
      </Badge>
    );
  return (
    <Badge tone="ok">
      <CheckCircle2 /> Parsed {entry.result?.rowCount.toLocaleString()} rows
    </Badge>
  );
}

function SanityPanel({ entry }: { entry: FileEntry }) {
  const s = entry.result?.sanity;
  if (!s) return null;
  const diff = subMoney(s.computedClosing, s.closingBalance);
  return (
    <div className={cn("mt-3 rounded-md border p-3 text-xs", s.ok ? "border-ok/30 bg-ok/5" : "border-crit/30 bg-crit/5")} role="group" aria-label="Parsing sanity check">
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        {s.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden /> : <XCircle className="h-3.5 w-3.5 text-crit" aria-hidden />}
        {s.ok ? "Balances reconcile" : "Balance mismatch"}
        <InfoTip>Opening balance + sum of parsed transactions should equal the statement's closing balance. A mismatch usually means rows were missed while parsing.</InfoTip>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
        <dt className="text-muted-foreground">Opening balance</dt>
        <dd><AmountCell value={s.openingBalance} colorize={false} /></dd>
        <dt className="text-muted-foreground">+ Sum of transactions</dt>
        <dd><AmountCell value={s.sumOfTxns} sign="always" /></dd>
        <dt className="text-muted-foreground">= Computed closing</dt>
        <dd><AmountCell value={s.computedClosing} colorize={false} /></dd>
        <dt className="text-muted-foreground">Statement closing</dt>
        <dd><AmountCell value={s.closingBalance} colorize={false} /></dd>
        {!s.ok && (
          <>
            <dt className="font-medium text-crit">Difference</dt>
            <dd><AmountCell value={diff} colorize={false} emphasis="crit" /></dd>
          </>
        )}
      </dl>
      {s.explanation && <p className="mt-2 text-crit/90">{s.explanation}</p>}
    </div>
  );
}

function PreviewSheet({ entry, onClose }: { entry: FileEntry | null; onClose: () => void }) {
  const rows = entry?.result?.previewRows ?? [];
  const cols = entry?.result?.columns ?? [];
  return (
    <Sheet open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width={860} className="p-0">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold">Preview parsed rows</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {entry?.file.name} · first {rows.length} of {entry?.result?.rowCount.toLocaleString()} rows · {entry?.result?.detectedFormat}
          </DialogDescription>
        </div>
        <div className="flex-1 overflow-auto touch-scroll">
          <table className="w-full min-w-[500px] text-xs">
            <caption className="sr-only">First {rows.length} parsed rows</caption>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th scope="col" className="border-b px-3 py-2 text-left text-2xs font-semibold text-muted-foreground">#</th>
                {cols.map((c) => (
                  <th key={c} scope="col" className="whitespace-nowrap border-b px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-surface-2/50">
                  <td className="num border-b border-border/50 px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                  {cols.map((c) => (
                    <td key={c} className="num max-w-[280px] truncate whitespace-nowrap border-b border-border/50 px-3 py-1.5" title={r[c]}>{r[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t px-5 py-3 pb-safe text-right">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FileCard({
  entry,
  onRemove,
  onAccount,
  onPreview,
  onRetryOcr,
  onRetry,
}: {
  entry: FileEntry;
  onRemove: () => void;
  onAccount?: (id: string) => void;
  onPreview: () => void;
  onRetryOcr: () => void;
  onRetry: () => void;
}) {
  const r = entry.result;
  const Icon = /\.pdf$/i.test(entry.file.name) ? FileText : FileSpreadsheet;
  return (
    <li className="rounded-lg border bg-background p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={entry.file.name}>{entry.file.name}</p>
          <p className="text-2xs text-muted-foreground">
            {fmtBytes(entry.file.size)}
            {r && ` · ${r.detectedFormat}`}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill entry={entry} />
            {r && entry.status !== "error" && (
              <Button variant="link" size="xs" className="text-xs" onClick={onPreview}>
                <Eye className="!size-3" /> Preview parsed rows
              </Button>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${entry.file.name}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {onAccount && (
        <div className="mt-3 flex items-center gap-2">
          <Label htmlFor={`acct-${entry.localId}`} className="shrink-0 text-2xs text-muted-foreground">Account</Label>
          <Select value={entry.accountId} onValueChange={onAccount}>
            <SelectTrigger id={`acct-${entry.localId}`} className="h-8 text-xs">
              <SelectValue placeholder="Choose account" />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_OPTIONS.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {entry.status === "error" && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-crit/10 px-3 py-2 text-xs text-crit" role="alert">
          <span>{entry.error}</span>
          <Button size="xs" variant="secondary" onClick={onRetry}><RefreshCw /> Retry</Button>
        </div>
      )}
      {r?.warnings.map((w, i) => (
        <div key={i} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs" role="status">
          <span className="flex items-center gap-1.5 text-warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {w.message}
          </span>
          {w.canRetryOcr && (
            <Button size="xs" variant="secondary" onClick={onRetryOcr} disabled={entry.ocrPending}>
              {entry.ocrPending ? <Loader2 className="animate-spin" /> : <ScanText />} Retry with OCR
            </Button>
          )}
        </div>
      ))}
      {entry.kind === "bank" && <SanityPanel entry={entry} />}
    </li>
  );
}

export function UploadStep({
  files,
  addFiles,
  removeFile,
  setAccount,
  retryOcr,
  retryUpload,
  loadSamples,
}: {
  files: FileEntry[];
  addFiles: (files: File[], kind: "bank" | "ledger") => void;
  removeFile: (id: string) => void;
  setAccount: (id: string, acct: string) => void;
  retryOcr: (id: string) => void;
  retryUpload: (id: string) => void;
  loadSamples: () => void;
}) {
  const { control, register, watch, formState } = useFormContext<WizardValues>();
  const [preview, setPreview] = React.useState<FileEntry | null>(null);
  const ledgerSource = watch("ledgerSource");
  const bank = files.filter((f) => f.kind === "bank");
  const ledger = files.filter((f) => f.kind === "ledger");
  const mismatches = bank.filter((f) => f.result?.sanity && !f.result.sanity.ok).length;

  const card = (f: FileEntry) => (
    <FileCard
      key={f.localId}
      entry={f}
      onRemove={() => removeFile(f.localId)}
      onAccount={f.kind === "bank" ? (a) => setAccount(f.localId, a) : undefined}
      onPreview={() => setPreview(f)}
      onRetryOcr={() => retryOcr(f.localId)}
      onRetry={() => retryUpload(f.localId)}
    />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="period">Statement period</Label>
          <Input id="period" type="month" className="mt-1 w-44" {...register("period")} aria-invalid={!!formState.errors.period} />
        </div>
        <div className="min-w-[240px] flex-1">
          <Label htmlFor="run-name">Run name <span className="text-muted-foreground">(optional)</span></Label>
          <Input id="run-name" className="mt-1" placeholder="e.g. September 2026 — HDFC + ICICI" {...register("name")} />
        </div>
        {files.length === 0 && (
          <Button variant="ai" onClick={loadSamples}>
            <CloudDownload /> Use sample files
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="bank-h" className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="bank-h" className="text-sm font-semibold">Bank statements</h2>
            <span className="text-2xs text-muted-foreground">PDF or CSV · multiple files</span>
          </div>
          <Dropzone id="bank-files" icon={UploadCloud} label="Drop bank statements here" hint="PDF statements are parsed with table detection, with OCR fallback" accept=".pdf,.csv" multiple onFiles={(f) => addFiles(f, "bank")} />
          {bank.length > 0 && <ul className="mt-3 space-y-2" aria-label="Bank statement files">{bank.map(card)}</ul>}
          {mismatches > 0 && (
            <p className="mt-2 text-xs text-crit" role="alert">
              {mismatches} file{mismatches > 1 ? "s have" : " has"} a balance mismatch. You can continue, but missing rows will show up as unmatched ledger items.
            </p>
          )}
        </section>

        <section aria-labelledby="ledger-h" className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="ledger-h" className="text-sm font-semibold">Accounting export</h2>
            <Controller
              control={control}
              name="ledgerSource"
              render={({ field }) => (
                <Segmented label="Ledger source" value={field.value} onChange={field.onChange} options={[{ value: "csv", label: "Upload CSV" }, { value: "api", label: "Pull via API" }]} />
              )}
            />
          </div>
          {ledgerSource === "csv" ? (
            <>
              <Dropzone id="ledger-files" icon={FileSpreadsheet} label="Drop ledger export here" hint="CSV export from Tally, Zoho Books, QuickBooks or NetSuite" accept=".csv,.txt" onFiles={(f) => addFiles(f, "ledger")} />
              {ledger.length > 0 && <ul className="mt-3 space-y-2" aria-label="Ledger files">{ledger.map(card)}</ul>}
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-dashed p-4">
              <div>
                <Label htmlFor="connector">Connector</Label>
                <Controller
                  control={control}
                  name="connector"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="connector" className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONNECTORS.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="api-from">From</Label>
                  <Input id="api-from" type="date" className="mt-1" {...register("apiFrom")} />
                </div>
                <div>
                  <Label htmlFor="api-to">To</Label>
                  <Input id="api-to" type="date" className="mt-1" {...register("apiTo")} />
                </div>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-ok"><CheckCircle2 className="h-3.5 w-3.5" /> Connector authorised · last sync 2 hours ago</p>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Mask account numbers before AI analysis</span>
            <Controller control={control} name="maskAccountNumbers" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Mask account numbers before AI analysis" />} />
          </div>
        </section>
      </div>
      <PreviewSheet entry={preview} onClose={() => setPreview(null)} />
      <VisuallyHidden.Root aria-live="polite">
        {files.filter((f) => f.status === "uploading").length ? "Uploading files" : files.length ? `${files.length} files ready` : ""}
      </VisuallyHidden.Root>
    </div>
  );
}

export function filesReady(files: FileEntry[], ledgerSource: "csv" | "api") {
  const bank = files.filter((f) => f.kind === "bank");
  const ledger = files.filter((f) => f.kind === "ledger");
  const problems: string[] = [];
  if (!bank.length) problems.push("Add at least one bank statement");
  if (bank.some((f) => !f.accountId)) problems.push("Choose an account for every bank statement");
  if (ledgerSource === "csv" && !ledger.length) problems.push("Add the accounting export (or switch to Pull via API)");
  if (files.some((f) => f.status === "uploading")) problems.push("Wait for uploads to finish");
  if (files.some((f) => f.status === "error")) problems.push("Remove or retry files with errors");
  return problems;
}

export const totalRows = (files: FileEntry[]) => files.reduce((a, f) => a + (f.result?.rowCount ?? 0), 0);
export const hasMismatch = (files: FileEntry[]) => files.some((f) => f.result?.sanity && !big(f.result.sanity.computedClosing).eq(f.result.sanity.closingBalance));
