import * as React from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
import { Sheet, SheetContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/menus";
import { KeyboardHint } from "@/components/shared/misc";
import { useUiStore } from "@/lib/store";
import { FindingDetail } from "./FindingDetail";

const MIN = 480;
const MAX = 1400;

/** Right-side, resizable drawer. Width persists per user. J/K move through `ids`. */
export function FindingDrawer({
  findingId,
  runId,
  ids,
  onChange,
}: {
  findingId: string | null;
  runId: string;
  ids: string[];
  onChange: (id: string | null) => void;
}) {
  const width = useUiStore((s) => s.drawerWidth);
  const set = useUiStore((s) => s.set);
  const [dragging, setDragging] = React.useState(false);
  const idx = findingId ? ids.indexOf(findingId) : -1;
  const next = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
  const prev = idx > 0 ? ids[idx - 1] : null;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => set({ drawerWidth: Math.min(MAX, Math.max(MIN, window.innerWidth - ev.clientX)) });
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <Sheet open={!!findingId} onOpenChange={(o) => !o && onChange(null)}>
      <SheetContent width={width} className={dragging ? "select-none transition-none" : undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          aria-valuenow={width}
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") set({ drawerWidth: Math.min(MAX, width + 40) });
            if (e.key === "ArrowRight") set({ drawerWidth: Math.max(MIN, width - 40) });
          }}
          className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-sys/30 focus-visible:bg-sys/40 sm:block"
        />
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="num text-sm font-semibold">{findingId}</DialogTitle>
            <DialogDescription className="text-2xs text-muted-foreground">
              {idx >= 0 ? `${idx + 1} of ${ids.length}` : ""} · <KeyboardHint keys={["J"]} /> next <KeyboardHint keys={["K"]} /> previous
            </DialogDescription>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Tip content="Previous (K)">
              <Button variant="ghost" size="icon-sm" aria-label="Previous finding" disabled={!prev} onClick={() => prev && onChange(prev)}>
                <ChevronUp />
              </Button>
            </Tip>
            <Tip content="Next (J)">
              <Button variant="ghost" size="icon-sm" aria-label="Next finding" disabled={!next} onClick={() => next && onChange(next)}>
                <ChevronDown />
              </Button>
            </Tip>
            {findingId && (
              <Tip content="Open full page">
                <Button asChild variant="ghost" size="icon-sm">
                  <Link to={`/runs/${runId}/findings/${findingId}`} aria-label="Open full page">
                    <Maximize2 />
                  </Link>
                </Button>
              </Tip>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Close drawer" onClick={() => onChange(null)}>
              <X />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {findingId && (
            <FindingDetail
              key={findingId}
              findingId={findingId}
              layout={width >= 960 ? "split" : "stack"}
              onNext={() => next && onChange(next)}
              onPrev={() => prev && onChange(prev)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
