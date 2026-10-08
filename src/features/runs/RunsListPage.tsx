import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Archive, Download, Play, Plus, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Run } from "@/api/types";
import { api, qk } from "@/api/endpoints";
import { toastError, useRuns } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input, Label, Switch } from "@/components/ui/form-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { DataTable } from "@/components/shared/DataTable";
import { Can, EmptyState, PageHeader } from "@/components/shared/misc";
import { StatusBadge } from "@/components/shared/badges";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { MultiFilter, SearchInput } from "@/components/shared/filters";
import { Progress } from "@/components/ui/form-controls";
import { useUrlList, useUrlParam } from "@/hooks/useUrlState";
import { fmtDateTime, fmtDuration, fmtPeriod } from "@/lib/format";
import { ACCOUNT_LABEL, ACCOUNT_OPTIONS } from "@/lib/accounts";
import { downloadBlob, toCsv } from "@/lib/utils";

const STATUSES: Run["status"][] = ["running", "awaiting_review", "completed", "failed", "queued"];
const STATUS_LABEL: Record<Run["status"], string> = { running: "Running", awaiting_review: "Awaiting review", completed: "Completed", failed: "Failed", queued: "Queued" };

export default function RunsListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useRuns();
  const [status, setStatus] = useUrlList("status");
  const [account, setAccount] = useUrlParam("account", "all");
  const [from, setFrom] = useUrlParam("from");
  const [to, setTo] = useUrlParam("to");
  const [q, setQ] = useUrlParam("q");
  const [archived, setArchived] = useUrlParam("archived");
  const [, setParams] = useSearchParams();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [confirmArchive, setConfirmArchive] = useState(false);

  const archive = useMutation({
    mutationFn: api.archiveRuns,
    onSuccess: (r) => {
      toast.success(`Archived ${r.archived} run${r.archived === 1 ? "" : "s"}`);
      setSelection({});
      qc.invalidateQueries({ queryKey: qk.runs });
    },
    onError: (e) => toastError(e, "Archive failed"),
  });

  const filtered = useMemo(() => {
    if (!data) return undefined;
    const ql = q.toLowerCase();
    return data.filter(
      (r) =>
        (archived === "1" || !r.archived) &&
        (!status.length || status.includes(r.status)) &&
        (account === "all" || r.accounts.includes(account)) &&
        (!from || r.createdAt.slice(0, 10) >= from) &&
        (!to || r.createdAt.slice(0, 10) <= to) &&
        (!ql || `${r.id} ${r.name} ${r.createdBy}`.toLowerCase().includes(ql)),
    );
  }, [data, status, account, from, to, q, archived]);
  const isFiltered = status.length > 0 || account !== "all" || !!from || !!to || !!q;

  const columns = useMemo<ColumnDef<Run>[]>(
    () => [
      { accessorKey: "id", header: "Run ID", meta: { label: "Run ID" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs">{row.original.id}</span> },
      { accessorKey: "period", header: "Period", meta: { label: "Period" }, cell: ({ row }) => <span className="whitespace-nowrap font-medium">{fmtPeriod(row.original.period)}</span> },
      { id: "accounts", header: "Accounts", enableSorting: false, meta: { label: "Accounts" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{row.original.accounts.map((a) => ACCOUNT_LABEL[a] ?? a).join(" · ")}</span> },
      { accessorKey: "status", header: "Status", meta: { label: "Status" }, cell: ({ row }) => <span className="flex items-center gap-1.5"><StatusBadge status={row.original.status} />{row.original.archived && <StatusBadge status="archived" />}</span> },
      { id: "rate", accessorFn: (r) => r.stats.autoMatchRate, header: "Match rate", meta: { label: "Match rate", align: "right" }, cell: ({ row }) => (row.original.stats.bankCount ? <ConfidenceBar value={row.original.stats.autoMatchRate} label="Auto-match rate" /> : <span className="text-muted-foreground">—</span>) },
      { id: "matched", accessorFn: (r) => r.stats.matched, header: "Matched", meta: { label: "Matched", align: "right" }, cell: ({ getValue }) => <span className="num text-sys">{getValue<number>()}</span> },
      { id: "unmatched", accessorFn: (r) => r.stats.unmatchedBank + r.stats.unmatchedLedger, header: "Unmatched", meta: { label: "Unmatched", align: "right" }, cell: ({ getValue }) => <span className="num text-attn">{getValue<number>()}</span> },
      { id: "anomalies", accessorFn: (r) => r.stats.anomalies, header: "Anomalies", meta: { label: "Anomalies", align: "right" }, cell: ({ getValue }) => <span className="num">{getValue<number>()}</span> },
      {
        id: "review",
        accessorFn: (r) => (r.review.total ? r.review.resolved / r.review.total : 1),
        header: "Reviewed",
        meta: { label: "Reviewer progress" },
        cell: ({ row }) => {
          const { resolved, total } = row.original.review;
          if (!total) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex w-28 items-center gap-2" aria-label={`${resolved} of ${total} reviews resolved`}>
              <Progress value={(resolved / total) * 100} indicatorClassName={resolved === total ? "bg-ok" : "bg-warn"} />
              <span className="num text-2xs text-muted-foreground">{resolved}/{total}</span>
            </div>
          );
        },
      },
      { accessorKey: "createdAt", header: "Created", meta: { label: "Created at" }, cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span> },
      { id: "duration", accessorFn: (r) => r.durationMs ?? 0, header: "Duration", meta: { label: "Duration", align: "right" }, cell: ({ row }) => <span className="num text-xs text-muted-foreground">{fmtDuration(row.original.durationMs)}</span> },
    ],
    [],
  );

  const selectedRuns = (data ?? []).filter((r) => selection[r.id]);
  const exportSelected = () => {
    downloadBlob(
      toCsv(
        selectedRuns.map((r) => ({
          run_id: r.id,
          period: r.period,
          status: r.status,
          accounts: r.accounts.join(" "),
          auto_match_rate: r.stats.autoMatchRate,
          matched: r.stats.matched,
          unmatched_bank: r.stats.unmatchedBank,
          unmatched_ledger: r.stats.unmatchedLedger,
          anomalies: r.stats.anomalies,
          bank_total: r.stats.bankTotal,
          ledger_total: r.stats.ledgerTotal,
          explained: r.stats.explained,
          created_at: r.createdAt,
          created_by: r.createdBy,
        })),
      ),
      `runs-export-${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv",
    );
    toast.success(`Exported ${selectedRuns.length} runs`);
  };

  return (
    <div>
      <PageHeader
        title="Runs"
        breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Runs" }]}
        description="Every reconciliation run, its status and review progress."
        actions={
          <Can perm="run.create">
            <Button onClick={() => navigate("/runs/new")}>
              <Plus /> New Reconciliation
            </Button>
          </Can>
        }
      />
      <div className="card overflow-hidden">
        {selectedRuns.length > 0 && (
          <div className="flex items-center gap-2 border-b bg-sys/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
            <span className="font-medium">{selectedRuns.length} selected</span>
            <Button size="xs" variant="secondary" onClick={exportSelected}>
              <Download /> Export CSV
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setConfirmArchive(true)}>
              <Archive /> Archive
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSelection({})} className="ml-auto">
              <X /> Clear
            </Button>
          </div>
        )}
        <DataTable
          ariaLabel="Reconciliation runs"
          data={filtered}
          columns={columns}
          getRowId={(r) => r.id}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          rowSelection={selection}
          onRowSelectionChange={setSelection}
          urlKey="runs_"
          defaultSort={[{ id: "createdAt", desc: true }]}
          isFiltered={isFiltered}
          onClearFilters={() => setParams({}, { replace: true })}
          emptyState={
            <EmptyState
              icon={Play}
              title="No runs yet"
              description="Upload a bank statement and a ledger export to start your first reconciliation."
              action={<Button size="sm" onClick={() => navigate("/runs/new")}><Plus /> New Reconciliation</Button>}
            />
          }
          toolbar={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search run ID, name, user…" label="Search runs" />
              <MultiFilter label="Status" value={status} onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], count: data?.filter((r) => r.status === s).length }))} />
              <Select value={account} onValueChange={setAccount}>
                <SelectTrigger className="h-8 w-auto gap-2 text-xs" aria-label="Filter by account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  {ACCOUNT_OPTIONS.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Label htmlFor="runs-from" className="sr-only">Created from</Label>
                <Input id="runs-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[136px] text-xs" />
                <span className="text-xs text-muted-foreground">–</span>
                <Label htmlFor="runs-to" className="sr-only">Created to</Label>
                <Input id="runs-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[136px] text-xs" />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={archived === "1"} onCheckedChange={(c) => setArchived(c ? "1" : "")} aria-label="Show archived runs" />
                Archived
              </label>
            </>
          }
        />
      </div>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${selectedRuns.length} run${selectedRuns.length === 1 ? "" : "s"}?`}
        description="Archived runs are hidden from lists but kept in full in the audit trail. You can show them with the Archived toggle."
        confirmLabel="Archive"
        pending={archive.isPending}
        onConfirm={async () => {
          await archive.mutateAsync(selectedRuns.map((r) => r.id));
          setConfirmArchive(false);
        }}
      />
    </div>
  );
}
