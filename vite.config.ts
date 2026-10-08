/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
    dedupe: ["react", "react-dom"],
  },
  // Pre-bundle everything up front so lazily-loaded routes never trigger a
  // mid-session re-optimisation (which can load two React copies).
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "@tanstack/react-query",
      "@tanstack/react-table",
      "@tanstack/react-virtual",
      "zustand",
      "zustand/middleware",
      "recharts",
      "react-hook-form",
      "@hookform/resolvers/zod",
      "zod",
      "lucide-react",
      "date-fns",
      "big.js",
      "cmdk",
      "sonner",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "msw",
      "msw/browser",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-select",
      "@radix-ui/react-switch",
      "@radix-ui/react-slider",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-popover",
      "@radix-ui/react-label",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-visually-hidden",
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          charts: ["recharts"],
          table: ["@tanstack/react-table", "@tanstack/react-virtual"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/polyfills.ts", "./src/test/setup.ts"],
    // Playwright specs live in e2e/ and run with `npm run e2e`, not Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
    css: false,
  },
});
