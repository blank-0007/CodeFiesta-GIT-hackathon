import { memo } from "react";
import {
  Activity,
  CalendarClock,
  Copy,
  Fingerprint,
  Gauge,
  Moon,
  Scale,
  Sparkles,
  TrendingUp,
  UserPlus,
  Hash,
  type LucideIcon,
} from "lucide-react";
import type { EvidenceItem, Signal } from "@/api/types";
import { AmountCell } from "./AmountCell";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/menus";

/* ---------------- SignalChip ---------------- */
export const DETECTOR_META: Record<string, { label: string; icon: LucideIcon }> = {
  duplicate_detector: { label: "Duplicate", icon: Copy },
  approval_limit: { label: "Below approval limit", icon: Scale },
  new_vendor: { label: "New vendor", icon: UserPlus },
  weekend_payment: { label: "Weekend payment", icon: Moon },
  high_value: { label: "High value", icon: TrendingUp },
  period_boundary: { label: "Period boundary", icon: CalendarClock },
  amount_outlier: { label: "Amount outlier", icon: Activity },
  no_counterpart: { label: "No counterpart", icon: Fingerprint },
  amount_mismatch: { label: "Amount mismatch", icon: Gauge },
  round_amount: { label: "Round amount", icon: Hash },
};

export const SignalChip = memo(function SignalChip({
  signal,
  showText = false,
  className,
}: {
  signal: Signal;
  showText?: boolean;
  className?: string;
}) {
  const meta = DETECTOR_META[signal.detector] ?? { label: signal.detector, icon: Sparkles };
  const Icon = meta.icon;
  const pct = Math.round(signal.score * 100);
  const tone = signal.score >= 0.7 ? "border-crit/30 text-crit bg-crit/5" : signal.score >= 0.4 ? "border-warn/30 text-warn bg-warn/5" : "border-border text-muted-foreground bg-surface-2";
  const chip = (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium", tone, className)}
      aria-label={`${meta.label} signal, score ${pct}. ${signal.humanText}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
      <span className="num opacity-80">{pct}</span>
    </span>
  );
  if (!showText) return <Tip content={signal.humanText}>{chip}</Tip>;
  return (
    <div className="flex flex-col gap-1">
      {chip}
      <p className="text-xs text-muted-foreground">{signal.humanText}</p>
    </div>
  );
});

/* ---------------- EvidenceList ---------------- */
const RELATION_LABEL: Record<EvidenceItem["relation"], string> = {
  candidate: "Nearest candidate",
  duplicate: "Possible duplicate",
  vendor_history: "Vendor history",
  period_boundary: "Next-period entry",
};

export function EvidenceList({
  items,
  onOpen,
  emptyText = "No related transactions found.",
}: {
  items: EvidenceItem[];
  onOpen?: (item: EvidenceItem) => void;
  emptyText?: string;
}) {
  if (!items.length) return <p className="px-1 py-3 text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y rounded-md border" aria-label="Evidence">
      {items.map((it) => (
        <li key={it.txn.id + it.relation}>
          <button
            type="button"
            onClick={() => onOpen?.(it)}
            className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                {it.txn.source}
              </span>
              <span className="truncate text-sm">{it.txn.vendorNorm}</span>
            </span>
            <AmountCell value={it.txn.amount} className="text-sm" />
            <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
              <span className="num">{fmtDate(it.txn.date)}</span>
              <span>·</span>
              <span className="truncate">{it.note ?? RELATION_LABEL[it.relation]}</span>
            </span>
            <span className="num text-right text-2xs text-muted-foreground">
              {Math.round(it.similarity * 100)}% similar
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
