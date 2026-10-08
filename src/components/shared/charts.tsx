import * as React from "react";

/** Theme-aware colour for SVG/Recharts — CSS vars resolve in presentation attributes. */
export const tc = (name: "sys" | "attn" | "crit" | "warn" | "ai" | "ok" | "border" | "muted-foreground" | "surface-2", alpha?: number) =>
  alpha == null ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;

export const CATEGORY_COLORS = {
  duplicate: tc("attn"),
  missing: "#60A5FA", // blue — distinct from the AI violet

  timing: tc("warn"),
  potential_fraud: tc("crit"),
  unknown: tc("muted-foreground"),
} as const;

export const chartTooltipStyle: React.CSSProperties = {
  background: "rgb(var(--surface-2))",
  border: "1px solid rgb(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  color: "rgb(var(--foreground))",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.25)",
};

export const axisProps = {
  tick: { fontSize: 11, fill: "rgb(var(--muted-foreground))" },
  tickLine: false,
  axisLine: { stroke: "rgb(var(--border))" },
  minTickGap: 10,
} as const;

/** Accessible chart wrapper: role=img with a text summary for screen readers. */
export function ChartFrame({
  label,
  summary,
  height = 220,
  children,
}: {
  label: string;
  summary: string;
  height?: number;
  children: React.ReactNode;
}) {
  return (
    <figure role="img" aria-label={`${label}. ${summary}`} style={{ height }} className="w-full">
      {children}
    </figure>
  );
}

/** Tiny inline sparkline with an optional highlighted point. */
export function Sparkline({
  values,
  highlightIndex,
  width = 220,
  height = 48,
  label,
}: {
  values: number[];
  highlightIndex?: number;
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (width - pad * 2),
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="overflow-visible">
      <path d={d} fill="none" stroke="rgb(var(--sys))" strokeWidth={1.5} strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === highlightIndex ? 4 : 1.8} fill={i === highlightIndex ? "rgb(var(--crit))" : "rgb(var(--sys))"} stroke={i === highlightIndex ? "rgb(var(--background))" : "none"} strokeWidth={1.5} />
      ))}
    </svg>
  );
}
