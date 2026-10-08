import { memo, useMemo, useState } from "react";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { CheckCircle2, ChevronRight, GitMerge, Link2, Unlink, X } from "lucide-react";
import type { MatchPairView, Run } from "@/api/types";
import { useMatches, useUnmatch } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/menus";
import { DataTable } from "@/components/shared/DataTable";
import { AmountCell } from "@/components/shared/AmountCell";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { Can, EmptyState, VendorCell } from "@/components/shared/misc";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { MultiFilter, RangeFilter, SearchInput } from "@/components/shared/filters";
import { useUrlList, useUrlParam, useUrlRange } from "@/hooks/useUrlState";
import { fmtDate } from "@/lib/format";
import { isZero, sumMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useSearchParams } from "react-router-dom";

const MAX = { amount: 0.45, date: 0.15, vendor: 0.25, reference: 0.15 };
const LABEL = { amount: "Amount", date: "Date", vendor: "Vendor", reference: "Reference" };

function passTone(p: string) {
  if (p === "Manual") return "ok" as const;
  if (p.startsWith("P5")) return "warn" as const;
  if (p.startsWith("P3")) return "attn" as const;
  return "sys" as const;
}

const ScoreBreakdown = memo(function ScoreBreakdown({ pair }: { pair: MatchPairView }) {
  const keys = Object.keys(MAX) as (keyof typeof MAX)[];
  const bankSum = sumMoney(pair.bank.map((t) => t.amount));
  const ledgerSum = sumMoney(pair.ledger.map((t) => t.amount));
  const group = pair.bank.length > 1 || pair.ledger.length > 1;
  return (
    <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
      <div>
        <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Score breakdown · {Math.round(pair.score * 100)}%</h4>
        <ul className="space-y-1.5" aria-label="Score contributions">
          {keys.map((k) => {
            const v = pair.breakdown[k];
            return (
              <li key={k} className="grid grid-cols-[72px_1fr_64px] items-center gap-2 text-xs">
                <span className="text-muted-foreground">{LABEL[k]}</span>
                <div className="relative h-2 rounded-full bg-border" aria-hidden>
                  <div className="absolute inset-y-0 left-0 rounded-full bg-sys" style={{ width: `${(v / MAX[k]) * 100}%` }} />
                </div>
                <span className="num text-right">
                  +{(v * 100).toFixed(1)} <span className="text-muted-foreground">/ {MAX[k] * 100}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {pair.note && <p className="mt-2 rounded bg-surface-2 px-2 py-1 text-xs"><span className="text-muted-foreground">Note:</span> {pair.note}{pair.createdBy && ` — ${pair.createdBy}`}</p>}
      </div>
      <div>
        <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {group ? `Group: ${pair.bank.length} bank ↔ ${pair.ledger.length} ledger` : "Sides"}
        </h4>
        <div className="max-h-56 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <caption className="sr-only">Transactions in this match</caption>
            <tbody>
              {[...pair.bank, ...pair.ledger].map((t) => (
                <tr key={t.id} className="border-b border-border/50 last:border-0">
                  <td className="px-2 py-1"><span className="rounded bg-surface-2 px-1 text-[10px] uppercase text-muted-foreground">{t.source}</span></td>
                  <td className="num px-2 py-1 text-muted-foreground">{t.id}</td>
                  <td className="num whitespace-nowrap px-2 py-1">{fmtDate(t.date)}</td>
                  <td className="max-w-[220px] truncate px-2 py-1" title={t.descriptionRaw}>{t.source === "ledger" ? t.descriptionRaw : t.vendorNorm}</td>
                  <td className="px-2 py-1 text-right"><AmountCell value={t.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={cn("mt-2 flex items-center justify-between rounded-md px-2 py-1 text-xs", isZero(pair.amountDiff) ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn")}>
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Sum check: Σ bank <AmountCell value={bankSum} colorize={false} className="mx-1" /> − Σ ledger <AmountCell value={ledgerSum} colorize={false} className="mx-1" />
          </span>
          <span>{isZero(pair.amountDiff) ? "= 0 ✓" : <>= <AmountCell value={pair.amountDiff} colorize={false} sign="always" /> (within tolerance)</>}</span>
        </div>
      </div>
    </div>
  );
});

export function MatchedTab({ run }: { run: Run }) {
  const { data, isLoading, error, refetch } = useMatches(run.id, run);
  const unmatch = useUnmatch(run.id);
  const [q, setQ] = useUrlParam("q");
  const [passes, setPasses] = useUrlList("pass");
  const [conf, setConf] = useUrlRange("conf", 50, 100);
  const [kind, setKind] = useUrlList("mtype");
  const [, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [toUnmatch, setToUnmatch] = useState<MatchPairView[] | null>(null);

  const passOptions = useMemo(() => {
    const m = new Map<string, number>();
    data?.forEach((p) => m.set(p.passName, (m.get(p.passName) ?? 0) + 1));
    return [...m.entries()].sort().map(([value, count]) => ({ value, label: value, count }));
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return undefined;
    const ql = q.toLowerCase();
    return data.filter((p) => {
      const s = p.score * 100;
      if (s < conf[0] || s > conf[1]) return false;
      if (passes.length && !passes.includes(p.passName)) return false;
      if (kind.length) {
        const k = p.bank.length > 1 || p.ledger.length > 1 ? "group" : p.status === "manual" ? "manual" : "single";
        if (!kind.includes(k)) return false;
      }
      if (ql) {
        const hay = [...p.bank, ...p.ledger].map((t) => `${t.id} ${t.descriptionRaw} ${t.vendorNorm} ${t.reference ?? ""}`).join(" ").toLowerCase();
        if (!hay.includes(ql) && !p.id.toLowerCase().includes(ql)) return false;
      }
      return true;
    });
  }, [data, q, passes, conf, kind]);
  const isFiltered = !!q || passes.length > 0 || kind.length > 0 || conf[0] !== 50 || conf[1] !== 100;

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const columns = useMemo<ColumnDef<MatchPairView>[]>(
    () => [
      {
        id: "_x",
        enableSorting: false,
        enableHiding: false,
        size: 32,
        header: () => <span className="sr-only">Expand</span>,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle(row.id);
            }}
            aria-expanded={expanded.has(row.id)}
            aria-label={`${expanded.has(row.id) ? "Collapse" : "Expand"} ${row.id} details`}
            className="rounded p-0.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          >
            <ChevronRight className={cn("h-4 w-4 transition-transform", expanded.has(row.id) && "rotate-90")} />
          </button>
        ),
      },
      { id: "score", accessorKey: "score", header: "Confidence", meta: { label: "Confidence" }, cell: ({ row }) => <ConfidenceBar value={row.original.score} label="Match confidence" /> },
      { id: "pass", accessorKey: "passName", header: "Pass", meta: { label: "Pass" }, cell: ({ row }) => <Badge tone={passTone(row.original.passName)}>{row.original.passName}</Badge> },
      { id: "bankDate", accessorFn: (p) => p.bank[0].date, header: "Bank date", meta: { label: "Bank date", className: "bg-sys/[0.02]" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs">{fmtDate(row.original.bank[0].date)}</span> },
      {
        id: "bankVendor",
        accessorFn: (p) => p.bank[0].vendorNorm,
        header: "Bank description",
        meta: { label: "Bank description", className: "bg-sys/[0.02]" },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <VendorCell raw={row.original.bank[0].descriptionRaw} normalized={row.original.bank[0].vendorNorm} maxWidth="max-w-[220px]" />
            {row.original.bank.length > 1 && <Badge tone="neutral">+{row.original.bank.length - 1}</Badge>}
          </div>
        ),
      },
      { id: "bankAmount", accessorFn: (p) => Number(sumMoney(p.bank.map((t) => t.amount))), header: "Bank amount", meta: { label: "Bank amount", align: "right", className: "bg-sys/[0.02]" }, cell: ({ row }) => <AmountCell value={sumMoney(row.original.bank.map((t) => t.amount))} /> },
      {
        id: "link",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Link</span>,
        cell: ({ row }) => (
          <Tip content={`${row.original.passName} · ${Math.round(row.original.score * 100)}% · ${row.original.status === "manual" ? "manual" : "auto"} match`}>
            <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full border", row.original.status === "manual" ? "border-ok/40 text-ok" : "border-sys/40 text-sys")} aria-label="Matched">
              <Link2 className="h-3 w-3" />
            </span>
          </Tip>
        ),
      },
      { id: "ledgerDate", accessorFn: (p) => p.ledger[0].date, header: "Ledger date", meta: { label: "Ledger date" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs">{fmtDate(row.original.ledger[0].date)}</span> },
      {
        id: "ledgerVendor",
        accessorFn: (p) => p.ledger[0].vendorNorm,
        header: "Ledger vendor / GL",
        meta: { label: "Ledger vendor" },
        cell: ({ row }) => {
          const l = row.original.ledger;
          return (
            <div className="min-w-0 max-w-[220px]">
              <div className="truncate text-sm">{l.length > 1 ? `${l.length} entries · ${l[0].vendorNorm}` : l[0].vendorNorm}</div>
              <div className="num truncate text-2xs text-muted-foreground">{l[0].glCode} · {l.length > 1 ? `${l[0].reference} …` : l[0].reference}</div>
            </div>
          );
        },
      },
      { id: "ledgerAmount", accessorFn: (p) => Number(sumMoney(p.ledger.map((t) => t.amount))), header: "Ledger amount", meta: { label: "Ledger amount", align: "right" }, cell: ({ row }) => <AmountCell value={sumMoney(row.original.ledger.map((t) => t.amount))} /> },
      { id: "dateDiff", accessorKey: "dateDiffDays", header: "Δ Date", meta: { label: "Date difference", align: "right" }, cell: ({ row }) => { const d = row.original.dateDiffDays; return <span className={cn("num text-xs", d === 0 ? "text-muted-foreground" : Math.abs(d) > 2 ? "text-warn" : "")}>{d === 0 ? "0d" : `${d > 0 ? "+" : ""}${d}d`}</span>; } },
      { id: "vendorSim", accessorKey: "vendorSimilarity", header: "Vendor sim.", meta: { label: "Vendor similarity", align: "right" }, cell: ({ row }) => <span className={cn("num text-xs", row.original.vendorSimilarity < 0.8 && "text-attn")}>{Math.round(row.original.vendorSimilarity * 100)}%</span> },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <Can perm="match.unmatch" mode="hide">
            <Button variant="ghost" size="icon-sm" aria-label={`Unmatch ${row.original.id}`} onClick={(e) => { e.stopPropagation(); setToUnmatch([row.original]); }} disabled={run.status === "completed"}>
              <Unlink />
            </Button>
          </Can>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded, run.status],
  );

  const selected = (data ?? []).filter((p) => selection[p.id]);

  return (
    <div className="card overflow-hidden">
      {selected.length > 0 && (
        <div className="flex items-center gap-2 border-b bg-sys/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.length} pairs selected</span>
          <Can perm="match.unmatch">
            <Button size="xs" variant="secondary" onClick={() => setToUnmatch(selected)} disabled={run.status === "completed"}>
              <Unlink /> Unmatch selected
            </Button>
          </Can>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSelection({})}><X /> Clear</Button>
        </div>
      )}
      <DataTable
        ariaLabel="Matched pairs"
        data={filtered}
        columns={columns}
        getRowId={(p) => p.id}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        onRowClick={(p) => toggle(p.id)}
        renderExpanded={(p) => <ScoreBreakdown pair={p} />}
        expandedIds={expanded}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        urlKey="m_"
        defaultSort={[{ id: "score", desc: false }]}
        isFiltered={isFiltered}
        onClearFilters={() => setParams((p) => { ["q", "pass", "conf", "mtype"].forEach((k) => p.delete(k)); return p; }, { replace: true })}
        emptyState={<EmptyState icon={GitMerge} title="No matched pairs" description="Nothing was matched in this run. Check the matching rules or re-run with relaxed tolerances." />}
        rowClassName={(p) => (p.score < 0.9 ? "bg-warn/[0.03]" : undefined)}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Vendor, narration, txn ID…" label="Search matched pairs" />
            <MultiFilter label="Pass" value={passes} onChange={setPasses} options={passOptions} />
            <RangeFilter label="Confidence" min={50} max={100} step={1} value={conf} onChange={setConf} format={(n) => `${n}%`} />
            <MultiFilter label="Type" value={kind} onChange={setKind} options={[{ value: "single", label: "1 : 1" }, { value: "group", label: "1 : N / N : 1 groups" }, { value: "manual", label: "Manual" }]} />
          </>
        }
      />
      <ConfirmDialog
        open={!!toUnmatch}
        onOpenChange={(o) => !o && setToUnmatch(null)}
        title={toUnmatch && toUnmatch.length > 1 ? `Unmatch ${toUnmatch.length} pairs?` : `Unmatch ${toUnmatch?.[0]?.id}?`}
        description="Both sides move back to Unmatched and will need to be matched or explained again. Unexplained difference may increase."
        confirmLabel="Unmatch"
        tone="destructive"
        requireReason={5}
        pending={unmatch.isPending}
        onConfirm={async (reason) => {
          for (const p of toUnmatch ?? []) await unmatch.mutateAsync({ pairId: p.id, reason });
          setSelection({});
          setToUnmatch(null);
        }}
      >
        {toUnmatch && (
          <div className="max-h-40 overflow-y-auto rounded-md border text-xs">
            {toUnmatch.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 last:border-0">
                <span className="num text-muted-foreground">{p.id}</span>
                <span className="flex-1 truncate">{p.bank[0].vendorNorm}</span>
                <AmountCell value={sumMoney(p.bank.map((t) => t.amount))} />
              </div>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
