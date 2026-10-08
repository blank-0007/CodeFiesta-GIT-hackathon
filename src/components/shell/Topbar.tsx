import { Building2, Check, ChevronDown, HelpCircle, Laptop, LogOut, Menu, Moon, Search, Sun, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip,
} from "@/components/ui/menus";
import { KeyboardHint } from "@/components/shared/misc";
import { useUiStore, type Theme } from "@/lib/store";
import { ROLES, type Role } from "@/lib/permissions";
import { isMac } from "@/lib/utils";
import { toast } from "sonner";

const ORGS = [
  { id: "org_acme", name: "Acme Manufacturing Pvt Ltd", accounts: "HDFC ••4521 · ICICI ••8834" },
  { id: "org_acme_exports", name: "Acme Exports LLP", accounts: "Kotak ••1190" },
];

export function Topbar() {
  const set = useUiStore((s) => s.set);
  const theme = useUiStore((s) => s.theme);
  const role = useUiStore((s) => s.role);
  const orgId = useUiStore((s) => s.orgId);
  const org = ORGS.find((o) => o.id === orgId) ?? ORGS[0];

  const nextTheme: Record<Theme, Theme> = { dark: "light", light: "system", system: "dark" };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Laptop;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-6">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => set({ mobileNavOpen: true })}>
        <Menu />
      </Button>

      <button
        type="button"
        onClick={() => set({ commandOpen: true })}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-surface px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:border-muted-foreground/40 md:max-w-md"
        aria-label="Search runs, transactions and vendors"
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">Search runs, transaction IDs, vendors…</span>
        <KeyboardHint keys={[isMac ? "⌘" : "Ctrl", "K"]} className="ml-auto hidden sm:inline-flex" />
      </button>

      <div className="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="hidden max-w-[260px] lg:inline-flex" aria-label={`Organization: ${org.name}`}>
              <Building2 />
              <span className="truncate">{org.name}</span>
              <ChevronDown className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Organization</DropdownMenuLabel>
            {ORGS.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onSelect={() => {
                  if (o.id !== org.id) toast.info("Demo data is only seeded for Acme Manufacturing", { description: `${o.name} would load its own runs and accounts.` });
                }}
              >
                <div className="flex-1">
                  <div className="text-sm">{o.name}</div>
                  <div className="num text-2xs text-muted-foreground">{o.accounts}</div>
                </div>
                {o.id === org.id && <Check className="text-sys" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tip content={`Theme: ${theme} (click to switch)`}>
          <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}. Switch to ${nextTheme[theme]}`} onClick={() => set({ theme: nextTheme[theme] })}>
            <ThemeIcon />
          </Button>
        </Tip>

        <Tip content="Keyboard shortcuts (?)">
          <Button variant="ghost" size="icon" aria-label="Keyboard shortcuts" onClick={() => set({ helpOpen: true })}>
            <HelpCircle />
          </Button>
        </Tip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-surface-2"
              aria-label={`User menu: Priya Sharma, ${ROLES.find((r) => r.id === role)?.label}`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-sys/70 to-ai/70 text-2xs font-semibold text-white">
                PS
              </span>
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-xs font-medium">Priya Sharma</span>
                <span className="block text-2xs text-muted-foreground">{ROLES.find((r) => r.id === role)?.label}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="normal-case tracking-normal">
              <div className="text-sm font-medium text-foreground">Priya Sharma</div>
              <div className="text-xs font-normal">priya.sharma@acme.in</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <UserCog className="h-3 w-3" /> Dev mode · switch role
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={role} onValueChange={(v) => set({ role: v as Role })}>
              {ROLES.map((r) => (
                <DropdownMenuRadioItem key={r.id} value={r.id} onSelect={(e) => e.preventDefault()}>
                  <div>
                    <div>{r.label}</div>
                    <div className="text-2xs text-muted-foreground">{r.description}</div>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => toast.info("Signed-out state isn't part of this demo")}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
