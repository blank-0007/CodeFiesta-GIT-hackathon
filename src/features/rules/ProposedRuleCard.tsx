import * as React from "react";
import { Check, Pencil, ShieldAlert, ThumbsDown, TrendingUp, Replace, Loader2 } from "lucide-react";
import type { ProposedRule } from "@/api/types";
import { useRuleDecision } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError, Label, Textarea } from "@/components/ui/form-controls";
import { AmountCell } from "@/components/shared/AmountCell";
import { AIBadge, StatusBadge } from "@/components/shared/badges";
import { ConfidenceBar } from "@/components/shared/ConfidenceBar";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { DiffView } from "@/components/shared/DiffView";
import { Can } from "@/components/shared/misc";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function ParamsPreview({ params }: { params: Record<string, unknown> }) {
  return (
    <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border bg-background p-2.5 text-2xs">
      {Object.entries(params).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-all">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function EditDialog({ rule, open, onOpenChange }: { rule: ProposedRule; open: boolean; onOpenChange: (o: boolean) => void }) {
  const decide = useRuleDecision();
  const [text, setText] = React.useState(() => JSON.stringify(rule.params, null, 2));
  const [err, setErr] = React.useState<string>();
  React.useEffect(() => {
    if (open) {
      setText(JSON.stringify(rule.params, null, 2));
      setErr(undefined);
    }
  }, [open, rule.params]);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!parsed || typeof parsed !== "object") return setErr("Parameters must be a valid JSON object.");
            await decide.mutateAsync({ id: rule.id, action: "edit_approve", params: parsed });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit & approve rule</DialogTitle>
            <DialogDescription>{rule.title}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor={`edit-${rule.id}`}>Parameters (JSON)</Label>
              <Textarea id={`edit-${rule.id}`} value={text} onChange={(e) => setText(e.target.value)} className="num mt-1 min-h-[200px] text-xs" aria-invalid={!parsed} spellCheck={false} />
              <FieldError message={err ?? (!parsed ? "Invalid JSON" : undefined)} />
            </div>
            <div>
              <p className="text-xs font-medium">Changes vs AI proposal</p>
              <DiffView before={rule.params} after={parsed ?? rule.params} className="mt-1 max-h-[220px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="success" disabled={!parsed || decide.isPending}>
              {decide.isPending && <Loader2 className="animate-spin" />} Approve edited rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProposedRuleCard({ rule }: { rule: ProposedRule }) {
  const decide = useRuleDecision();
  const [edit, setEdit] = React.useState(false);
  const [reject, setReject] = React.useState(false);
  const decided = rule.status !== "proposed";
  return (
    <article className={cn("card border-ai/30", decided && "opacity-75")} aria-labelledby={`pr-${rule.id}`}>
      <header className="flex flex-wrap items-start gap-2 border-b border-ai/20 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <AIBadge label="AI proposal" />
            <StatusBadge status={rule.status} />
            <span className="num text-2xs text-muted-foreground">{rule.id} · {rule.scope}</span>
          </div>
          <h3 id={`pr-${rule.id}`} className="mt-1.5 text-sm font-semibold">{rule.title}</h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Confidence <ConfidenceBar value={rule.confidence} variant="ai" label="AI confidence in this rule" />
        </div>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <p className="text-sm leading-relaxed">{rule.description}</p>
          <div>
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Structured preview</p>
            <ParamsPreview params={rule.params} />
          </div>
          <div className="rounded-md border border-sys/20 bg-sys/5 p-3">
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">What would have changed</p>
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-ok" aria-hidden />
                <span className="num text-lg font-semibold">+{rule.simulation.matchesGained}</span>
                <span className="text-xs text-muted-foreground">matches gained</span>
              </div>
              <div className="flex items-center gap-2">
                <Replace className="h-4 w-4 text-warn" aria-hidden />
                <span className="num text-lg font-semibold">{rule.simulation.matchesChanged}</span>
                <span className="text-xs text-muted-foreground">matches changed</span>
              </div>
            </div>
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {rule.simulation.examples.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          </div>
        </div>
        <div>
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Supporting evidence · {rule.supportingTxnIds.length} transactions fit the pattern
          </p>
          {rule.supportingTxns.length ? (
            <div className="max-h-56 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <caption className="sr-only">Transactions supporting this rule</caption>
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-2xs uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="px-2 py-1.5 font-semibold">Date</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Narration</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rule.supportingTxns.map((t) => (
                    <tr key={t.id} className="border-t border-border/50">
                      <td className="num whitespace-nowrap px-2 py-1">{fmtDate(t.date)}</td>
                      <td className="num max-w-[220px] truncate px-2 py-1" title={t.descriptionRaw}>{t.descriptionRaw}</td>
                      <td className="px-2 py-1 text-right"><AmountCell value={t.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">Evidence drawn from previous runs.</p>
          )}
          <p className="num mt-2 text-2xs text-muted-foreground">Proposed by {rule.model.name} · {rule.model.version}</p>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <p className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 text-ai" aria-hidden /> Rules never activate without human approval.
        </p>
        {!decided && (
          <>
            <Can perm="rule.decide">
              <Button size="sm" variant="ghost" onClick={() => setReject(true)}><ThumbsDown /> Reject</Button>
            </Can>
            <Can perm="rule.decide">
              <Button size="sm" variant="secondary" onClick={() => setEdit(true)}><Pencil /> Edit & approve</Button>
            </Can>
            <Can perm="rule.decide">
              <Button size="sm" variant="success" disabled={decide.isPending} onClick={() => decide.mutate({ id: rule.id, action: "approve" })}>
                {decide.isPending ? <Loader2 className="animate-spin" /> : <Check />} Approve
              </Button>
            </Can>
          </>
        )}
      </footer>
      <EditDialog rule={rule} open={edit} onOpenChange={setEdit} />
      <ConfirmDialog
        open={reject}
        onOpenChange={setReject}
        title="Reject this rule proposal?"
        description="The agent will stop proposing this rule for the same pattern. Your reason helps it learn."
        confirmLabel="Reject rule"
        tone="destructive"
        requireReason={5}
        pending={decide.isPending}
        onConfirm={async (reason) => {
          await decide.mutateAsync({ id: rule.id, action: "reject", reason });
          setReject(false);
        }}
      />
    </article>
  );
}
