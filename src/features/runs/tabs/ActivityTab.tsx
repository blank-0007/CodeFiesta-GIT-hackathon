import { useMemo } from "react";
import { Bot, Cpu, User } from "lucide-react";
import type { AuditEntry, Run, RunEvent } from "@/api/types";
import { useActivity } from "@/api/queries";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/shared/misc";
import { AIBadge } from "@/components/shared/badges";
import { LogPanel } from "../PipelineView";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = { ts: string; kind: "audit"; e: AuditEntry } | { ts: string; kind: "event"; e: RunEvent };

export function ActorIcon({ type }: { type: AuditEntry["actor"]["type"] }) {
  const Icon = type === "ai" ? Bot : type === "system" ? Cpu : User;
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
        type === "ai" && "border-ai/40 bg-ai/10 text-ai",
        type === "system" && "border-sys/30 bg-sys/10 text-sys",
        type === "user" && "border-ok/30 bg-ok/10 text-ok",
      )}
      aria-label={type === "ai" ? "AI agent" : type === "system" ? "System" : "User"}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

export function describeAction(a: AuditEntry): string {
  const after = (a.after ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case "finding.classified":
      return `classified ${a.target} as ${String(after.category).replace("_", " ")} (${Math.round(Number(after.confidence) * 100)}% confidence)`;
    case "finding.auto_resolved":
      return `auto-resolved ${a.target}`;
    case "rule.proposed":
      return `proposed rule ${a.target}: ${after.title}`;
    case "match.manual":
      return `created manual match ${a.target}`;
    case "match.unmatched":
      return `unmatched ${a.target} — “${after.reason}”`;
    case "run.rerun":
      return `re-ran unmatched items with relaxed tolerances (+${after.matchesGained} matches)`;
    default:
      return `${a.action.replace(".", " ").replace("_", " ")} ${a.target}`;
  }
}

export function ActivityTab({ run }: { run: Run }) {
  const { data, isLoading, error, refetch } = useActivity(run.id);
  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    return [...data.audit.map((e) => ({ ts: e.ts, kind: "audit" as const, e }))].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [data]);

  if (isLoading) return <SkeletonRows rows={6} cols={3} />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <section className="card lg:col-span-3" aria-label="Activity timeline">
        <h2 className="border-b px-4 py-2.5 text-sm font-semibold">Timeline</h2>
        {items.length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <ol className="relative max-h-[640px] overflow-y-auto px-4 py-3">
            {items.map((it, i) => {
              const a = it.e as AuditEntry;
              return (
                <li key={a.id} className="relative flex gap-3 pb-4">
                  {i < items.length - 1 && <span aria-hidden className="absolute left-[13px] top-7 h-full w-px bg-border" />}
                  <ActorIcon type={a.actor.type} />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-sm">
                      <span className={cn("font-medium", a.actor.type === "ai" && "text-ai")}>{a.actor.name}</span>{" "}
                      {a.actor.type === "ai" && <AIBadge className="mx-1 align-middle" />}
                      <span className="text-muted-foreground">{describeAction(a)}</span>
                    </p>
                    <p className="num text-2xs text-muted-foreground">
                      {fmtDateTime(a.ts)}
                      {a.modelVersion && ` · ${a.modelVersion}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <div className="lg:col-span-2">
        <LogPanel events={data?.events ?? []} />
      </div>
    </div>
  );
}
