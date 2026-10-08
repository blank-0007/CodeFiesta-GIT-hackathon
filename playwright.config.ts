import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke test against a running ReconAI stack (real backend, no mocks).
 *
 *   # 1. backend:  cd backend && .venv/bin/uvicorn app.main:app --port 8000
 *   # 2. frontend: VITE_API_BASE_URL=http://localhost:8000 VITE_USE_MOCKS=false npm run dev
 *   # 3. tests:    npm run e2e
 *
 * Or against `docker compose up`: E2E_BASE_URL=http://localhost:5173 npm run e2e
 * (frontend served by nginx on 5173, API on 8000).
 *
 * Set E2E_WEB_SERVER=1 to let Playwright start the Vite dev server itself.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const apiURL = process.env.E2E_API_URL ?? "http://localhost:8000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
  metadata: { apiURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_WEB_SERVER
    ? {
        command: "npm run dev -- --port 5173 --strictPort",
        url: baseURL,
        reuseExistingServer: true,
        env: { VITE_API_BASE_URL: apiURL, VITE_USE_MOCKS: "false" },
      }
    : undefined,
});
