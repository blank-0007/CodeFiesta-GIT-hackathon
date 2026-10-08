import * as React from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Category, DecisionAction, FindingView } from "@/api/types";
import { useDecision, useFinding, useSettings } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError, Label, Textarea } from "@/components/ui/form-controls";
import { AmountCell } from "@/components/shared/AmountCell";
import { CategoryBadge } from "@/components/shared/badges";
import { InfoTip } from "@/components/shared/misc";
import { Skeleton } from "@/components/ui/form-controls";
import { big } from "@/lib/money";
import { cn } from "@/lib/utils";

export const ACTION_META: Record<Exclude<DecisionAction, "reopen">, { label: string; verb: string; tone: "success" | "destructive" | "default" }> = {
  approve: { label: "Approve AI classification", verb: "approved", tone: "success" },
  change_category: { label: "Change category & approve", verb: "approved with new category", tone: "success" },
  reject: { label: "Reject AI classification", verb: "rejected", tone: "destructive" },
  escalate: { label: "Escalate to controller", verb: "escalated", tone: "default" },
  false_positive: { label: "Mark as false positive", verb: "marked as false positive", tone: "default" },
};

export function requiresNotes(f: FindingView, highValueThreshold = "500000.00") {
  return f.category === "potential_fraud" || big(f.txn.amount).abs().gte(highValueThreshold);
}

export interface DecisionDialogProps {
  finding: FindingView;
  action: Exclude<DecisionAction, "reopen"> | null;
  category?: Category;
  onOpenChange: (open: boolean) => void;
  onDone?: (action: DecisionAction) => void;
  initialNote?: string;
}

/**
 * Confirmation modal for every finding decision. Shows the impact on the
 * run's unexplained difference and enforces required notes/reasons.
 */
export function DecisionDialog({ finding, action, category, onOpenChange, onDone, initialNote = "" }: DecisionDialogProps) {
  const open = action !== null;
  const { data: detail, isLoading } = useFinding(open ? finding.id : undefined);
  const { data: settings } = useSettings();
  const decision = useDecision(finding.id, finding.runId);
  const [note, setNote] = React.useState(initialNote);
  const [touched, setTouched] = React.useState(false);
  const id = React.useId();

  React.useEffect(() => {
    if (open) {
      setNote(initialNote);
      setTouched(false);
    }
  }, [open, initialNote]);

  if (!action) return null;
  const meta = ACTION_META[action];
  const notesRequired = action === "reject" || (["approve", "change_category", "false_positive"].includes(action) && requiresNotes(finding, settings?.organization.highValueThreshold));
  const invalid = notesRequired && note.trim().length < 5;

  // Impact on unexplained difference
  const explainedNow = finding.status === "approved" || finding.status === "auto_resolved";
  const explainsAfter = action === "approve" || action === "change_category" || action === "false_positive";
  let before = detail?.impact.unexplainedBefore;
  let after = before;
  if (detail && before !== undefined) {
    const c = big(detail.impact.contribution);
    if (explainsAfter && !explainedNow) after = big(before).minus(c).toFixed(2);
    if (!explainsAfter && explainedNow) after = big(before).plus(c).toFixed(2);
  }
  if (before === undefined) before = after = undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    onOpenChange(false);
    try {
      await decision.mutateAsync({ action, category, reason: note.trim() || undefined });
      toast.success(`${finding.id} ${meta.verb}`, {
        duration: 10_000,
        action: { label: "Undo", onClick: () => decision.mutate({ action: "reopen" }) },
      });
      onDone?.(action);
    } catch {
      /* rollback + toast handled by useDecision */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{meta.label}?</DialogTitle>
            <DialogDescription>
              {finding.id} · {finding.txn.vendorNorm}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 rounded-md border bg-background p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Transaction</span>
              <AmountCell value={finding.txn.amount} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Category</span>
              <span className="flex items-center gap-1.5">
                {action === "change_category" && category && category !== (finding.humanCategory ?? finding.category) ? (
                  <>
                    <CategoryBadge category={finding.humanCategory ?? finding.category} />
                    <ArrowRight className="h-3 w-3 text-muted-foreground" aria-label="changes to" />
                    <CategoryBadge category={category} />
                  </>
                ) : (
                  <CategoryBadge category={finding.humanCategory ?? finding.category} />
                )}
              </span>
            </div>
            <div className="border-t pt-2">
              <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                Impact on unexplained difference <InfoTip term="unexplained" />
              </div>
              {isLoading || before === undefined ? (
                <Skeleton className="h-5 w-full" />
              ) : (
                <div className="flex items-center justify-between gap-2" data-testid="impact">
                  <AmountCell value={before} colorize={false} emphasis={big(before).eq(0) ? "none" : "crit"} />
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label="becomes" />
                  <AmountCell value={after!} colorize={false} emphasis={big(after!).eq(0) ? "none" : "crit"} className={cn(big(after!).eq(0) && "text-ok")} />
                </div>
              )}
              <p className="mt-1 text-2xs text-muted-foreground">
                {explainsAfter && !explainedNow
                  ? "Approving explains this item's contribution to bank − ledger."
                  : !explainsAfter && explainedNow
                    ? "This item will no longer count as explained."
                    : "No change to totals — the item stays unexplained until resolved."}
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor={`${id}-note`}>
              {action === "reject" ? "Reason" : "Resolution notes"} {notesRequired ? <span className="text-crit">*</span> : <span className="text-muted-foreground">(optional)</span>}
            </Label>
            <Textarea
              id={`${id}-note`}
              className="mt-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={touched && invalid}
              aria-describedby={`${id}-help`}
              placeholder={action === "reject" ? "Why is the AI's classification wrong?" : "What did you verify?"}
              autoFocus
            />
            <FieldError id={`${id}-help`} message={touched && invalid ? (action === "reject" ? "A reason is required to reject (min. 5 characters)." : "Notes are required for potential fraud and high-value items (min. 5 characters).") : undefined} />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={meta.tone === "success" ? "success" : meta.tone === "destructive" ? "destructive" : "default"} disabled={decision.isPending}>
              {decision.isPending && <Loader2 className="animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
