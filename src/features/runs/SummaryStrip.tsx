import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Run } from "@/api/types";
import { AmountCell } from "@/components/shared/AmountCell";
import { InfoTip } from "@/components/shared/misc";
import { Tip } from "@/components/ui/menus";
import { big } from "@/lib/money";
import { cn } from "@/lib/utils";

export function runDifference(run: Run) {
  const diff = big(run.stats.bankTotal).minus(run.stats.ledgerTotal);
  const unexplained = diff.minus(run.stats.explained);
  return { difference: diff.toFixed(2), unexplained: unexplained.toFixed(2) };
}

function Cell({ label, children, help, className }: { label: string; children: React.ReactNode; help?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 px-4 py-2.5", className)}>
      <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {help && <InfoTip>{help}</InfoTip>}
      </span>
      <div className="truncate text-sm font-semibold 2xl:text-base">{children}</div>
    </div>
  );
}

export function SummaryStrip({ run }: { run: Run }) {
  const { difference, unexplained } = runDifference(run);
  const bad = !big(unexplained).eq(0);
  return (
    <section aria-label="Reconciliation totals" className="card grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
      <Cell label="Bank total" help="Net movement of all bank transactions in the period." className="border-b border-r border-border/60 sm:border-r lg:border-b-0">
        <AmountCell value={run.stats.bankTotal} colorize={false} />
      </Cell>
      <Cell label="Ledger total" help="Net movement of all ledger entries posted to the bank GL accounts." className="border-b border-border/60 sm:border-r lg:border-b-0">
        <AmountCell value={run.stats.ledgerTotal} colorize={false} />
      </Cell>
      <Cell label="Difference" help="Bank total − ledger total." className="border-b border-r border-border/60 sm:border-b sm:border-r-0 lg:border-b-0">
        <AmountCell value={difference} colorize={false} sign="always" />
      </Cell>
      <Cell label="Explained" help="Classified and approved differences, plus amounts within matching tolerance." className="border-b border-border/60 sm:border-b sm:border-r lg:border-b-0">
        <AmountCell value={run.stats.explained} colorize={false} sign="always" className="text-ok" />
      </Cell>
      <Tip content="Integrity check: bank − ledger must equal explained differences. Anything left is unexplained and must be resolved before finalizing.">
        <div
          tabIndex={0}
          className={cn("col-span-2 flex flex-col gap-0.5 rounded-b-lg px-4 py-2.5 sm:col-span-2 lg:col-span-1 lg:rounded-b-none lg:rounded-r-lg", bad ? "bg-crit/10" : "bg-ok/5")}
          aria-label={`Unexplained difference ${bad ? "— integrity check failing" : "— integrity check passing"}`}
        >
          <span className={cn("flex items-center gap-1 text-2xs font-medium uppercase tracking-wider", bad ? "text-crit" : "text-ok")}>
            {bad ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <CheckCircle2 className="h-3 w-3" aria-hidden />}
            Unexplained
          </span>
          <div className="truncate text-sm font-semibold 2xl:text-base">
            <AmountCell value={unexplained} colorize={false} sign="always" emphasis={bad ? "crit" : "none"} className={cn(!bad && "text-ok")} />
          </div>
        </div>
      </Tip>
    </section>
  );
}
