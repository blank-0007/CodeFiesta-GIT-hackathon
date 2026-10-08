import * as React from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Download,
  FileInput,
  GitMerge,
  Loader2,
  Radar,
  ShieldCheck,
  Sparkles,
  Wand2,
  XCircle,
  Flag,
  type LucideIcon,
} from "lucide-react";
import type { RunEvent, RunStage } from "@/api/types";
import { fmtDuration, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Node {
  key: string;
  label: string;
  icon: LucideIcon;
  stages: string[];
  ai?: boolean;
}

const NODES: Node[] = [
  { key: "ingest", label: "Ingest", icon: FileInput, stages: ["Ingest"] },
  { key: "normalize", label: "Normalize", icon: Wand2, stages: ["Normalize"] },
  { key: "match", label: "Match", icon: GitMerge, stages: ["Match P1", "Match P2", "Match P3"] },
  { key: "detect", label: "Detect", icon: Radar, stages: ["Detect"] },
  { key: "ai", label: "AI Investigate", icon: Sparkles, stages: ["AI Investigate"], ai: true },
  { key: "verify", label: "Verify", icon: ShieldCheck, stages: ["Verify"] },
  { key: "done", label: "Done", icon: Flag, stages: ["Done"] },
];

function nodeState(stages: RunStage[]): RunStage["state"] {
  if (stages.some((s) => s.state === "failed")) return "failed";
  if (stages.every((s) => s.state === "done")) return "done";
  if (stages.some((s) => s.state === "active" || s.state === "done")) return "active";
  return "pending";
}

const STATE_LABEL = { pending: "Pending", active: "Running", done: "Done", failed: "Failed" } as const;

export function PipelineView({ stages, compact = false }: { stages: RunStage[]; compact?: boolean }) {
  const byName = new Map(stages.map((s) => [s.name, s]));
  return (
    <ol className="flex items-stretch gap-1 overflow-x-auto pb-1" aria-label="Reconciliation pipeline">
      {NODES.map((n, i) => {
        const ss = n.stages.map((s) => byName.get(s) ?? { name: s, state: "pending" as const });
        const state = nodeState(ss);
        const count = ss.reduce((a, s) => a + (s.count ?? 0), 0);
        const ms = ss.reduce((a, s) => a + (s.ms ?? 0), 0);
        const Icon = n.icon;
        const StateIcon = state === "done" ? CheckCircle2 : state === "active" ? Loader2 : state === "failed" ? XCircle : Circle;
        return (
          <li key={n.key} className="flex min-w-[120px] flex-1 items-center gap-1">
            <div
              className={cn(
                "flex-1 rounded-lg border p-2.5 transition-colors",
                state === "done" && (n.ai ? "border-ai/30 bg-ai/5" : "border-sys/30 bg-sys/5"),
                state === "active" && (n.ai ? "border-ai bg-ai/10 ring-2 ring-ai/20" : "border-sys bg-sys/10 ring-2 ring-sys/20"),
                state === "failed" && "border-crit/50 bg-crit/10",
                state === "pending" && "opacity-60",
              )}
              aria-label={`${n.label}: ${STATE_LABEL[state]}${count ? `, ${count} items` : ""}${ms ? `, ${fmtDuration(ms)}` : ""}`}
            >
              <div className="flex items-center gap-1.5">
                <Icon className={cn("h-3.5 w-3.5", n.ai ? "text-ai" : "text-sys", state === "failed" && "text-crit")} aria-hidden />
                <span className="truncate text-xs font-medium">{n.label}</span>
                <StateIcon
                  aria-hidden
                  className={cn(
                    "ml-auto h-3.5 w-3.5 shrink-0",
                    state === "done" && "text-ok",
                    state === "active" && "animate-spin text-sys",
                    state === "failed" && "text-crit",
                    state === "pending" && "text-muted-foreground",
                  )}
                />
              </div>
              {!compact && (
                <>
                  {n.key === "match" && (
                    <div className="mt-1.5 flex gap-1">
                      {ss.map((s) => (
                        <span
                          key={s.name}
                          className={cn(
                            "num rounded px-1 text-[10px]",
                            s.state === "done" ? "bg-sys/15 text-sys" : s.state === "active" ? "bg-sys/30 text-foreground" : "bg-surface-2 text-muted-foreground",
                          )}
                          title={`${s.name}: ${s.count ?? 0} pairs`}
                        >
                          {s.name.replace("Match ", "")}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="num mt-1 flex justify-between text-2xs text-muted-foreground">
                    <span>{count ? `${count.toLocaleString()} items` : STATE_LABEL[state]}</span>
                    {ms > 0 && <span>{fmtDuration(ms)}</span>}
                  </div>
                </>
              )}
            </div>
            {i < NODES.length - 1 && <span aria-hidden className={cn("h-px w-3 shrink-0", state === "done" ? "bg-sys" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

const LEVEL_CLS: Record<RunEvent["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-warn",
  error: "text-crit",
  ai: "text-ai",
};

export function LogPanel({ events, live, onDownload }: { events: RunEvent[]; live?: boolean; onDownload?: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);
  React.useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events, follow]);
  return (
    <div className="rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium">
          {live && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-sys" /><span className="relative inline-flex h-2 w-2 rounded-full bg-sys" /></span>}
          {live ? "Live log" : "Run log"}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-2xs text-muted-foreground">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[rgb(var(--sys))]" /> Auto-scroll
          </label>
          {onDownload && (
            <button type="button" onClick={onDownload} className="text-muted-foreground hover:text-foreground" aria-label="Download log">
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div ref={ref} role="log" aria-live={live ? "polite" : "off"} aria-label="Run log" className="num max-h-56 overflow-y-auto px-3 py-2 text-2xs leading-5">
        {events.length === 0 && <p className="text-muted-foreground">Waiting for events…</p>}
        {events.map((e) => (
          <div key={e.seq} className="flex gap-3">
            <span className="shrink-0 text-muted-foreground/70">{fmtTime(e.ts)}</span>
            <span className="w-24 shrink-0 truncate text-muted-foreground">{e.stage}</span>
            <span className={cn("min-w-0", LEVEL_CLS[e.level])}>
              {e.level === "ai" && <Sparkles className="mr-1 inline h-3 w-3" aria-label="AI" />}
              {e.level === "warn" && "⚠ "}
              {e.level === "error" && "✕ "}
              {e.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CollapsiblePipeline({ stages, durationMs, children }: { stages: RunStage[]; durationMs?: number; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const failed = stages.some((s) => s.state === "failed");
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left">
        {failed ? <XCircle className="h-4 w-4 text-crit" aria-hidden /> : <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />}
        <span className="text-sm font-medium">{failed ? "Pipeline failed" : "Pipeline completed"}</span>
        {durationMs != null && <span className="num text-xs text-muted-foreground">in {fmtDuration(durationMs)}</span>}
        <div className="ml-4 hidden flex-1 lg:block">{!open && <PipelineView stages={stages} compact />}</div>
        <ChevronDown className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t p-4">
          <PipelineView stages={stages} />
          {children}
        </div>
      )}
    </div>
  );
}
