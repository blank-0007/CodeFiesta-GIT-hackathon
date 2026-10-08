import * as React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ChevronRight, Info, Lock, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/menus";
import { cn } from "@/lib/utils";
import { useCan, useRoleLabel, type Permission } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/form-controls";

/* ---------------- VendorCell ---------------- */
export const VendorCell = React.memo(function VendorCell({
  raw,
  normalized,
  className,
  maxWidth = "max-w-[260px]",
}: {
  raw: string;
  normalized?: string;
  className?: string;
  maxWidth?: string;
}) {
  return (
    <Tip
      content={
        <div className="space-y-1">
          {normalized && <div className="font-medium">{normalized}</div>}
          <div className="num break-all text-2xs text-muted-foreground">{raw}</div>
        </div>
      }
    >
      <div className={cn("min-w-0", maxWidth, className)} tabIndex={-1}>
        <div className="truncate text-sm">{normalized || raw}</div>
        {normalized && <div className="num truncate text-2xs text-muted-foreground">{raw}</div>}
      </div>
    </Tip>
  );
});

/** Truncates long text gracefully and shows the full value on hover/focus. */
export function Truncate({ text, className }: { text: string; className?: string }) {
  return (
    <Tip content={text.length > 24 ? text : null}>
      <span className={cn("block truncate", className)}>{text}</span>
    </Tip>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({
  icon: Icon = Info,
  title,
  description,
  action,
  className,
  tone = "neutral",
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}
    >
      <div
        className={cn(
          "mb-1 flex h-10 w-10 items-center justify-center rounded-full",
          tone === "error" ? "bg-crit/10 text-crit" : "bg-surface-2 text-muted-foreground",
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <EmptyState
      tone="error"
      icon={AlertCircle}
      title="Couldn't load this data"
      description={msg}
      className={className}
      action={
        onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
        )
      }
    />
  );
}

export function SkeletonRows({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cn("h-6", c === 1 ? "flex-[2]" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------------- StatCard ---------------- */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "neutral",
  help,
  loading,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  tone?: "neutral" | "sys" | "attn" | "crit" | "warn" | "ok" | "ai";
  help?: string;
  loading?: boolean;
  className?: string;
}) {
  const toneCls = {
    neutral: "text-muted-foreground bg-surface-2",
    sys: "text-sys bg-sys/10",
    attn: "text-attn bg-attn/10",
    crit: "text-crit bg-crit/10",
    warn: "text-warn bg-warn/10",
    ok: "text-ok bg-ok/10",
    ai: "text-ai bg-ai/10",
  }[tone];
  return (
    <div className={cn("card flex flex-col gap-2 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          {label}
          {help && <InfoTip>{help}</InfoTip>}
        </span>
        {Icon && (
          <span className={cn("flex h-7 w-7 items-center justify-center rounded-md", toneCls)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
      {loading ? <Skeleton className="h-7 w-24" /> : <div className="num text-2xl font-semibold tracking-tight">{value}</div>}
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/* ---------------- StepProgress ---------------- */
export function StepProgress({
  steps,
  current,
  onStepClick,
}: {
  steps: { label: string; description?: string; skipped?: boolean }[];
  current: number;
  onStepClick?: (i: number) => void;
}) {
  return (
    <ol className="flex w-full items-center gap-2" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={s.label} className="flex flex-1 items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
            <button
              type="button"
              disabled={!onStepClick || i > current}
              onClick={() => onStepClick?.(i)}
              className="group flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  state === "done" && "border-sys bg-sys text-[rgb(var(--on-accent))]",
                  state === "active" && "border-sys text-sys ring-4 ring-sys/15",
                  state === "todo" && "text-muted-foreground",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="hidden min-w-0 md:block">
                <span className={cn("block truncate text-sm font-medium", state === "todo" && "text-muted-foreground")}>
                  {s.label}
                  {s.skipped && <span className="ml-1 text-2xs text-muted-foreground">(skipped)</span>}
                </span>
                {s.description && <span className="block truncate text-2xs text-muted-foreground">{s.description}</span>}
              </span>
              <span className="sr-only">{state === "done" ? "completed" : state === "active" ? "current step" : "not started"}</span>
            </button>
            {i < steps.length - 1 && <span className={cn("h-px flex-1", i < current ? "bg-sys" : "bg-border")} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------- KeyboardHint ---------------- */
export function KeyboardHint({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-hidden>
      {keys.map((k) => (
        <kbd
          key={k}
          className="num inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-surface-2 px-1 text-[10px] font-medium text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/* ---------------- InfoTip (finance glossary) ---------------- */
export const GLOSSARY = {
  timing: "Timing difference: a transaction recorded in different periods by the bank and the ledger. It reverses on its own next period.",
  outstanding_cheque: "Outstanding cheque: a cheque issued and booked in the ledger but not yet presented to / cleared by the bank.",
  cutoff: "Cut-off: the period-end boundary. Items dated near it often land in different months on each side.",
  deposit_in_transit: "Deposit in transit: money booked in the ledger that the bank has not yet credited.",
  explained: "Explained difference: the part of bank − ledger that is accounted for by classified, approved items.",
  unexplained: "Integrity check: bank − ledger must equal explained differences. Anything left over is unexplained and blocks finalization.",
  noisy_or: "Signals are combined with noisy-OR: risk = 1 − Π(1 − signal score). Each row shows how much that signal added.",
  auto_match: "Share of bank transactions matched automatically at high confidence (≥ 90%) without human input.",
} as const;

export function InfoTip({ children, term, className }: { children?: React.ReactNode; term?: keyof typeof GLOSSARY; className?: string }) {
  const content = children ?? (term ? GLOSSARY[term] : null);
  return (
    <Tip content={content}>
      <button
        type="button"
        className={cn("inline-flex rounded-full text-muted-foreground hover:text-foreground", className)}
        aria-label={typeof content === "string" ? content : "More information"}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
    </Tip>
  );
}

/* ---------------- PageHeader & Breadcrumbs ---------------- */
export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1">
            {it.to ? (
              <Link to={it.to} className="hover:text-foreground hover:underline">
                {it.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground/80">
                {it.label}
              </span>
            )}
            {i < items.length - 1 && <ChevronRight className="h-3 w-3" aria-hidden />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  badge,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
  actions?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight break-words sm:text-xl">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ---------------- Permission gate ---------------- */
/**
 * Renders children disabled (with an explanatory tooltip) when the current role
 * lacks the permission, or hides them entirely with mode="hide".
 */
export function Can({
  perm,
  children,
  mode = "disable",
}: {
  perm: Permission;
  children: React.ReactElement<{ disabled?: boolean }>;
  mode?: "disable" | "hide";
}) {
  const allowed = useCan(perm);
  const role = useRoleLabel();
  if (allowed) return children;
  if (mode === "hide") return null;
  return (
    <Tip content={<span className="flex items-center gap-1.5"><Lock className="h-3 w-3" /> Your role ({role}) can't do this</span>}>
      <span tabIndex={0} className="inline-flex">
        {React.cloneElement(children, { disabled: true })}
      </span>
    </Tip>
  );
}

/* ---------------- Section ---------------- */
export function Section({
  title,
  actions,
  children,
  className,
  description,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
}) {
  return (
    <section className={cn("card", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div>{children}</div>
    </section>
  );
}
