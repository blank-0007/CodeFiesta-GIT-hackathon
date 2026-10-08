import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardHint } from "@/components/shared/misc";
import { useUiStore } from "@/lib/store";
import { isMac } from "@/lib/utils";

const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: "Global",
    items: [
      [[isMac ? "⌘" : "Ctrl", "K"], "Command palette / search"],
      [["?"], "Show this help"],
      [["N"], "New reconciliation"],
      [["G", "D"], "Go to dashboard"],
      [["G", "R"], "Go to runs"],
      [["G", "Q"], "Go to review queue"],
      [["G", "U"], "Go to rules"],
      [["G", "P"], "Go to reports"],
      [["G", "A"], "Go to audit log"],
      [["G", "S"], "Go to settings"],
    ],
  },
  {
    title: "Finding detail & focus mode",
    items: [
      [["A"], "Approve AI classification"],
      [["R"], "Reject (asks for a reason)"],
      [["E"], "Escalate"],
      [["J"], "Next finding"],
      [["K"], "Previous finding"],
      [["C"], "Focus comment box"],
      [["Esc"], "Close drawer / exit focus mode"],
    ],
  },
  {
    title: "Unmatched workspace",
    items: [
      [["M"], "Match selected bank & ledger rows"],
      [["Space"], "Select / deselect focused row"],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useUiStore((s) => s.helpOpen);
  const set = useUiStore((s) => s.set);
  return (
    <Dialog open={open} onOpenChange={(o) => set({ helpOpen: o })}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-key shortcuts are disabled while you're typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title} className={g.title === "Global" ? "sm:row-span-2" : undefined}>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h3>
              <dl className="space-y-1.5">
                {g.items.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-sm">
                    <dt className="text-foreground/90">{label}</dt>
                    <dd>
                      <KeyboardHint keys={keys} />
                      <span className="sr-only">{keys.join(" then ")}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
