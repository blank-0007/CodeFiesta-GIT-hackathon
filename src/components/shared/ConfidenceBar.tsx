import { memo } from "react";
import { getConfidenceLevel } from "@/lib/risk";
import { cn } from "@/lib/utils";

export interface ConfidenceBarProps {
  value: number; // 0–1
  variant?: "match" | "ai";
  label?: string;
  showValue?: boolean;
  className?: string;
  width?: string;
}

const LEVEL_TEXT = { high: "High", medium: "Medium", low: "Low" } as const;

export const ConfidenceBar = memo(function ConfidenceBar({
  value,
  variant = "match",
  label = "Confidence",
  showValue = true,
  className,
  width = "w-16",
}: ConfidenceBarProps) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const level = getConfidenceLevel(value);
  const color =
    variant === "ai" ? "bg-ai" : level === "high" ? "bg-sys" : level === "medium" ? "bg-warn" : "bg-attn";
  return (
    <div
      className={cn("inline-flex items-center gap-2", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% — ${LEVEL_TEXT[level]} confidence`}
      title={`${LEVEL_TEXT[level]} confidence`}
    >
      <div className={cn("h-1.5 overflow-hidden rounded-full bg-border", width)} aria-hidden>
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
      {showValue && <span className="num w-9 text-right text-xs">{pct}%</span>}
    </div>
  );
});
