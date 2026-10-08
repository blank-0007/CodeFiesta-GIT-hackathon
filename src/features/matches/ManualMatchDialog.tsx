import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { Txn } from "@/api/types";
import { useManualMatch } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError, Label, Textarea } from "@/components/ui/form-controls";
import { AmountCell } from "@/components/shared/AmountCell";
import { fmtDate } from "@/lib/format";
import { big, sumMoney } from "@/lib/money";

const schema = z.object({ note: z.string().trim().min(5, "Add a note of at least 5 characters explaining why these belong together.") });

function Side({ title, txns }: { title: string; txns: Txn[] }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs font-medium">
        <span>{title} · {txns.length}</span>
        <AmountCell value={sumMoney(txns.map((t) => t.amount))} />
      </div>
      <ul className="max-h-36 overflow-y-auto text-xs">
        {txns.map((t) => (
          <li key={t.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-1 last:border-0">
            <span className="num text-muted-foreground">{fmtDate(t.date)}</span>
            <span className="min-w-0 flex-1 truncate" title={t.descriptionRaw}>{t.vendorNorm}</span>
            <AmountCell value={t.amount} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ManualMatchDialog({
  open,
  onOpenChange,
  runId,
  bank,
  ledger,
  onMatched,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  runId: string;
  bank: Txn[];
  ledger: Txn[];
  onMatched: () => void;
}) {
  const match = useManualMatch(runId);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { note: "" } });
  useEffect(() => {
    if (open) form.reset({ note: "" });
  }, [open, form]);
  const diff = big(sumMoney(bank.map((t) => t.amount))).minus(sumMoney(ledger.map((t) => t.amount)));

  const submit = form.handleSubmit(async ({ note }) => {
    try {
      await match.mutateAsync({ bankTxnIds: bank.map((t) => t.id), ledgerTxnIds: ledger.map((t) => t.id), note });
      onOpenChange(false);
      onMatched();
    } catch {
      /* toast from hook */
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create manual match</DialogTitle>
            <DialogDescription>
              {bank.length} bank ↔ {ledger.length} ledger transaction{bank.length + ledger.length > 2 ? "s" : ""}. Manual matches are recorded in the audit log with your note.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Side title="Bank" txns={bank} />
            <Side title="Ledger" txns={ledger} />
          </div>
          <div
            className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${diff.eq(0) ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}
            role="status"
            data-testid="match-diff"
          >
            <span className="flex items-center gap-1.5">
              {diff.eq(0) ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {diff.eq(0) ? "Sums agree exactly" : "Sums differ — the difference stays on this pair"}
            </span>
            <AmountCell value={diff.toFixed(2)} colorize={false} sign="always" />
          </div>
          <div>
            <Label htmlFor="mm-note">Note <span className="text-crit">*</span></Label>
            <Textarea id="mm-note" className="mt-1" placeholder="e.g. Same invoice INV-2041; bank batched two days late." aria-invalid={!!form.formState.errors.note} aria-describedby="mm-note-err" autoFocus {...form.register("note")} />
            <FieldError id="mm-note-err" message={form.formState.errors.note?.message} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={match.isPending}>
              {match.isPending && <Loader2 className="animate-spin" />} Create match
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
