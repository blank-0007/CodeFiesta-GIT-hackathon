import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, PartyPopper, X } from "lucide-react";
import type { ReviewItem } from "@/api/types";
import { api, qk } from "@/api/endpoints";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/form-controls";
import { KeyboardHint } from "@/components/shared/misc";
import { CategoryBadge } from "@/components/shared/badges";
import { FindingDetail } from "@/features/anomalies/FindingDetail";
import { fmtPeriod } from "@/lib/format";
import { useHotkeys } from "@/hooks/useHotkeys";

/**
 * Full-screen, card-by-card review. The list is a snapshot taken on entry so
 * items don't jump around as they're decided. The next item is prefetched.
 */
export function FocusMode({ items, onExit }: { items: ReviewItem[]; onExit: () => void }) {
  const qc = useQueryClient();
  const [i, setI] = React.useState(0);
  const [done, setDone] = React.useState<Set<string>>(new Set());
  const current = items[i];
  const finished = i >= items.length;

  React.useEffect(() => {
    const next = items[i + 1];
    if (next) qc.prefetchQuery({ queryKey: qk.finding(next.finding.id), queryFn: () => api.finding(next.finding.id) });
  }, [i, items, qc]);

  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc exits — unless a Radix dialog (e.g. the decision confirmation) is open on top.
  useHotkeys({ escape: () => !document.querySelector('[role="dialog"][data-state="open"]') && onExit() });

  const go = (n: number) => setI(Math.max(0, Math.min(items.length, n)));

  return (
    <div role="dialog" aria-modal="true" aria-label="Focus review mode" className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-6">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Focus review</p>
          <p className="num text-xs text-muted-foreground" aria-live="polite">
            {finished ? `${items.length} of ${items.length}` : `${i + 1} of ${items.length}`} · {done.size} decided
          </p>
        </div>
        <Progress value={(Math.min(i, items.length) / Math.max(1, items.length)) * 100} className="order-last w-full md:order-none md:w-64" indicatorClassName="bg-ok" aria-label="Review progress" />
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 hidden items-center gap-1 text-2xs text-muted-foreground lg:flex">
            <KeyboardHint keys={["A"]} /> approve <KeyboardHint keys={["R"]} /> reject <KeyboardHint keys={["E"]} /> escalate <KeyboardHint keys={["J"]} /><KeyboardHint keys={["K"]} /> navigate
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Previous item" disabled={i === 0} onClick={() => go(i - 1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next item" disabled={finished} onClick={() => go(i + 1)}>
            <ChevronRight />
          </Button>
          <Button variant="secondary" size="sm" onClick={onExit}>
            <X /> Exit <KeyboardHint keys={["Esc"]} className="ml-1 hidden sm:inline-flex" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
        {finished ? (
          <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center">
            <PartyPopper className="h-10 w-10 text-ok" aria-hidden />
            <h2 className="mt-3 text-lg font-semibold">Queue cleared</h2>
            <p className="mt-1 text-sm text-muted-foreground">You reviewed {done.size} of {items.length} items. Undo is available from the notifications for 10 seconds after each decision.</p>
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" onClick={() => go(0)}>Review again</Button>
              <Button onClick={onExit}>Back to queue</Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[1400px]">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <CategoryBadge category={current.finding.humanCategory ?? current.finding.category} />
              <span className="rounded bg-attn/10 px-1.5 py-0.5 font-medium text-attn">{current.routingReason}</span>
              <span className="text-muted-foreground">{fmtPeriod(current.finding.runPeriod)} · waiting {current.waitingDays}d</span>
            </div>
            <FindingDetail
              key={current.finding.id}
              findingId={current.finding.id}
              layout={typeof window !== "undefined" && window.innerWidth < 1024 ? "stack" : "split"}
              onNext={() => go(i + 1)}
              onPrev={() => go(i - 1)}
              onDecided={() => {
                setDone((d) => new Set(d).add(current.finding.id));
                setTimeout(() => go(i + 1), 250);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
