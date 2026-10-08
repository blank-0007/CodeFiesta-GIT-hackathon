import * as React from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Braces,
  Check,
  ChevronDown,
  Clock,
  FileText,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  Wrench,
} from "lucide-react";
import type { Category, DecisionAction, FindingDetail as FindingDetailT, Txn } from "@/api/types";
import { useComment, useDecision, useFinding } from "@/api/queries";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea, Skeleton } from "@/components/ui/form-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AmountCell } from "@/components/shared/AmountCell";
import { RiskMeter } from "@/components/shared/RiskMeter";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { AIBadge, CATEGORIES, CATEGORY_META, CategoryBadge, StatusBadge } from "@/components/shared/badges";
import { DETECTOR_META, EvidenceList, SignalChip } from "@/components/shared/evidence";
import { Sparkline } from "@/components/shared/charts";
import { Can, EmptyState, ErrorState, InfoTip, KeyboardHint } from "@/components/shared/misc";
import { useHotkeys } from "@/hooks/useHotkeys";
import { useCan } from "@/lib/permissions";
import { fmtDate, fmtDateTime, fmtRelative } from "@/lib/format";
import { moneyToNumber } from "@/lib/money";
import { noisyOr } from "@/lib/risk";
import { cn } from "@/lib/utils";
import { ALL_USERS_LIST } from "@/lib/users";
import { ACCOUNT_LABEL } from "@/lib/accounts";
import { DecisionDialog, requiresNotes } from "./DecisionDialog";
import { ActorIcon, describeAction } from "@/features/runs/tabs/ActivityTab";

function Panel({ title, children, className, actions, id }: { title: React.ReactNode; children: React.ReactNode; className?: string; actions?: React.ReactNode; id?: string }) {
  return (
    <section className={cn("card", className)} aria-labelledby={id}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h3 id={id} className="flex items-center gap-2 text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ---------------- Transaction card ---------------- */
function TransactionCard({ txn }: { txn: Txn }) {
  const [raw, setRaw] = React.useState(false);
  return (
    <Panel id="txn-h" title={<>Transaction <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{txn.source}</span></>}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{txn.vendorNorm}</p>
          <p className="num break-all text-xs text-muted-foreground">{txn.descriptionRaw}</p>
        </div>
        <AmountCell value={txn.amount} className="text-xl font-semibold" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        {[
          ["Date", <span className="num">{fmtDate(txn.date)}</span>],
          ["Reference", <span className="num break-all">{txn.reference ?? "—"}</span>],
          ["Account", <span className="num">{ACCOUNT_LABEL[txn.accountId] ?? txn.accountId}</span>],
          ["Transaction ID", <span className="num">{txn.id}</span>],
          ["GL code", txn.glCode ?? "—"],
          [
            "Source",
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate" title={txn.sourceFile}>{txn.sourceFile ?? "—"}</span>
              {txn.sourcePage && <span className="num shrink-0 text-sys">p.{txn.sourcePage}</span>}
            </span>,
          ],
        ].map(([k, v]) => (
          <div key={k as string} className="min-w-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={() => setRaw(!raw)} aria-expanded={raw} className="mt-3 flex items-center gap-1 text-xs text-sys hover:underline">
        <Braces className="h-3.5 w-3.5" /> {raw ? "Hide" : "View"} raw row
      </button>
      {raw && <pre className="num mt-2 max-h-48 overflow-auto rounded-md border bg-background p-2 text-2xs">{JSON.stringify(txn.rawRow, null, 2)}</pre>}
    </Panel>
  );
}

/* ---------------- Signals ---------------- */
function SignalsPanel({ f }: { f: FindingDetailT }) {
  const [open, setOpen] = React.useState(false);
  const { contributions } = noisyOr(f.signals.map((s) => s.score));
  return (
    <Panel id="sig-h" title="Detector signals" actions={<RiskMeter score={f.riskScore} />}>
      {f.signals.length === 0 ? (
        <p className="text-xs text-muted-foreground">No detector fired on this item.</p>
      ) : (
        <ul className="space-y-3">
          {f.signals.map((s) => (
            <li key={s.detector} className="flex items-start justify-between gap-3">
              <SignalChip signal={s} showText />
              <span className="num shrink-0 text-2xs text-muted-foreground">{DETECTOR_META[s.detector]?.label ?? s.detector}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-4 flex items-center gap-1 text-xs text-sys hover:underline">
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} /> How was this score calculated?
      </button>
      {open && (
        <div className="mt-2 rounded-md border bg-background p-3">
          <p className="mb-2 flex items-center gap-1 text-2xs text-muted-foreground">
            Noisy-OR: risk = 1 − Π(1 − sᵢ) <InfoTip term="noisy_or" />
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="py-1 font-semibold">Signal</th>
                <th scope="col" className="py-1 text-right font-semibold">Score</th>
                <th scope="col" className="py-1 text-right font-semibold">Adds</th>
                <th scope="col" className="py-1 text-right font-semibold">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {f.signals.map((s, i) => {
                const cum = contributions.slice(0, i + 1).reduce((a, b) => a + b, 0);
                return (
                  <tr key={s.detector} className="border-t border-border/50">
                    <td className="py-1">{DETECTOR_META[s.detector]?.label ?? s.detector}</td>
                    <td className="num py-1 text-right">{s.score.toFixed(2)}</td>
                    <td className="num py-1 text-right text-sys">+{(contributions[i] * 100).toFixed(1)}</td>
                    <td className="num py-1 text-right">{(cum * 100).toFixed(1)}</td>
                  </tr>
                );
              })}
              <tr className="border-t font-semibold">
                <td className="py-1">Combined risk</td>
                <td />
                <td />
                <td className="num py-1 text-right">{Math.round(f.riskScore * 100)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- Evidence ---------------- */
function TxnDialog({ txn, onClose }: { txn: Txn | null; onClose: () => void }) {
  return (
    <Dialog open={!!txn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{txn?.vendorNorm}</DialogTitle>
          <DialogDescription className="num">{txn?.id} · {txn?.source} · {txn && fmtDate(txn.date)}</DialogDescription>
        </DialogHeader>
        {txn && (
          <>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="num break-all text-xs text-muted-foreground">{txn.descriptionRaw}</span>
              <AmountCell value={txn.amount} className="ml-3 text-base font-semibold" />
            </div>
            <pre className="num max-h-64 overflow-auto rounded-md border bg-background p-2 text-2xs">{JSON.stringify(txn.rawRow, null, 2)}</pre>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EvidencePanel({ f }: { f: FindingDetailT }) {
  const [open, setOpen] = React.useState<Txn | null>(null);
  const values = f.vendorHistory.map((h) => moneyToNumber(h.amount));
  const hi = f.vendorHistory.findIndex((h) => h.txnId === f.txnId);
  return (
    <Panel id="ev-h" title="Evidence">
      <EvidenceList items={f.evidence} onOpen={(i) => setOpen(i.txn)} emptyText="No related transactions were found by the agent's tools." />
      <div className="mt-4">
        <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Vendor history · {f.txn.vendorNorm}</h4>
        {values.length >= 2 ? (
          <>
            <Sparkline values={values} highlightIndex={hi} label={`Past amounts for ${f.txn.vendorNorm}: ${values.length} transactions; this one highlighted in red`} />
            <p className="num mt-1 flex justify-between text-2xs text-muted-foreground">
              <span>{fmtDate(f.vendorHistory[0].date)}</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-crit" /> this transaction</span>
              <span>{fmtDate(f.vendorHistory.at(-1)!.date)}</span>
            </p>
          </>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">First transaction with this counterparty — no history to compare against.</p>
        )}
      </div>
      <TxnDialog txn={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}

/* ---------------- AI analysis ---------------- */
function AgentTrace({ f }: { f: FindingDetailT }) {
  const [open, setOpen] = React.useState(false);
  const total = f.agentTrace.reduce((a, s) => a + s.ms, 0);
  return (
    <div className="mt-4 border-t border-ai/20 pt-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-xs font-medium text-ai">
        <Wrench className="h-3.5 w-3.5" /> Agent trace · {f.agentTrace.length} tool calls · <span className="num">{(total / 1000).toFixed(1)}s</span>
        <ChevronDown className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="mt-3 space-y-0" aria-label="Agent tool calls">
          {f.agentTrace.map((s, i) => (
            <li key={i} className="relative flex gap-3 pb-3">
              {i < f.agentTrace.length - 1 && <span aria-hidden className="absolute left-[9px] top-5 h-full w-px bg-ai/30" />}
              <span className="num mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-ai/40 bg-ai/10 text-[9px] text-ai">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="num text-xs font-semibold text-ai">{s.tool}</code>
                  <span className="num ml-auto text-2xs text-muted-foreground">{s.ms} ms</span>
                </div>
                <p className="mt-0.5 text-xs">{s.outputSummary}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">Input</summary>
                  <pre className="num mt-1 overflow-x-auto rounded bg-background p-1.5 text-[10px]">{JSON.stringify(s.input, null, 2)}</pre>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AIPanel({ f, onCategory, canDecide, locked }: { f: FindingDetailT; onCategory: (c: Category) => void; canDecide: boolean; locked: boolean }) {
  const noEvidence = f.evidenceTxnIds.length === 0 && f.signals.every((s) => s.evidenceIds.length === 0);
  const cat = f.humanCategory ?? f.category;
  return (
    <section className="card border-ai/40 bg-ai/[0.03]" aria-labelledby="ai-h">
      <div className="flex items-center justify-between gap-2 border-b border-ai/20 px-4 py-2.5">
        <h3 id="ai-h" className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-ai" aria-hidden /> AI analysis <AIBadge />
        </h3>
        <span className="num text-2xs text-muted-foreground" title={fmtDateTime(f.createdAt)}>
          {f.model.name} · {f.model.version} · {fmtRelative(f.createdAt)}
        </span>
      </div>
      <div className="p-4">
        {noEvidence && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="alert">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span><strong>No supporting evidence — treat with caution.</strong> The agent did not cite any related transactions; its reasoning relies on detector signals and context only.</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Proposed category</span>
            {canDecide && !locked ? (
              <Select value={cat} onValueChange={(v) => v !== cat && onCategory(v as Category)}>
                <SelectTrigger className="h-7 w-auto gap-1 border-ai/30 text-xs" aria-label="Change category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_META[c].label}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <CategoryBadge category={cat} />
            )}
            {f.humanCategory && f.humanCategory !== f.category && <span className="text-2xs text-muted-foreground">(AI said {CATEGORY_META[f.category].label})</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Confidence</span>
            <ConfidenceBar value={f.confidence} variant="ai" label="AI confidence" width="w-20" />
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed">{f.explanation}</p>
        <div className="mt-3 rounded-md border border-ai/20 bg-background px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Suggested action</p>
          <p className="mt-0.5 text-sm">{f.suggestedAction}</p>
        </div>
        {f.routingReason && (
          <p className="mt-2 text-xs text-muted-foreground">
            Routed to human review: <span className="font-medium text-foreground">{f.routingReason}</span>
          </p>
        )}
        <AgentTrace f={f} />
      </div>
    </section>
  );
}

/* ---------------- Decision panel ---------------- */
function DecisionPanel({ f, onAction }: { f: FindingDetailT; onAction: (a: Exclude<DecisionAction, "reopen">) => void }) {
  const decision = useDecision(f.id, f.runId);
  const decided = f.status === "approved" || f.status === "rejected" || f.status === "auto_resolved";
  const notes = requiresNotes(f);
  return (
    <Panel id="dec-h" title="Decision" actions={<StatusBadge status={f.status} />}>
      {decided ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            {f.status === "auto_resolved" ? "Auto-resolved by the verifier (high confidence, low risk)." : <>This finding was <strong>{f.status}</strong>{f.falsePositive && " as a false positive"}.</>}
          </p>
          <Can perm="finding.decide">
            <Button variant="secondary" size="sm" onClick={() => decision.mutate({ action: "reopen" })} disabled={decision.isPending}>
              {decision.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reopen
            </Button>
          </Can>
        </div>
      ) : (
        <>
          {notes && (
            <p className="mb-3 flex items-center gap-1.5 text-xs text-warn">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Resolution notes are required for {f.category === "potential_fraud" ? "potential fraud" : "high-value"} items.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Can perm="finding.decide">
              <Button variant="success" size="sm" onClick={() => onAction("approve")} className="col-span-2 sm:col-span-1">
                <Check /> Approve <KeyboardHint keys={["A"]} className="ml-auto opacity-70" />
              </Button>
            </Can>
            <Can perm="finding.decide">
              <Button variant="destructive" size="sm" onClick={() => onAction("reject")}>
                <ThumbsDown /> Reject <KeyboardHint keys={["R"]} className="ml-auto opacity-70" />
              </Button>
            </Can>
            <Can perm="finding.decide">
              <Button variant="secondary" size="sm" onClick={() => onAction("escalate")} disabled={f.status === "escalated"}>
                <ArrowUpRight /> Escalate <KeyboardHint keys={["E"]} className="ml-auto opacity-70" />
              </Button>
            </Can>
            <Can perm="finding.decide">
              <Button variant="secondary" size="sm" onClick={() => onAction("change_category")} className="col-span-2 sm:col-span-1">
                <Sparkles /> Change category & approve
              </Button>
            </Can>
            <Can perm="finding.decide">
              <Button variant="ghost" size="sm" onClick={() => onAction("false_positive")} className="col-span-2 border sm:col-span-2">
                <Ban /> Mark as false positive
              </Button>
            </Can>
          </div>
        </>
      )}
    </Panel>
  );
}

/* ---------------- Comments ---------------- */
function CommentBox({ f, inputRef }: { f: FindingDetailT; inputRef: React.RefObject<HTMLTextAreaElement> }) {
  const comment = useComment(f.id);
  const [body, setBody] = React.useState("");
  const [mention, setMention] = React.useState<string | null>(null);
  const suggestions = mention !== null ? ALL_USERS_LIST.filter((u) => u.toLowerCase().includes(mention.toLowerCase())).slice(0, 4) : [];

  const onChange = (v: string) => {
    setBody(v);
    const m = /@([A-Za-z]*)$/.exec(v);
    setMention(m ? m[1] : null);
  };
  const insert = (name: string) => {
    setBody((b) => b.replace(/@([A-Za-z]*)$/, `@${name} `));
    setMention(null);
    inputRef.current?.focus();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    await comment.mutateAsync(body.trim());
    setBody("");
  };

  return (
    <Panel id="com-h" title={<>Comments <span className="num text-xs font-normal text-muted-foreground">{f.comments.length}</span></>}>
      {f.comments.length > 0 && (
        <ul className="mb-3 space-y-3">
          {f.comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-2xs font-semibold">
                {c.author.split(" ").map((p) => p[0]).join("")}
              </span>
              <div className="min-w-0">
                <p className="text-xs">
                  <span className="font-medium">{c.author}</span> <span className="text-muted-foreground">{fmtRelative(c.createdAt)}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
                  {c.body.split(/(@[A-Z][a-z]+ [A-Z][a-z]+)/g).map((part, i) => (part.startsWith("@") ? <span key={i} className="rounded bg-sys/10 px-0.5 text-sys">{part}</span> : part))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="relative">
        <label htmlFor={`comment-${f.id}`} className="sr-only">Add a comment</label>
        <Textarea
          id={`comment-${f.id}`}
          ref={inputRef}
          value={body}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            if (e.key === "Escape") (e.target as HTMLElement).blur();
          }}
          placeholder="Add a comment — type @ to mention a teammate (C to focus)"
          className="min-h-[64px] pr-12"
          aria-autocomplete="list"
          aria-controls={suggestions.length ? `mentions-${f.id}` : undefined}
        />
        <Button type="submit" size="icon-sm" className="absolute bottom-2 right-2" aria-label="Post comment" disabled={!body.trim() || comment.isPending}>
          {comment.isPending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
        {suggestions.length > 0 && (
          <ul id={`mentions-${f.id}`} role="listbox" aria-label="Mention suggestions" className="absolute left-2 top-full z-10 mt-1 w-56 rounded-md border bg-surface p-1 shadow-xl">
            {suggestions.map((u) => (
              <li key={u} role="option" aria-selected={false}>
                <button type="button" onClick={() => insert(u)} className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-2">@{u}</button>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Panel>
  );
}

function HistoryPanel({ f }: { f: FindingDetailT }) {
  return (
    <Panel id="hist-h" title={<><Clock className="h-4 w-4 text-muted-foreground" aria-hidden /> Audit history</>}>
      {f.history.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events yet.</p>
      ) : (
        <ol className="space-y-2.5">
          {f.history.map((a) => (
            <li key={a.id} className="flex items-start gap-2.5">
              <ActorIcon type={a.actor.type} />
              <div className="min-w-0 pt-0.5 text-xs">
                <p>
                  <span className={cn("font-medium", a.actor.type === "ai" && "text-ai")}>{a.actor.name}</span> <span className="text-muted-foreground">{describeAction(a)}</span>
                </p>
                <p className="num text-2xs text-muted-foreground">{fmtDateTime(a.ts)}{a.modelVersion && ` · ${a.modelVersion}`}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* ---------------- Main ---------------- */
export interface FindingDetailProps {
  findingId: string;
  layout?: "split" | "stack";
  onNext?: () => void;
  onPrev?: () => void;
  hotkeys?: boolean;
  /** Called after a decision is saved (used by focus mode to auto-advance). */
  onDecided?: (action: DecisionAction) => void;
}

export function FindingDetail({ findingId, layout = "split", onNext, onPrev, hotkeys = true, onDecided }: FindingDetailProps) {
  const { data: f, isLoading, error, refetch } = useFinding(findingId);
  const [action, setAction] = React.useState<Exclude<DecisionAction, "reopen"> | null>(null);
  const [category, setCategory] = React.useState<Category | undefined>();
  const commentRef = React.useRef<HTMLTextAreaElement>(null);
  const canDecide = useCan("finding.decide");
  const locked = !!f && (f.status === "approved" || f.status === "rejected" || f.status === "auto_resolved");

  const start = (a: Exclude<DecisionAction, "reopen">, cat?: Category) => {
    if (!canDecide || locked) return;
    setCategory(a === "change_category" ? (cat ?? f?.humanCategory ?? f?.category) : undefined);
    setAction(a);
  };

  useHotkeys(
    {
      a: () => start("approve"),
      r: () => start("reject"),
      e: () => f?.status !== "escalated" && start("escalate"),
      j: () => onNext?.(),
      k: () => onPrev?.(),
      c: () => commentRef.current?.focus(),
    },
    hotkeys && !action && !!f,
  );

  if (isLoading)
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        <div className="space-y-4"><Skeleton className="h-48" /><Skeleton className="h-40" /></div>
        <div className="space-y-4"><Skeleton className="h-64" /><Skeleton className="h-32" /></div>
      </div>
    );
  if (error instanceof ApiError && error.status === 404) return <EmptyState title="Finding not found" description="It may belong to an archived run." />;
  if (error || !f) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div className={cn("grid gap-4", layout === "split" && "lg:grid-cols-2")}>
      <div className="min-w-0 space-y-4">
        <TransactionCard txn={f.txn} />
        <SignalsPanel f={f} />
        <EvidencePanel f={f} />
      </div>
      <div className="min-w-0 space-y-4">
        <AIPanel f={f} canDecide={canDecide} locked={locked} onCategory={(c) => start("change_category", c)} />
        <DecisionPanel f={f} onAction={(a) => start(a)} />
        <CommentBox f={f} inputRef={commentRef} />
        <HistoryPanel f={f} />
      </div>
      <DecisionDialog finding={f} action={action} category={category} onOpenChange={(o) => !o && setAction(null)} onDone={onDecided} />
    </div>
  );
}
