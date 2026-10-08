import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { ArrowRightLeft, Building, Download, FileText, Inbox, Moon, Play, Plus, Store } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { api, qk } from "@/api/endpoints";
import { useUiStore } from "@/lib/store";
import { NAV } from "./Sidebar";
import { AmountCell } from "@/components/shared/AmountCell";
import { KeyboardHint } from "@/components/shared/misc";
import { downloadReport } from "@/features/reports/download";
import { toastError } from "@/api/queries";
import { toast } from "sonner";

function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandOpen);
  const set = useUiStore((s) => s.set);
  const theme = useUiStore((s) => s.theme);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const { data, isFetching } = useQuery({ queryKey: ["search", dq], queryFn: () => api.search(dq), enabled: open && dq.length >= 2 });

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const close = () => set({ commandOpen: false });
  const go = (to: string) => {
    close();
    navigate(to);
  };
  const latestRunId = async () => {
    const runs = await qc.fetchQuery({ queryKey: qk.runs, queryFn: api.runs });
    return runs.find((r) => r.status === "awaiting_review" || r.status === "completed")?.id;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => set({ commandOpen: o })}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0" hideClose aria-describedby={undefined}>
        <VisuallyHidden.Root>
          <DialogTitle>Command palette</DialogTitle>
        </VisuallyHidden.Root>
        <Command shouldFilter={dq.length < 2} loop>
          <CommandInput value={q} onValueChange={setQ} placeholder="Type a command, run, transaction ID (B-2609-0001) or vendor…" />
          <CommandList>
            <CommandEmpty>{isFetching ? "Searching…" : "No results."}</CommandEmpty>
            {dq.length >= 2 && data && (
              <>
                {data.txns.length > 0 && (
                  <CommandGroup heading="Transactions & findings">
                    {data.txns.map((t) => (
                      <CommandItem
                        key={`${t.runId}-${t.id}`}
                        value={`txn ${t.id} ${t.description}`}
                        onSelect={() => go(t.findingId ? `/runs/${t.runId}/findings/${t.findingId}` : `/runs/${t.runId}?tab=matched&q=${encodeURIComponent(t.id)}`)}
                      >
                        <ArrowRightLeft />
                        <div className="min-w-0 flex-1">
                          <div className="num truncate text-xs">{t.id}{t.findingId && <span className="ml-2 text-attn">{t.findingId}</span>}</div>
                          <div className="truncate text-2xs text-muted-foreground">{t.description}</div>
                        </div>
                        <AmountCell value={t.amount} className="text-xs" />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {data.runs.length > 0 && (
                  <CommandGroup heading="Runs">
                    {data.runs.map((r) => (
                      <CommandItem key={r.id} value={`run ${r.id} ${r.name}`} onSelect={() => go(`/runs/${r.id}`)}>
                        <Play />
                        <span className="flex-1 truncate">{r.name}</span>
                        <span className="num text-2xs text-muted-foreground">{r.id}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {data.vendors.length > 0 && (
                  <CommandGroup heading="Vendors">
                    {data.vendors.map((v) => (
                      <CommandItem
                        key={v.name}
                        value={`vendor ${v.name}`}
                        onSelect={async () => {
                          const id = await latestRunId();
                          go(`/runs/${id}?tab=matched&q=${encodeURIComponent(v.name)}`);
                        }}
                      >
                        <Store />
                        <span className="flex-1 truncate">{v.name}</span>
                        <span className="num text-2xs text-muted-foreground">{v.count} txns</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Actions">
              <CommandItem value="new reconciliation run" onSelect={() => go("/runs/new")}>
                <Plus /> New reconciliation <KeyboardHint keys={["N"]} className="ml-auto" />
              </CommandItem>
              <CommandItem value="go to review queue" onSelect={() => go("/review")}>
                <Inbox /> Go to review queue <KeyboardHint keys={["G", "Q"]} className="ml-auto" />
              </CommandItem>
              <CommandItem
                value="export last report download"
                onSelect={async () => {
                  close();
                  try {
                    const reports = await qc.fetchQuery({ queryKey: qk.reports, queryFn: api.reports });
                    if (!reports.length) return toast.info("No reports yet", { description: "Generate one from the Reports page." });
                    await downloadReport(reports[0].id);
                  } catch (e) {
                    toastError(e, "Export failed");
                  }
                }}
              >
                <Download /> Export last report
              </CommandItem>
              <CommandItem value="open latest run workspace" onSelect={async () => go(`/runs/${await latestRunId()}`)}>
                <FileText /> Open latest run
              </CommandItem>
              <CommandItem value="toggle theme dark light" onSelect={() => set({ theme: theme === "dark" ? "light" : "dark", commandOpen: false })}>
                <Moon /> Toggle dark / light theme
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Navigate">
              {NAV.map((n) => (
                <CommandItem key={n.to} value={`go ${n.label}`} onSelect={() => go(n.to)}>
                  <n.icon /> {n.label}
                </CommandItem>
              ))}
              <CommandItem value="organization settings accounts" onSelect={() => go("/settings?section=organization")}>
                <Building /> Organization settings
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t px-3 py-2 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1"><KeyboardHint keys={["↑", "↓"]} /> navigate</span>
            <span className="flex items-center gap-1"><KeyboardHint keys={["↵"]} /> select</span>
            <span className="flex items-center gap-1"><KeyboardHint keys={["Esc"]} /> close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
