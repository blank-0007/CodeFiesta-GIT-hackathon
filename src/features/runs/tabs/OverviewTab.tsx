import { useMemo } from "react";
import { Bar, BarChart, Cell, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { Run } from "@/api/types";
import { useFindings, useMatches, useUnmatched } from "@/api/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/form-controls";
import { ChartFrame, CATEGORY_COLORS, axisProps, chartTooltipStyle, tc } from "@/components/shared/charts";
import { CATEGORIES, CATEGORY_META } from "@/components/shared/badges";
import { useMoneyFormatter } from "@/components/shared/AmountCell";
import { InfoTip } from "@/components/shared/misc";
import { big, moneyToNumber } from "@/lib/money";

function ChartCard({ title, description, children, className }: { title: React.ReactNode; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-1">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Bank total → reconciling items by category → ledger total. */
function Waterfall({ run }: { run: Run }) {
  const { data: um, isLoading } = useUnmatched(run.id, run);
  const money = useMoneyFormatter();
  const steps = useMemo(() => {
    if (!um) return [];
    const groups = new Map<string, ReturnType<typeof big>>();
    const add = (k: string, v: ReturnType<typeof big>) => groups.set(k, (groups.get(k) ?? big(0)).plus(v));
    um.bank.forEach((i) => add(i.category ?? "unknown", big(i.txn.amount)));
    um.ledger.forEach((i) => add(i.category ?? "unknown", big(i.txn.amount).times(-1)));
    if (!big(run.toleranceDiff).eq(0)) add("tolerance", big(run.toleranceDiff));
    // Walk from bank to ledger: ledger = bank − Σ contributions
    let running = big(run.stats.bankTotal);
    const out: { name: string; base: number; value: number; raw: string; kind: "total" | "up" | "down"; key: string }[] = [
      { name: "Bank total", base: 0, value: moneyToNumber(run.stats.bankTotal), raw: run.stats.bankTotal, kind: "total", key: "bank" },
    ];
    for (const [k, v] of groups) {
      const delta = v.times(-1);
      const next = running.plus(delta);
      out.push({
        name: k === "tolerance" ? "Tolerance" : CATEGORY_META[k as keyof typeof CATEGORY_META]?.label ?? k,
        base: moneyToNumber(running.lt(next) ? running.toFixed(2) : next.toFixed(2)),
        value: Math.abs(moneyToNumber(delta.toFixed(2))),
        raw: delta.toFixed(2),
        kind: delta.gte(0) ? "up" : "down",
        key: k,
      });
      running = next;
    }
    out.push({ name: "Ledger total", base: 0, value: moneyToNumber(run.stats.ledgerTotal), raw: run.stats.ledgerTotal, kind: "total", key: "ledger" });
    // Start the axis just below the lowest point so the reconciling steps are visible.
    const lows = out.filter((s) => s.kind !== "total").map((s) => s.base);
    const totals = out.filter((s) => s.kind === "total").map((s) => s.value);
    const lo = Math.min(...lows, ...totals);
    const hi = Math.max(...out.map((s) => (s.kind === "total" ? s.value : s.base + s.value)));
    const floor = Math.max(0, lo - (hi - lo) * 0.6);
    return out.map((s) => (s.kind === "total" ? { ...s, base: floor, value: s.value - floor } : s));
  }, [um, run]);

  if (isLoading) return <Skeleton className="h-[260px]" />;
  const values = steps.flatMap((s) => [s.base, s.base + s.value]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08 || 1;
  return (
    <ChartFrame
      label="Reconciliation waterfall from bank total to ledger total"
      summary={steps.map((s) => `${s.name}: ${money(s.raw, { sign: s.kind === "total" ? "auto" : "always" })}`).join("; ")}
      height={260}
    >
      <ResponsiveContainer>
        <BarChart data={steps} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" {...axisProps} interval={0} tick={{ ...axisProps.tick, fontSize: 10 }} />
          <YAxis domain={[min, max + pad]} allowDataOverflow tickFormatter={(v: number) => money(big(Math.round(v)).toFixed(2), { compact: true })} width={72} {...axisProps} />
          <Tooltip
            contentStyle={chartTooltipStyle}
            cursor={{ fill: tc("surface-2", 0.4) }}
            formatter={(_v: number, _n: string, p: { payload?: { raw: string; kind: string } }) => [money(p.payload!.raw, { sign: p.payload!.kind === "total" ? "auto" : "always" }), "Amount"]}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="w" radius={[3, 3, 0, 0]}>
            {steps.map((s) => (
              <Cell key={s.key} fill={s.kind === "total" ? tc("sys", 0.75) : s.key in CATEGORY_COLORS ? CATEGORY_COLORS[s.key as keyof typeof CATEGORY_COLORS] : tc("muted-foreground")} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

function histogram(values: number[], lo: number, hi: number, bins: number) {
  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ bin: `${Math.round((lo + i * w) * 100)}`, count: 0, lo: lo + i * w }));
  values.forEach((v) => {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)));
    out[i].count++;
  });
  return out;
}

export function OverviewTab({ run }: { run: Run }) {
  const matches = useMatches(run.id, run);
  const findings = useFindings(run.id, run);

  const conf = useMemo(() => histogram(matches.data?.map((m) => m.score) ?? [], 0.7, 1.0001, 12), [matches.data]);
  const byPass = useMemo(() => {
    const m = new Map<string, number>();
    matches.data?.forEach((p) => m.set(p.passName, (m.get(p.passName) ?? 0) + 1));
    return [...m.entries()].sort().map(([pass, count]) => ({ pass, count }));
  }, [matches.data]);
  const cats = CATEGORIES.map((c) => ({ cat: CATEGORY_META[c].label, key: c, count: run.categoryCounts[c] }));
  const risk = useMemo(() => histogram(findings.data?.map((f) => f.riskScore) ?? [], 0, 1.0001, 10), [findings.data]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard className="lg:col-span-2" title={<>Reconciliation waterfall <InfoTip term="explained" /></>} description="How unmatched items bridge the bank total to the ledger total, by category (axis does not start at zero)">
        <Waterfall run={run} />
      </ChartCard>

      <ChartCard title="Match confidence distribution" description="Matched pairs by confidence score (%) — the dashed line marks the 90% auto-accept threshold">
        {matches.isLoading ? <Skeleton className="h-[220px]" /> : (
          <ChartFrame label="Histogram of match confidence" summary={conf.map((b) => `${b.bin}%: ${b.count}`).join(", ")}>
            <ResponsiveContainer>
              <BarChart data={conf} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bin" {...axisProps} unit="%" />
                <YAxis allowDecimals={false} {...axisProps} />
                <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: tc("surface-2", 0.4) }} formatter={(v: number) => [v, "Pairs"]} labelFormatter={(l) => `≥ ${l}%`} />
                <ReferenceLine x="90" stroke={tc("warn")} strokeDasharray="4 3" />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {conf.map((b) => <Cell key={b.bin} fill={b.lo >= 0.9 ? tc("sys") : tc("warn")} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </ChartCard>

      <ChartCard title="Matches by pass" description="Which matching pass produced each pair">
        {matches.isLoading ? <Skeleton className="h-[220px]" /> : (
          <ChartFrame label="Bar chart of matches by pass" summary={byPass.map((p) => `${p.pass}: ${p.count}`).join(", ")}>
            <ResponsiveContainer>
              <BarChart data={byPass} layout="vertical" margin={{ top: 4, right: 16, left: 24, bottom: 0 }}>
                <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey="pass" width={110} {...axisProps} />
                <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: tc("surface-2", 0.4) }} formatter={(v: number) => [v, "Pairs"]} />
                <Bar dataKey="count" fill={tc("sys")} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </ChartCard>

      <ChartCard title="Anomalies by category" description="All findings in this run">
        <ChartFrame label="Bar chart of anomalies by category" summary={cats.map((c) => `${c.cat}: ${c.count}`).join(", ")}>
          <ResponsiveContainer>
            <BarChart data={cats} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="cat" {...axisProps} interval={0} tick={{ ...axisProps.tick, fontSize: 10 }} />
              <YAxis allowDecimals={false} {...axisProps} />
              <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: tc("surface-2", 0.4) }} formatter={(v: number) => [v, "Findings"]} />
              <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                {cats.map((c) => <Cell key={c.key} fill={CATEGORY_COLORS[c.key]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      </ChartCard>

      <ChartCard title="Risk-score histogram" description="Combined detector risk (noisy-OR) per finding">
        {findings.isLoading ? <Skeleton className="h-[220px]" /> : (
          <ChartFrame label="Histogram of risk scores" summary={risk.map((b) => `${b.bin}: ${b.count}`).join(", ")}>
            <ResponsiveContainer>
              <BarChart data={risk} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke={tc("border")} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bin" {...axisProps} />
                <YAxis allowDecimals={false} {...axisProps} />
                <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: tc("surface-2", 0.4) }} formatter={(v: number) => [v, "Findings"]} labelFormatter={(l) => `Risk ≥ ${l}`} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {risk.map((b) => <Cell key={b.bin} fill={b.lo >= 0.85 ? tc("crit") : b.lo >= 0.7 ? tc("attn") : b.lo >= 0.4 ? tc("warn") : tc("sys")} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </ChartCard>
    </div>
  );
}
