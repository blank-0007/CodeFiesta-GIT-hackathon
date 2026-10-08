import { NavLink } from "react-router-dom";
import {
  Building2,
  FileBarChart2,
  Inbox,
  Laptop,
  LayoutDashboard,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useReviewQueue } from "@/api/queries";
import { Sheet, SheetContent } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/menus";
import { useUiStore, type Theme } from "@/lib/store";
import { ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { ORGS } from "./Topbar";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { DialogTitle } from "@radix-ui/react-dialog";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: "review";
  end?: boolean;
}

export const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/runs", label: "Runs", icon: Play },
  { to: "/review", label: "Review Queue", icon: Inbox, badge: "review" },
  { to: "/rules", label: "Rules", icon: SlidersHorizontal },
  { to: "/reports", label: "Reports", icon: FileBarChart2 },
  { to: "/audit", label: "Audit Log", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

function usePendingCount() {
  const { data } = useReviewQueue();
  return data?.filter((i) => ["open", "in_review", "escalated"].includes(i.finding.status)).length;
}

export function Logo({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sys/30 bg-sys/10">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
          <path d="M4 8h8M4 12h14M4 16h8" stroke="rgb(var(--sys))" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="18" cy="8" r="2.4" fill="rgb(var(--ai))" />
        </svg>
      </div>
      {!collapsed && (
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">ReconAI</div>
          <div className="text-2xs text-muted-foreground">Reconciliation agent</div>
        </div>
      )}
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pending = usePendingCount();
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const Icon = item.icon;
        const count = item.badge === "review" ? pending : undefined;
        const link = (
          <NavLink
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            aria-label={collapsed ? `${item.label}${count ? `, ${count} pending` : ""}` : undefined}
            className={({ isActive }) =>
              cn(
                "group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground",
                isActive && "bg-surface-2 text-foreground before:absolute before:-left-3 before:top-2 before:h-5 before:w-0.5 before:rounded-full before:bg-sys",
                collapsed && "justify-center px-0",
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
            {count ? (
              <span
                className={cn(
                  "num rounded-full bg-attn/15 px-1.5 text-2xs font-semibold text-attn",
                  collapsed && "absolute -right-0.5 -top-0.5 px-1 text-[9px]",
                )}
                aria-label={`${count} pending reviews`}
              >
                {count}
              </span>
            ) : null}
          </NavLink>
        );
        return (
          <li key={item.to}>
            {collapsed ? (
              <Tip content={item.label} side="right">
                {link}
              </Tip>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const set = useUiStore((s) => s.set);
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-surface transition-[width] duration-200 md:flex",
        collapsed ? "w-[64px]" : "w-[232px]",
      )}
    >
      <div className={cn("flex h-14 items-center border-b px-4", collapsed && "justify-center px-0")}>
        <Logo collapsed={collapsed} />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3">
        <NavList collapsed={collapsed} />
      </nav>
      <div className="border-t p-3">
        <button
          type="button"
          onClick={() => set({ sidebarCollapsed: !collapsed })}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && "Collapse"}
        </button>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const open = useUiStore((s) => s.mobileNavOpen);
  const set = useUiStore((s) => s.set);
  const role = useUiStore((s) => s.role);
  const orgId = useUiStore((s) => s.orgId);
  const theme = useUiStore((s) => s.theme);
  const org = ORGS.find((o) => o.id === orgId) ?? ORGS[0];

  const nextTheme: Record<Theme, Theme> = { dark: "light", light: "system", system: "dark" };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Laptop;

  return (
    <Sheet open={open} onOpenChange={(o) => set({ mobileNavOpen: o })}>
      <SheetContent side="left" width={280} className="flex h-full flex-col bg-surface p-0" aria-describedby={undefined}>
        <VisuallyHidden.Root>
          <DialogTitle>Navigation</DialogTitle>
        </VisuallyHidden.Root>
        <div className="flex h-14 items-center justify-between border-b px-4">
          <Logo />
        </div>

        {/* Organization card for mobile */}
        <div className="border-b bg-surface-2/40 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 shrink-0 text-sys" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold">{org.name}</div>
              <div className="num truncate text-[11px] text-muted-foreground">{org.accounts}</div>
            </div>
          </div>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3 touch-scroll">
          <NavList onNavigate={() => set({ mobileNavOpen: false })} />
        </nav>

        {/* User profile & theme footer */}
        <div className="border-t bg-surface-2/30 p-3 pb-safe">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sys/70 to-ai/70 text-2xs font-semibold text-white">
                PS
              </span>
              <div className="min-w-0 leading-tight">
                <span className="block truncate text-xs font-medium">Priya Sharma</span>
                <span className="block truncate text-2xs text-muted-foreground">{ROLES.find((r) => r.id === role)?.label}</span>
              </div>
            </div>
            <Tip content={`Theme: ${theme}`}>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border/80 text-muted-foreground hover:bg-surface hover:text-foreground"
                aria-label={`Current theme: ${theme}. Switch to ${nextTheme[theme]}`}
                onClick={() => set({ theme: nextTheme[theme] })}
              >
                <ThemeIcon className="h-4 w-4" />
              </button>
            </Tip>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
