import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { CheckCheck, Clock, Inbox, Play, X } from "lucide-react";
import type { ReviewItem } from "@/api/types";
import { useBulkApprove, useReviewQueue } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, Tip } from "@/components/ui/menus";
import { DataTable } from "@/components/shared/DataTable";
import { AmountCell } from "@/components/shared/AmountCell";
import { RiskMeter } from "@/components/shared/RiskMeter";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { CategoryBadge, StatusBadge } from "@/components/shared/badges";
import { Can, EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/shared/misc";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { SearchInput } from "@/components/shared/filters";
import { useUrlParam } from "@/hooks/useUrlState";
import { fmtPeriod } from "@/lib/format";
import { big, sumMoney } from "@/lib/money";
import { CURRENT_USER } from "@/lib/users";
import { cn } from "@/lib/utils";
import { FocusMode } from "./FocusMode";
import { toast } from "sonner";

const SLA_WARN = 3;
const SLA_BREACH = 7;
const OPEN = ["open", "in_review", "escalated"];

type Tab = "mine" | "unassigned" | "escalated" | "done";

function inTab(i: ReviewItem, tab: Tab) {
  const s = i.finding.status;
  if (tab === "done") return s === "approved" || s === "rejected";
  if (tab === "escalated") return s === "escalated";
  if (!OPEN.includes(s) || s === "escalated") return false;
  return tab === "mine" ? i.finding.assignee === CURRENT_USER : !i.finding.assignee;
}

/** Low-risk items eligible for bulk approval: never fraud, never high-value. */
export const bulkEligible = (i: ReviewItem) =>
  i.finding.riskScore < 0.7 && i.finding.category !== "potential_fraud" && big(i.finding.txn.amount).abs().lt("500000") && OPEN.includes(i.finding.status);

function Sla({ days }: { days: number }) {
  if (days < SLA_WARN) return <span className="num text-xs text-muted-foreground">{days}d</span>;
  const breach = days >= SLA_BREACH;
  return (
    <Tip content={breach ? `Waiting ${days} days — SLA of ${SLA_BREACH} days breached` : `Waiting ${days} days — approaching the ${SLA_BREACH}-day SLA`}>
      <Badge tone={breach ? "crit" : "warn"} tabIndex={0}>
        <Clock aria-hidden /> {days}d{breach && " · SLA"}
      </Badge>
    </Tip>
  );
}

function MobileCard({ item, onOpen }: { item: ReviewItem; onOpen: () => void }) {
  const f = item.finding;
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full space-y-2 border-b px-4 py-3 text-left hover:bg-surface-2/50">
        <div className="flex items-center justify-between gap-2">
          <CategoryBadge category={f.humanCategory ?? f.category} />
          <Sla days={item.waitingDays} />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{f.txn.vendorNorm}</p>
            <p className="num text-2xs text-muted-foreground">{f.id} · {item.routingReason}</p>
          </div>
          <AmountCell value={f.txn.amount} className="text-sm" />
        </div>
        <div className="flex items-center justify-between">
          <RiskMeter score={f.riskScore} size="sm" />
          <StatusBadge status={f.status} />
        </div>
      </button>
    </li>
  );
}

export default function ReviewQueuePage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useReviewQueue();
  const bulk = useBulkApprove();
  const [tab, setTab] = useUrlParam("rtab", "mine");
  const [q, setQ] = useUrlParam("q");
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [confirm, setConfirm] = useState(false);
  const [focus, setFocus] = useState<ReviewItem[] | null>(null);

  const counts = useMemo(() => {
    const c = { mine: 0, unassigned: 0, escalated: 0, done: 0 } as Record<Tab, number>;
    data?.forEach((i) => (["mine", "unassigned", "escalated", "done"] as Tab[]).forEach((t) => inTab(i, t) && c[t]++));
    return c;
  }, [data]);

  const items = useMemo(() => {
    const ql = q.toLowerCase();
    return data?.filter((i) => inTab(i, tab as Tab) && (!ql || `${i.finding.id} ${i.finding.txn.vendorNorm} ${i.finding.txn.descriptionRaw} ${i.routingReason}`.toLowerCase().includes(ql)));
  }, [data, tab, q]);

  const open = (i: ReviewItem) => navigate(`/runs/${i.finding.runId}?tab=anomalies&finding=${i.finding.id}`);
  const selected = (data ?? []).filter((i) => selection[i.finding.id]);

  const columns = useMemo<ColumnDef<ReviewItem>[]>(
    () => [
      { id: "priority", accessorKey: "priority", header: "Priority", meta: { label: "Priority", align: "right" }, cell: ({ row }) => <span className="num text-xs font-semibold">{row.original.priority.toFixed(2)}</span> },
      { id: "risk", accessorFn: (i) => i.finding.riskScore, header: "Risk", meta: { label: "Risk" }, cell: ({ row }) => <RiskMeter score={row.original.finding.riskScore} /> },
      { id: "category", accessorFn: (i) => i.finding.humanCategory ?? i.finding.category, header: "Category", meta: { label: "Category" }, cell: ({ row }) => <CategoryBadge category={row.original.finding.humanCategory ?? row.original.finding.category} /> },
      {
        id: "txn",
        accessorFn: (i) => i.finding.txn.vendorNorm,
        header: "Transaction",
        meta: { label: "Transaction" },
        cell: ({ row }) => {
          const f = row.original.finding;
          return (
            <div className="min-w-0 max-w-[280px]">
              <div className="truncate text-sm font-medium" title={f.txn.descriptionRaw}>{f.txn.vendorNorm}</div>
              <div className="num truncate text-2xs text-muted-foreground">{f.id} · {fmtPeriod(f.runPeriod)}</div>
            </div>
          );
        },
      },
      { id: "amount", accessorFn: (i) => Math.abs(Number(i.finding.txn.amount)), header: "Amount", meta: { label: "Amount", align: "right" }, cell: ({ row }) => <AmountCell value={row.original.finding.txn.amount} /> },
      { id: "reason", accessorKey: "routingReason", header: "Routing reason", meta: { label: "Routing reason" }, cell: ({ row }) => <Badge tone={row.original.routingReason === "Potential fraud" ? "crit" : row.original.routingReason === "High value" ? "attn" : "neutral"}>{row.original.routingReason}</Badge> },
      { id: "confidence", accessorFn: (i) => i.finding.confidence, header: "AI conf.", meta: { label: "AI confidence" }, cell: ({ row }) => <ConfidenceBar value={row.original.finding.confidence} variant="ai" label="AI confidence" width="w-12" /> },
      { id: "waiting", accessorKey: "waitingDays", header: "Waiting", meta: { label: "Waiting" }, cell: ({ row }) => <Sla days={row.original.waitingDays} /> },
      { id: "status", accessorFn: (i) => i.finding.status, header: "Status", meta: { label: "Status" }, cell: ({ row }) => <StatusBadge status={row.original.finding.status} /> },
      { id: "assignee", accessorFn: (i) => i.finding.assignee ?? "", header: "Assignee", meta: { label: "Assignee" }, cell: ({ row }) => <span className="whitespace-nowrap text-xs">{row.original.finding.assignee ?? <span className="text-muted-foreground">—</span>}</span> },
    ],
    [],
  );

  const openItems = (items ?? []).filter((i) => OPEN.includes(i.finding.status));

  return (
    <div>
      <PageHeader
        title="Review queue"
        breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Review queue" }]}
        description="Items the agent routed to a human, across all runs — sorted by risk × amount."
        actions={
          <Button onClick={() => setFocus(openItems)} disabled={!openItems.length}>
            <Play /> Focus mode{openItems.length ? ` (${openItems.length})` : ""}
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => { setTab(v); setSelection({}); }}>
        <TabsList aria-label="Queue views" className="mb-3">
          <TabsTrigger value="mine">Assigned to me <span className="num text-2xs text-muted-foreground">{counts.mine}</span></TabsTrigger>
          <TabsTrigger value="unassigned">Unassigned <span className="num text-2xs text-muted-foreground">{counts.unassigned}</span></TabsTrigger>
          <TabsTrigger value="escalated">Escalated <span className="num text-2xs text-crit">{counts.escalated}</span></TabsTrigger>
          <TabsTrigger value="done">Done <span className="num text-2xs text-muted-foreground">{counts.done}</span></TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="card overflow-hidden">
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-ok/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
            <span className="font-medium">{selected.length} low-risk items selected</span>
            <Can perm="finding.decide">
              <Button size="xs" variant="success" onClick={() => setConfirm(true)}>
                <CheckCheck /> Approve selected
              </Button>
            </Can>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSelection({})}><X /> Clear</Button>
          </div>
        )}

        {/* Mobile: cards */}
        <div className="md:hidden">
          <div className="border-b p-3"><SearchInput value={q} onChange={setQ} placeholder="Search queue…" className="w-full" /></div>
          {isLoading ? <SkeletonRows rows={5} cols={2} /> : error ? <ErrorState error={error} onRetry={() => refetch()} /> : items?.length ? (
            <ul aria-label="Review items">{items.map((i) => <MobileCard key={i.finding.id} item={i} onOpen={() => open(i)} />)}</ul>
          ) : (
            <EmptyState icon={Inbox} title={q ? "No results" : "Nothing here"} description={tab === "mine" ? "You're all caught up." : undefined} />
          )}
        </div>

        {/* Desktop/tablet: table */}
        <div className="hidden md:block">
          <DataTable
            ariaLabel="Review queue"
            data={items}
            columns={columns}
            getRowId={(i) => i.finding.id}
            isLoading={isLoading}
            error={error}
            onRetry={() => refetch()}
            onRowClick={open}
            rowSelection={tab === "done" || tab === "escalated" ? undefined : selection}
            onRowSelectionChange={tab === "done" || tab === "escalated" ? undefined : setSelection}
            canSelectRow={bulkEligible}
            urlKey="rq_"
            defaultSort={[{ id: "priority", desc: true }]}
            isFiltered={!!q}
            onClearFilters={() => setQ("")}
            rowClassName={(i) => cn(i.waitingDays >= SLA_BREACH && OPEN.includes(i.finding.status) && "bg-crit/[0.03]")}
            emptyState={
              <EmptyState
                icon={Inbox}
                title={tab === "mine" ? "You're all caught up" : tab === "done" ? "No decisions yet" : "Nothing here"}
                description={tab === "mine" ? "New items appear here when the agent routes them to you." : undefined}
              />
            }
            toolbar={
              <>
                <SearchInput value={q} onChange={setQ} placeholder="Search queue…" label="Search review queue" />
                {tab !== "done" && tab !== "escalated" && <span className="text-2xs text-muted-foreground">Checkboxes appear on low-risk items eligible for bulk approval.</span>}
              </>
            }
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Approve ${selected.length} low-risk findings?`}
        description="The AI classification will be accepted for each item. Potential-fraud and high-value items are never included in bulk approvals."
        confirmLabel={`Approve ${selected.length}`}
        tone="success"
        pending={bulk.isPending}
        onConfirm={async () => {
          const r = await bulk.mutateAsync(selected.map((i) => i.finding.id));
          toast.success(`Approved ${r.updated} findings`);
          setSelection({});
          setConfirm(false);
        }}
      >
        <div className="space-y-1 rounded-md border p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Items</span><span className="num">{selected.length}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Total amount</span><AmountCell value={sumMoney(selected.map((i) => big(i.finding.txn.amount).abs().toFixed(2)))} colorize={false} /></div>
          <div className="flex flex-wrap gap-1 pt-1">
            {[...new Set(selected.map((i) => i.finding.humanCategory ?? i.finding.category))].map((c) => <CategoryBadge key={c} category={c} />)}
          </div>
        </div>
      </ConfirmDialog>

      {focus && <FocusMode items={focus} onExit={() => { setFocus(null); refetch(); }} />}
    </div>
  );
}
