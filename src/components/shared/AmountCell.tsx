import { memo } from "react";
import type { Money } from "@/api/types";
import { big, describeMoney, formatMoney, type FormatMoneyOptions } from "@/lib/money";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function useMoneyFormatter() {
  const locale = useUiStore((s) => s.locale);
  const currency = useUiStore((s) => s.currency);
  return (v: Money, opts: Omit<FormatMoneyOptions, "locale" | "currency"> = {}) =>
    formatMoney(v, { locale, currency, ...opts });
}

export interface AmountCellProps {
  value: Money;
  /** Tint debits red and credits green (default true). */
  colorize?: boolean;
  sign?: FormatMoneyOptions["sign"];
  compact?: boolean;
  className?: string;
  align?: "right" | "left";
  /** Emphasise e.g. a non-zero difference. */
  emphasis?: "none" | "warn" | "crit";
}

/**
 * Monetary value: monospace, tabular, right-aligned. Debits carry a minus and red
 * tint; credits a green tint. Colour is never the only signal (sign + aria label).
 */
export const AmountCell = memo(function AmountCell({
  value,
  colorize = true,
  sign = "auto",
  compact,
  className,
  align = "right",
  emphasis = "none",
}: AmountCellProps) {
  const locale = useUiStore((s) => s.locale);
  const currency = useUiStore((s) => s.currency);
  const b = big(value);
  const text = formatMoney(value, { locale, currency, sign, compact });
  const full = compact ? formatMoney(value, { locale, currency, sign }) : undefined;
  return (
    <span
      data-testid="amount"
      title={full}
      aria-label={describeMoney(value, { locale, currency })}
      className={cn(
        "num inline-block whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        colorize && b.lt(0) && "text-crit/90",
        colorize && b.gt(0) && "text-ok",
        emphasis === "crit" && "font-semibold text-crit",
        emphasis === "warn" && "font-semibold text-warn",
        className,
      )}
    >
      {text}
    </span>
  );
});
