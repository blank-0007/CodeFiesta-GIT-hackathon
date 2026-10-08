import { Suspense } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { Skeleton } from "@/components/ui/form-controls";
import { useHotkeys } from "@/hooks/useHotkeys";
import { useUiStore } from "@/lib/store";
import { Sidebar, MobileNav } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsDialog } from "./ShortcutsDialog";

function PageFallback() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-64" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const set = useUiStore((s) => s.set);

  useHotkeys({
    "mod+k": () => set({ commandOpen: !useUiStore.getState().commandOpen }),
    "?": () => set({ helpOpen: true }),
    "g d": () => navigate("/"),
    "g r": () => navigate("/runs"),
    "g q": () => navigate("/review"),
    "g u": () => navigate("/rules"),
    "g p": () => navigate("/reports"),
    "g a": () => navigate("/audit"),
    "g s": () => navigate("/settings"),
    n: () => navigate("/runs/new"),
  });

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only z-[100] rounded-md bg-sys px-3 py-2 text-sm font-medium text-[rgb(var(--on-accent))] focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar />
      <MobileNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-5 focus:outline-none md:px-6 lg:px-8">
          <div className="mx-auto max-w-[1600px]">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <CommandPalette />
      <ShortcutsDialog />
    </div>
  );
}
