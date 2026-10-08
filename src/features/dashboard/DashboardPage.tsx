import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ArrowRight, CalendarCheck, Clock, Gauge, Inbox, Play, Plus, Wallet } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import type { FindingView, Run } from "@/api/types";
import { useDashboard, useRuns } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Can, EmptyState, ErrorState, InfoTip, PageHeader, StatCard } from "@/components/shared/misc";
import { AmountCell, useMoneyFormatter } from "@/components/shared/AmountCell";
import { RiskMeter } from "@/components/shared/RiskMeter";
import { AIBadge, CATEGORIES, CATEGORY_META, CategoryBadge, StatusBadge } from "@/components/shared/badges";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { DataTable } from "@/components/shared/DataTable";
import { ChartFrame, CATEGORY_COLORS, axisProps, chartTooltipStyle, tc } from "@/components/shared/charts";
import { Skeleton } from "@/components/ui/form-controls";
import { DecisionDialog } from "@/features/anomalies/DecisionDialog";
import { fmtDateTime, fmtPeriod } from "@/lib/format";
import { ACCOUNT_LABEL } from "@/lib/accounts";
import { pct } from "@/lib/utils";

const periodLabel = (p: string) => format(parseISO(`${p}-01`), "MMM yy");

function AttentionItem({ f }: { f: FindingView }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryBadge category={f.humanCategory ?? f.category} />
          <StatusBadge status={f.status} />
          <span className="num text-2xs text-muted-foreground">{f.id}</span>
        </div>
        <p className="mt-1 truncate text-sm font-medium">{f.txn.vendorNorm}</p>
        <p className="line-clamp-1 text-xs text-muted-foreground">
          <AIBadge className="mr-1 align-middle" /> {f.explanation}
        </p>
      </div>
      <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
        <AmountCell value={f.txn.amount} className="text-sm" />
        <RiskMeter score={f.riskScore} size="sm" />
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Can perm="finding.decide">
          <Button size="xs" variant="success" onClick={() => setOpen(true)} aria-label={`Approve ${f.id}`}>
            Approve
          </Button>
        </Can>
        <Button size="xs" variant="secondary" onClick={() => navigate(`/runs/${f.runId}?tab=anomalies&finding=${f.id}`)} aria-label={`Open ${f.id}`}>
          Open
        </Button>
      </div>
      <DecisionDialog finding={f} action={open ? "approve" : null} onOpenChange={setOpen} />
    </li>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error, refetch } = useDashboard();
  const runs = useRuns();
  const money = useMoneyFormatter();
  const navigate = useNavigate();

  const trend = useMemo(() => data?.trend.map((t) => ({ period: periodLabel(t.period), rate: Math.round(t.autoMatchRate * 1000) / 10 })) ?? [], [data]);
  const anomalies = useMemo(() => data?.anomaliesByMonth.map((a) => ({ ...a, period: periodLabel(a.period) })) ?? [], [data]);

  const runCols = useMemo<ColumnDef<Run>[]>(
    () => [
      { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { accessorKey: "period", header: "Period", cell: ({ row }) => <span className="whitespace-nowrap">{fmtPeriod(row.original.period)}</span> },
      { id: "accounts", header: "Accounts", enableSorting: false, cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{row.original.accounts.map((a) => ACCOUNT_LABEL[a] ?? a).join(" · ")}</span> },
      { id: "rate", accessorFn: (r) => r.stats.autoMatchRate, header: "Match rate", meta: { align: "right" }, cell: ({ row }) => (row.original.stats.bankCount ? <ConfidenceBar value={row.original.stats.autoMatchRate} label="Auto-match rate" /> : "—") },
      { id: "anomalies", accessorFn: (r) => r.stats.anomalies, header: "Anomalies", meta: { align: "right" }, cell: ({ getValue }) => <span className="num">{getValue<number>()}</span> },
      { accessorKey: "createdBy", header: "Started by", cell: ({ row }) => <span className="whitespace-nowrap text-sm">{row.original.createdBy}</span> },
      { accessorKey: "createdAt", header: "Started", cell: ({ row }) => <span className="num whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span> },
    ],
    [],
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Month-end close at a glance — what's matched, what's open and what needs you."
        actions={
          <Can perm="run.create">
            <Button onClick={() => navigate("/runs/new")}>
              <Plus /> New Reconciliation
            </Button>
          </Can>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard loading={isLoading} label="Runs this month" icon={Play} tone="sys" value={data?.runsThisMonth ?? 0} sub={format(new Date(), "MMMM yyyy")} />
        <StatCard loading={isLoading} label="Auto-match rate" icon={Gauge} tone="sys" help="Share of bank transactions matched automatically at ≥ 90% confidence." value={data ? pct(data.autoMatchRate) : ""} sub={data && data.trend.length > 1 ? `${data.trend.at(-1)!.autoMatchRate >= data.trend.at(-2)!.autoMatchRate ? "▲" : "▼"} ${Math.abs((data.trend.at(-1)!.autoMatchRate - data.trend.at(-2)!.autoMatchRate) * 100).toFixed(1)} pts vs last month` : undefined} />
        <StatCard loading={isLoading} label="Open anomalies" icon={AlertTriangle} tone="attn" value={data?.openAnomalies ?? 0} sub="Across all runs" />
        <StatCard loading={isLoading} label="Pending human reviews" icon={Inbox} tone="warn" value={data?.pendingReviews ?? 0} sub={<Link to="/review" className="text-sys hover:underline">Open review queue →</Link>} />
        <StatCard loading={isLoading} label="Unreconciled amount" icon={Wallet} tone="crit" help="Sum of absolute unexplained differences across runs awaiting review." value={data ? <span className="text-crit">{money(data.unreconciledAmount, { compact: true })}</span> : ""} sub={data ? money(data.unreconciledAmount) : undefined} />
        <StatCard loading={isLoading} label="Avg time saved" icon={Clock} tone="ok" help="Estimated at 1.2 minutes of manual matching per matched pair." value={data ? `${data.avgHoursSaved} h` : ""} sub="per run vs manual" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1">Auto-match rate <InfoTip term="auto_match" /></CardTitle>
              <CardDescription>Last 12 months</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[220px]" />
            ) : (
              <ChartFrame label="Line chart of auto-match rate by month" summary={trend.map((t) => `${t.period}: ${t.rate}%`).join(", ")}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="period" {...axisProps} />
                    <YAxis domain={[70, 100]} unit="%" {...axisProps} />
                    <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => [`${v}%`, "Auto-match"]} />
                    <Line type="monotone" dataKey="rate" stroke={tc("sys")} strokeWidth={2} dot={{ r: 3, fill: tc("sys") }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>Anomalies by category</CardTitle>
              <CardDescription>Findings per monthly run</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[220px]" />
            ) : (
              <ChartFrame label="Stacked bar chart of anomalies by category per month" summary={anomalies.map((a) => `${a.period}: ${CATEGORIES.map((c) => `${a[c]} ${CATEGORY_META[c].label}`).join(", ")}`).join("; ")}>
                <ResponsiveContainer>
                  <BarChart data={anomalies} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="period" {...axisProps} />
                    <YAxis allowDecimals={false} {...axisProps} />
                    <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: tc("surface-2", 0.5) }} />
                    <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    {CATEGORIES.map((c, i) => (
                      <Bar key={c} dataKey={c} name={CATEGORY_META[c].label} stackId="a" fill={CATEGORY_COLORS[c]} radius={i === CATEGORIES.length - 1 ? [3, 3, 0, 0] : 0} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader className="border-b pb-3">
            <div>
              <CardTitle>Needs your attention</CardTitle>
              <CardDescription>Highest risk × amount open findings</CardDescription>
            </div>
            <Button asChild variant="ghost" size="xs">
              <Link to="/review">
                All <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : data?.attention.length ? (
            <ul className="divide-y">
              {data.attention.map((f) => (
                <AttentionItem key={f.id} f={f} />
              ))}
            </ul>
          ) : (
            <EmptyState icon={CalendarCheck} title="Nothing needs you right now" description="All high-risk findings are resolved. New ones appear here after each run." />
          )}
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader className="border-b pb-3">
            <div>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Click a run to open its workspace</CardDescription>
            </div>
            <Button asChild variant="ghost" size="xs">
              <Link to="/runs">
                All runs <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <DataTable
            ariaLabel="Recent runs"
            data={runs.data?.slice(0, 6)}
            columns={runCols}
            getRowId={(r) => r.id}
            isLoading={runs.isLoading}
            error={runs.error}
            onRetry={() => runs.refetch()}
            onRowClick={(r) => navigate(`/runs/${r.id}`)}
            urlKey="recent_"
            maxHeight="none"
            footer={<></>}
            emptyState={<EmptyState icon={Play} title="No runs yet" description="Start your first reconciliation to see it here." />}
          />
        </Card>
      </div>
    </div>
  );
}
