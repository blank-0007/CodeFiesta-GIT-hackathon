import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { ShieldCheck } from "lucide-react";
import type { FindingView, Run } from "@/api/types";
import { useFindings } from "@/api/queries";
import { DataTable } from "@/components/shared/DataTable";
import { AmountCell, useMoneyFormatter } from "@/components/shared/AmountCell";
import { RiskMeter } from "@/components/shared/RiskMeter";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { AIBadge, CATEGORIES, CATEGORY_META, CategoryBadge, FINDING_STATUSES, StatusBadge, findingStatusLabel } from "@/components/shared/badges";
import { EmptyState } from "@/components/shared/misc";
import { MultiFilter, RangeFilter, SearchInput } from "@/components/shared/filters";
import { useUrlList, useUrlParam, useUrlRange } from "@/hooks/useUrlState";
import { fmtDate } from "@/lib/format";
import { big } from "@/lib/money";
import { FindingDrawer } from "./FindingDrawer";

const AMOUNT_STEPS = [0, 1000, 10000, 50000, 100000, 500000, 1000000];

export function AnomaliesTab({ run }: { run: Run }) {
  const { data, isLoading, error, refetch } = useFindings(run.id, run);
  const money = useMoneyFormatter();
  const [cats, setCats] = useUrlList("cat");
  const [statuses, setStatuses] = useUrlList("fstatus");
  const [risk, setRisk] = useUrlRange("risk", 0, 100);
  const [amt, setAmt] = useUrlRange("amt", 0, AMOUNT_STEPS.length - 1);
  const [vq, setVq] = useUrlParam("vq");
  const [finding, setFinding] = useUrlParam("finding");
  const [, setParams] = useSearchParams();

  const filtered = useMemo(() => {
    if (!data) return undefined;
    const ql = vq.toLowerCase();
    const lo = AMOUNT_STEPS[amt[0]];
    const hi = amt[1] === AMOUNT_STEPS.length - 1 ? Infinity : AMOUNT_STEPS[amt[1]];
    return data.filter((f) => {
      const a = Number(big(f.txn.amount).abs().toFixed(0));
      return (
        (!cats.length || cats.includes(f.humanCategory ?? f.category)) &&
        (!statuses.length || statuses.includes(f.status)) &&
        f.riskScore * 100 >= risk[0] &&
        f.riskScore * 100 <= risk[1] &&
        a >= lo &&
        a <= hi &&
        (!ql || `${f.txn.vendorNorm} ${f.txn.descriptionRaw} ${f.id} ${f.txnId}`.toLowerCase().includes(ql))
      );
    });
  }, [data, cats, statuses, risk, amt, vq]);
  const isFiltered = cats.length > 0 || statuses.length > 0 || risk[0] !== 0 || risk[1] !== 100 || amt[0] !== 0 || amt[1] !== AMOUNT_STEPS.length - 1 || !!vq;

  // Drawer navigation follows the visible order (risk desc).
  const ids = useMemo(() => [...(filtered ?? [])].sort((a, b) => b.riskScore - a.riskScore).map((f) => f.id), [filtered]);

  const columns = useMemo<ColumnDef<FindingView>[]>(
    () => [
      { id: "risk", accessorKey: "riskScore", header: "Risk", meta: { label: "Risk" }, cell: ({ row }) => <RiskMeter score={row.original.riskScore} /> },
      { id: "category", accessorFn: (f) => f.humanCategory ?? f.category, header: "Category", meta: { label: "Category" }, cell: ({ row }) => <CategoryBadge category={row.original.humanCategory ?? row.original.category} /> },
      {
        id: "txn",
        accessorFn: (f) => f.txn.vendorNorm,
        header: "Transaction",
        meta: { label: "Transaction" },
        cell: ({ row }) => {
          const f = row.original;
          return (
            <div className="min-w-0 max-w-[300px]">
              <div className="truncate text-sm font-medium" title={f.txn.descriptionRaw}>{f.txn.vendorNorm}</div>
              <div className="num truncate text-2xs text-muted-foreground">
                {f.id} · {f.txn.source} · {fmtDate(f.txn.date)}
              </div>
            </div>
          );
        },
      },
      { id: "amount", accessorFn: (f) => Math.abs(Number(f.txn.amount)), header: "Amount", meta: { label: "Amount", align: "right" }, cell: ({ row }) => <AmountCell value={row.original.txn.amount} /> },
      {
        id: "confidence",
        accessorKey: "confidence",
        header: "AI confidence",
        meta: { label: "AI confidence" },
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <AIBadge label="" className="px-1" />
            <ConfidenceBar value={row.original.confidence} variant="ai" label="AI confidence" width="w-12" />
          </span>
        ),
      },
      { id: "status", accessorKey: "status", header: "Status", meta: { label: "Status" }, cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { id: "assignee", accessorFn: (f) => f.assignee ?? "", header: "Assignee", meta: { label: "Assignee" }, cell: ({ row }) => <span className="whitespace-nowrap text-xs">{row.original.assignee ?? <span className="text-muted-foreground">Unassigned</span>}</span> },
      { id: "routing", accessorFn: (f) => f.routingReason ?? "Auto", header: "Routing", meta: { label: "Routing reason" }, cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{row.original.routing === "auto_resolve" ? "Auto-resolve" : row.original.routingReason}</span> },
    ],
    [],
  );

  return (
    <div className="card overflow-hidden">
      <DataTable
        ariaLabel="Anomaly findings"
        data={filtered}
        columns={columns}
        getRowId={(f) => f.id}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        onRowClick={(f) => setFinding(f.id)}
        activeRowId={finding || undefined}
        urlKey="f_"
        defaultSort={[{ id: "risk", desc: true }]}
        isFiltered={isFiltered}
        onClearFilters={() => setParams((p) => { ["cat", "fstatus", "risk", "amt", "vq"].forEach((k) => p.delete(k)); return p; }, { replace: true })}
        emptyState={<EmptyState icon={ShieldCheck} title="No anomalies in this run" description="Every unmatched item was explained automatically, or everything matched." />}
        rowClassName={(f) => (f.category === "potential_fraud" && ["open", "in_review", "escalated"].includes(f.status) ? "bg-crit/[0.04]" : undefined)}
        toolbar={
          <>
            <SearchInput value={vq} onChange={setVq} placeholder="Vendor, narration, ID…" label="Search findings" />
            <MultiFilter label="Category" value={cats} onChange={setCats} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label, count: data?.filter((f) => (f.humanCategory ?? f.category) === c).length }))} />
            <MultiFilter label="Status" value={statuses} onChange={setStatuses} options={FINDING_STATUSES.map((s) => ({ value: s, label: findingStatusLabel(s), count: data?.filter((f) => f.status === s).length }))} />
            <RangeFilter label="Risk" min={0} max={100} step={5} value={risk} onChange={setRisk} />
            <RangeFilter
              label="Amount"
              min={0}
              max={AMOUNT_STEPS.length - 1}
              step={1}
              value={amt}
              onChange={setAmt}
              format={(i) => (i === AMOUNT_STEPS.length - 1 ? "max" : money(String(AMOUNT_STEPS[i]), { compact: true }))}
            />
          </>
        }
      />
      <FindingDrawer findingId={finding || null} runId={run.id} ids={ids} onChange={(id) => setFinding(id ?? "")} />
    </div>
  );
}
