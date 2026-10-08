import { memo, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightLeft, Check, ExternalLink, GripVertical, Inbox, Sparkles, X } from "lucide-react";
import type { Run, Txn, UnmatchedItem } from "@/api/types";
import { useUnmatched } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { AmountCell } from "@/components/shared/AmountCell";
import { RiskMeter } from "@/components/shared/RiskMeter";
import { CategoryBadge } from "@/components/shared/badges";
import { SignalChip } from "@/components/shared/evidence";
import { Can, EmptyState, ErrorState, KeyboardHint, SkeletonRows } from "@/components/shared/misc";
import { SearchInput } from "@/components/shared/filters";
import { useUrlParam } from "@/hooks/useUrlState";
import { useHotkeys } from "@/hooks/useHotkeys";
import { useCan } from "@/lib/permissions";
import { fmtDate, daysBetween } from "@/lib/format";
import { vendorSimilarity } from "@/lib/fuzzy";
import { big, sumMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ManualMatchDialog } from "./ManualMatchDialog";

type Side = "bank" | "ledger";

/** Ranks counterpart candidates for a selected row (client-side preview). */
export function rankCandidates(t: Txn, pool: Txn[], limit = 5) {
  const a = big(t.amount).abs();
  return pool
    .map((o) => {
      const b = big(o.amount).abs();
      const amountSim = a.eq(0) ? 0 : Math.max(0, 1 - Number(a.minus(b).abs().div(a).toFixed(4)) * 4);
      const dateSim = Math.max(0, 1 - Math.abs(daysBetween(t.date, o.date)) * 0.1);
      const sameSign = big(t.amount).gte(0) === big(o.amount).gte(0);
      const v = vendorSimilarity(t.vendorNorm, o.vendorNorm);
      const score = sameSign ? 0.5 * amountSim + 0.2 * dateSim + 0.3 * v : 0;
      return { txn: o, score: Math.round(score * 100) / 100 };
    })
    .filter((c) => c.score > 0.25)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

const Row = memo(function Row({
  item,
  side,
  selected,
  onToggle,
  onDropPair,
  canMatch,
  runId,
}: {
  item: UnmatchedItem;
  side: Side;
  selected: boolean;
  onToggle: () => void;
  onDropPair: (fromSide: Side, fromId: string) => void;
  canMatch: boolean;
  runId: string;
}) {
  const [over, setOver] = useState(false);
  const t = item.txn;
  return (
    <li
      draggable={canMatch}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-recon", JSON.stringify({ side, id: t.id }));
        e.dataTransfer.effectAllowed = "link";
      }}
      onDragOver={(e) => {
        if (!canMatch || !e.dataTransfer.types.includes("application/x-recon")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        try {
          const d = JSON.parse(e.dataTransfer.getData("application/x-recon")) as { side: Side; id: string };
          if (d.side !== side) onDropPair(d.side, d.id);
        } catch {
          /* ignore */
        }
      }}
      className={cn("group relative border-b border-border/60 transition-colors last:border-0", over && "bg-sys/10 ring-2 ring-inset ring-sys")}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${t.id}, ${t.vendorNorm}, ${fmtDate(t.date)}, ${big(t.amount).lt(0) ? "debit" : "credit"} ${big(t.amount).abs().toFixed(2)}${item.category ? `, ${item.category}` : ""}`}
        onClick={onToggle}
        className={cn("flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface-2/60 focus-visible:bg-surface-2", selected && "bg-sys/10 hover:bg-sys/15")}
      >
        {canMatch && <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground" aria-hidden />}
        <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border", selected ? "border-sys bg-sys text-[rgb(var(--on-accent))]" : "border-muted-foreground/50")} aria-hidden>
          {selected && <Check className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{t.vendorNorm}</span>
            {item.category && <CategoryBadge category={item.category} />}
          </span>
          <span className="num block truncate text-2xs text-muted-foreground" title={t.descriptionRaw}>
            {fmtDate(t.date)} · {t.id} · {t.descriptionRaw}
          </span>
          {item.signals.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {item.signals.slice(0, 3).map((s) => <SignalChip key={s.detector} signal={s} />)}
              {item.signals.length > 3 && <span className="text-2xs text-muted-foreground">+{item.signals.length - 3}</span>}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <AmountCell value={t.amount} className="text-sm" />
          <RiskMeter score={item.riskScore} size="sm" showLabel={false} />
        </span>
      </button>
      {item.findingId && (
        <Link
          to={`/runs/${runId}?tab=anomalies&finding=${item.findingId}`}
          className="absolute bottom-2 right-24 hidden items-center gap-1 rounded px-1 text-2xs text-sys hover:underline group-hover:flex group-focus-within:flex"
          aria-label={`Open finding ${item.findingId}`}
        >
          {item.findingId} <ExternalLink className="h-3 w-3" />
        </Link>
      )}
    </li>
  );
});

function Column({
  title,
  side,
  items,
  selected,
  toggle,
  onDropPair,
  canMatch,
  runId,
  total,
}: {
  title: string;
  side: Side;
  items: UnmatchedItem[];
  selected: Set<string>;
  toggle: (side: Side, id: string) => void;
  onDropPair: (targetSide: Side, targetId: string, fromSide: Side, fromId: string) => void;
  canMatch: boolean;
  runId: string;
  total: number;
}) {
  return (
    <section className="card flex min-w-0 flex-col" aria-label={title}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">
          {title} <span className="num ml-1 text-xs font-normal text-muted-foreground">{items.length}{items.length !== total && ` of ${total}`}</span>
        </h3>
        <AmountCell value={sumMoney(items.map((i) => i.txn.amount))} className="text-xs" />
      </div>
      {items.length === 0 ? (
        <EmptyState icon={Inbox} title={total ? "No items match your search" : `No ${side}-only items`} description={total ? undefined : "Everything on this side is matched."} />
      ) : (
        <ul className="max-h-[560px] overflow-y-auto" aria-label={`${title} transactions`}>
          {items.map((i) => (
            <Row
              key={i.txn.id}
              item={i}
              side={side}
              selected={selected.has(i.txn.id)}
              onToggle={() => toggle(side, i.txn.id)}
              onDropPair={(fromSide, fromId) => onDropPair(side, i.txn.id, fromSide, fromId)}
              canMatch={canMatch}
              runId={runId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function UnmatchedTab({ run }: { run: Run }) {
  const { data, isLoading, error, refetch } = useUnmatched(run.id, run);
  const canMatch = useCan("match.manual") && run.status !== "completed";
  const [q, setQ] = useUrlParam("uq");
  const [selBank, setSelBank] = useState<Set<string>>(new Set());
  const [selLedger, setSelLedger] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);

  const filter = (items: UnmatchedItem[]) => {
    const ql = q.toLowerCase();
    return ql ? items.filter((i) => `${i.txn.id} ${i.txn.descriptionRaw} ${i.txn.vendorNorm} ${i.txn.amount}`.toLowerCase().includes(ql)) : items;
  };
  const bank = useMemo(() => filter(data?.bank ?? []), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const ledger = useMemo(() => filter(data?.ledger ?? []), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (side: Side, id: string) => {
    const set = side === "bank" ? setSelBank : setSelLedger;
    set((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const clear = () => {
    setSelBank(new Set());
    setSelLedger(new Set());
  };
  const onDropPair = (targetSide: Side, targetId: string, _fromSide: Side, fromId: string) => {
    const b = targetSide === "bank" ? targetId : fromId;
    const l = targetSide === "ledger" ? targetId : fromId;
    setSelBank(new Set([b]));
    setSelLedger(new Set([l]));
    setDialog(true);
  };

  const ready = selBank.size > 0 && selLedger.size > 0;
  useHotkeys({ m: () => ready && canMatch && setDialog(true) }, !dialog);

  const all = { bank: data?.bank ?? [], ledger: data?.ledger ?? [] };
  const pick = (side: Side, ids: Set<string>) => all[side].filter((i) => ids.has(i.txn.id)).map((i) => i.txn);
  const selectedBank = pick("bank", selBank);
  const selectedLedger = pick("ledger", selLedger);

  // Suggestions for a single selected row on one side
  const anchor = selBank.size === 1 && selLedger.size === 0 ? selectedBank[0] : selLedger.size === 1 && selBank.size === 0 ? selectedLedger[0] : undefined;
  const suggestions = anchor ? rankCandidates(anchor, (anchor.source === "bank" ? all.ledger : all.bank).map((i) => i.txn)) : [];

  if (isLoading) return <div className="grid gap-4 lg:grid-cols-2"><div className="card"><SkeletonRows rows={8} cols={3} /></div><div className="card"><SkeletonRows rows={8} cols={3} /></div></div>;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search unmatched…" label="Search unmatched items" />
        <p className="hidden text-xs text-muted-foreground md:block">
          {canMatch ? "Drag a bank row onto a ledger row, or select one or more on each side." : "Read-only — your role can't create matches."}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {(selBank.size > 0 || selLedger.size > 0) && (
            <>
              <span className="num text-xs text-muted-foreground" aria-live="polite">
                {selBank.size} bank · {selLedger.size} ledger selected
              </span>
              <Button variant="ghost" size="sm" onClick={clear}><X /> Clear</Button>
            </>
          )}
          <Can perm="match.manual">
            <Button size="sm" disabled={!ready || run.status === "completed"} onClick={() => setDialog(true)}>
              <ArrowRightLeft /> Match manually <KeyboardHint keys={["M"]} className="ml-1 opacity-80" />
            </Button>
          </Can>
        </div>
      </div>

      {anchor && (
        <section className="card border-ai/30 p-3" aria-label="Suggested candidates">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-ai" aria-hidden /> Suggested candidates for <span className="num">{anchor.id}</span>
            <span className="font-normal text-muted-foreground">— ranked by amount, date and vendor similarity</span>
          </h3>
          {suggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No plausible candidates on the {anchor.source === "bank" ? "ledger" : "bank"} side. This item may be missing on the other side.</p>
          ) : (
            <ul className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
              {suggestions.map((s) => (
                <li key={s.txn.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                  <span className="num w-10 text-xs font-semibold text-sys">{Math.round(s.score * 100)}%</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{s.txn.vendorNorm}</span>
                    <span className="num block text-2xs text-muted-foreground">{fmtDate(s.txn.date)} · {s.txn.id}</span>
                  </span>
                  <AmountCell value={s.txn.amount} className="text-xs" />
                  <Button size="xs" variant="secondary" onClick={() => toggle(s.txn.source, s.txn.id)} aria-label={`Select ${s.txn.id}`} disabled={!canMatch}>Select</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Column title="Bank only" side="bank" items={bank} total={all.bank.length} selected={selBank} toggle={toggle} onDropPair={onDropPair} canMatch={canMatch} runId={run.id} />
        <Column title="Ledger only" side="ledger" items={ledger} total={all.ledger.length} selected={selLedger} toggle={toggle} onDropPair={onDropPair} canMatch={canMatch} runId={run.id} />
      </div>

      <ManualMatchDialog open={dialog} onOpenChange={setDialog} runId={run.id} bank={selectedBank} ledger={selectedLedger} onMatched={clear} />
    </div>
  );
}
