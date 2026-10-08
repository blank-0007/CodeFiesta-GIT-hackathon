import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/menus";
import { applyDensity, applyTheme, useUiStore } from "@/lib/store";
import { router } from "@/routes/router";
import { ApiError } from "@/api/client";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        refetchOnWindowFocus: false,
        // Retry transient failures once; never retry 4xx.
        retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 1,
      },
    },
  });
}

function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  const density = useUiStore((s) => s.density);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  useEffect(() => applyDensity(density), [density]);
  return null;
}

export function App() {
  const [client] = useState(makeQueryClient);
  const theme = useUiStore((s) => s.theme);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        <ThemeSync />
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <Toaster
          position="bottom-right"
          closeButton
          richColors
          theme={theme === "system" ? "system" : theme}
          toastOptions={{ className: "font-sans" }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
