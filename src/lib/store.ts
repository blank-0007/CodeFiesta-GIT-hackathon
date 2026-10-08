import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CurrencyCode, MoneyLocale } from "@/lib/money";
import type { Role } from "@/lib/permissions";

export type Theme = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";

interface UiState {
  theme: Theme;
  density: Density;
  locale: MoneyLocale;
  currency: CurrencyCode;
  dateFormat: string;
  sidebarCollapsed: boolean;
  role: Role;
  drawerWidth: number;
  orgId: string;
  commandOpen: boolean;
  helpOpen: boolean;
  mobileNavOpen: boolean;
  set: (patch: Partial<Omit<UiState, "set">>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      density: "comfortable",
      locale: "en-IN",
      currency: "INR",
      dateFormat: "dd MMM yyyy",
      sidebarCollapsed: false,
      role: "accountant",
      drawerWidth: 720,
      orgId: "org_acme",
      commandOpen: false,
      helpOpen: false,
      mobileNavOpen: false,
      set: (patch) => set(patch),
    }),
    {
      name: "reconai-ui",
      partialize: ({ commandOpen: _c, helpOpen: _h, mobileNavOpen: _m, set: _s, ...rest }) => rest,
    },
  ),
);

export function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
}
