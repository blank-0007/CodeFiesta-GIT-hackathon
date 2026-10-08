import { format, formatDistanceToNowStrict, parseISO, differenceInCalendarDays } from "date-fns";
import { useUiStore } from "@/lib/store";

export type DateFormatPref = "dd MMM yyyy" | "dd/MM/yyyy" | "yyyy-MM-dd" | "MMM d, yyyy";

export function fmtDate(iso: string | undefined, pattern: string = useUiStore.getState().dateFormat): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), pattern);
  } catch {
    return iso;
  }
}

export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  return format(parseISO(iso), `${useUiStore.getState().dateFormat}, HH:mm`);
}

export function fmtTime(iso: string): string {
  return format(parseISO(iso), "HH:mm:ss");
}

export function fmtRelative(iso: string): string {
  return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
}

export function daysBetween(a: string, b: string): number {
  return differenceInCalendarDays(parseISO(a), parseISO(b));
}

export function fmtDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function fmtPeriod(period: string): string {
  // "2026-09" → "September 2026"
  try {
    return format(parseISO(`${period}-01`), "MMMM yyyy");
  } catch {
    return period;
  }
}
