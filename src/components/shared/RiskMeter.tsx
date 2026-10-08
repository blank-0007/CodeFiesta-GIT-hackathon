import { memo } from "react";
import { AlertOctagon, AlertTriangle, ShieldCheck, ShieldAlert } from "lucide-react";
import { getRiskLevel, RISK_META, type RiskLevel } from "@/lib/risk";
import { cn } from "@/lib/utils";

const ICON: Record<RiskLevel, typeof ShieldCheck> = {
  low: ShieldCheck,
  medium: AlertTriangle,
  high: ShieldAlert,
  critical: AlertOctagon,
};

export interface RiskMeterProps {
  score: number; // 0–1
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  showScore?: boolean;
  className?: string;
}

/** Four-segment meter + icon + text label so risk never relies on colour alone. */
export const RiskMeter = memo(function RiskMeter({
  score,
  size = "md",
  showLabel = true,
  showScore = true,
  className,
}: RiskMeterProps) {
  const level = getRiskLevel(score);
  const meta = RISK_META[level];
  const Icon = ICON[level];
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${meta.label} risk, ${pct} out of 100`}
      aria-label="Risk score"
      data-level={level}
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      <Icon className={cn(meta.text, size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} aria-hidden />
      <div className="flex gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            data-filled={i <= meta.segments}
            className={cn(
              "rounded-[2px]",
              size === "sm" ? "h-2.5 w-1" : size === "lg" ? "h-4 w-2" : "h-3 w-1.5",
              i <= meta.segments ? meta.bg : "bg-border",
            )}
          />
        ))}
      </div>
      {showScore && <span className={cn("num text-xs font-medium", meta.text)}>{pct}</span>}
      {showLabel && <span className={cn("text-2xs font-medium", meta.text)}>{meta.label}</span>}
    </div>
  );
});
