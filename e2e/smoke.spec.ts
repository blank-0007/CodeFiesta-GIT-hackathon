import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * ReconAI end-to-end smoke test (real backend, VITE_USE_MOCKS=false).
 *
 * New Run wizard (sample files) → live pipeline → anomalies → bulk approve low-risk
 * findings in the review queue → decide the remaining (fraud / high-value) findings
 * individually with notes → finalize → generate a report.
 *
 * Requires the backend on E2E_API_URL (default http://localhost:8000) and the frontend on
 * E2E_BASE_URL (default http://localhost:5173). See playwright.config.ts.
 */

const API = (process.env.E2E_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const ROLE_HEADERS = { "X-Demo-Role": "accountant", Accept: "application/json" };
const OPEN = ["open", "in_review", "escalated"];
const NOTE = "E2E smoke: verified supporting documents with the vendor";

interface ApiFinding {
  id: string;
  category: string;
  riskScore: number;
  status: string;
  txn: { amount: string };
}

async function findings(request: APIRequestContext, runId: string): Promise<ApiFinding[]> {
  const res = await request.get(`${API}/api/runs/${runId}/findings`, { headers: ROLE_HEADERS });
  expect(res.ok(), `GET findings → ${res.status()}`).toBeTruthy();
  return (await res.json()) as ApiFinding[];
}

/** Mirrors bulkEligible() in src/features/review/ReviewQueuePage.tsx. */
const bulkEligible = (f: ApiFinding) =>
  OPEN.includes(f.status) && f.category !== "potential_fraud" && f.riskScore < 0.7 && Math.abs(Number(f.txn.amount)) < 500_000;

async function setRole(page: Page, role: "accountant" | "admin") {
  // The dev role switcher persists in the zustand store (localStorage). Accountant is the default;
  // set it explicitly so a previous manual session doesn't leave the browser as auditor.
  await page.addInitScript((r) => {
    try {
      const key = "reconai-ui"; // zustand persist key in src/lib/store.ts
      const v = JSON.parse(localStorage.getItem(key) ?? "null");
      if (v?.state) {
        v.state.role = r;
        localStorage.setItem(key, JSON.stringify(v));
      }
    } catch {
      /* ignore */
    }
  }, role);
}

test.beforeAll(async ({ request }) => {
  const res = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(!res || !res.ok(), `Backend not reachable at ${API}/api/health — start it first (see README)`);
});

test("sample files → live run → review → finalize → report", async ({ page, request }) => {
  const runName = `E2E smoke ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
  await setRole(page, "accountant");

  /* ---------- 1. New Run wizard with the seed sample files ---------- */
  await test.step("upload sample files via the New Run wizard", async () => {
    await page.goto("/runs/new");
    await expect(page.getByRole("heading", { name: /Step 1 of 4/ })).toBeVisible();
    await page.getByLabel(/Run name/).fill(runName);
    await page.getByLabel("Statement period").fill("2026-09");
    await page.getByRole("button", { name: /Use sample files/ }).click();

    for (const name of ["HDFC_Statement_Sep2026.pdf", "ICICI_Statement_Sep2026.csv", "Tally_DayBook_Sep2026.csv"]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText("Uploading & parsing…")).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByRole("alert").filter({ hasText: /Error/ })).toHaveCount(0);
  });

  await test.step("walk the wizard and start the run", async () => {
    // Upload → (Column mapping, only if needed) → Matching rules → Review & start
    for (let i = 0; i < 4; i++) {
      if (await page.getByRole("heading", { name: /Step 4 of 4/ }).isVisible()) break;
      const before = await page.getByRole("heading", { name: /^Step \d of 4/ }).textContent();
      await page.getByRole("button", { name: /^Continue/ }).click();
      await expect(page.getByRole("heading", { name: /^Step \d of 4/ })).not.toHaveText(before ?? "");
    }
    await expect(page.getByRole("heading", { name: /Step 4 of 4/ })).toBeVisible();
    await page.getByRole("button", { name: /Start run/ }).click();
    await page.waitForURL(/\/runs\/(?!new)[^/?]+/, { timeout: 30_000 });
  });

  const runId = new URL(page.url()).pathname.split("/")[2];
  expect(runId).toBeTruthy();

  /* ---------- 2. Live pipeline ---------- */
  await test.step("watch the live pipeline until the run completes", async () => {
    const tabs = page.getByRole("tablist", { name: "Run sections" });
    const live = page.getByRole("region", { name: "Live progress" });
    await expect(live.or(tabs)).toBeVisible();
    if (await live.isVisible()) {
      await expect(page.getByRole("list", { name: "Reconciliation pipeline" })).toBeVisible();
      // Either the log shows completion or the page has already switched to results.
      await expect(page.getByRole("log", { name: "Run log" }).getByText(/Run complete/i).or(tabs)).toBeVisible({ timeout: 240_000 });
    }
    await expect(tabs).toBeVisible({ timeout: 240_000 });
    await expect(page.getByLabel("Done: Done").first()).toBeAttached();
  });

  /* ---------- 3. Anomalies tab ---------- */
  await test.step("open the anomalies tab", async () => {
    await page.getByRole("tab", { name: /Anomalies/ }).click();
    await expect(page.getByRole("table", { name: "Anomaly findings" })).toBeVisible();
  });

  /* ---------- 4. Bulk approve low-risk findings in the review queue ---------- */
  await test.step("bulk approve eligible low-risk findings", async () => {
    const eligible = (await findings(request, runId)).filter(bulkEligible).map((f) => f.id);
    test.info().annotations.push({ type: "bulk-eligible", description: String(eligible.length) });
    if (!eligible.length) return;

    for (const rtab of ["mine", "unassigned"]) {
      await page.goto(`/review?rtab=${rtab}`);
      const table = page.getByRole("table", { name: "Review queue" });
      await expect(table).toBeVisible();
      const search = page.getByLabel("Search review queue");
      let selected = 0;
      for (const id of eligible) {
        await search.fill(id);
        const row = table.getByRole("row").filter({ hasText: id });
        if (!(await row.first().isVisible({ timeout: 3_000 }).catch(() => false))) continue;
        const box = row.first().getByRole("checkbox", { name: "Select row" });
        if ((await box.count()) && (await box.isEnabled())) {
          await box.check();
          selected++;
        }
      }
      await search.fill("");
      if (!selected) continue;

      const bulk = page.getByRole("region", { name: "Bulk actions" });
      await expect(bulk).toContainText(`${selected} low-risk items selected`);
      await bulk.getByRole("button", { name: /Approve selected/ }).click();
      const dialog = page.getByRole("dialog", { name: /Approve \d+ low-risk findings/ });
      await dialog.getByRole("button", { name: /^Approve \d+$/ }).click();
      await expect(bulk).toBeHidden({ timeout: 30_000 });
    }
  });

  /* ---------- 5. Decide the rest (potential fraud / high value) individually ---------- */
  await test.step("decide remaining findings individually with resolution notes", async () => {
    const remaining = (await findings(request, runId)).filter((f) => OPEN.includes(f.status));
    test.info().annotations.push({ type: "individual-decisions", description: String(remaining.length) });
    for (const f of remaining) {
      await page.goto(`/runs/${runId}/findings/${f.id}`);
      const decision = page.getByRole("region", { name: "Decision" });
      await expect(decision).toBeVisible();
      await decision.getByRole("button", { name: /^Approve/ }).click();
      const dialog = page.getByRole("dialog", { name: /Approve AI classification/ });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Resolution notes/).fill(NOTE);
      await dialog.getByRole("button", { name: "Confirm" }).click();
      await expect(decision.getByRole("button", { name: /Reopen/ })).toBeVisible({ timeout: 30_000 });
    }
    const stillOpen = (await findings(request, runId)).filter((f) => OPEN.includes(f.status));
    expect(stillOpen.map((f) => f.id)).toEqual([]);
  });

  /* ---------- 6. Finalize ---------- */
  await test.step("finalize the run", async () => {
    await page.goto(`/runs/${runId}`);
    const finalize = page.getByRole("button", { name: /Finalize run/ });
    await expect(finalize).toBeEnabled({ timeout: 30_000 });
    await finalize.click();
    const dialog = page.getByRole("dialog", { name: /Finalize this reconciliation/ });
    await expect(dialog).toBeVisible();
    await expect.soft(dialog).toContainText("₹0.00");
    await dialog.getByRole("button", { name: /^Finalize$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(async () => {
        const r = await request.get(`${API}/api/runs/${runId}`, { headers: ROLE_HEADERS });
        return ((await r.json()) as { status: string }).status;
      })
      .toBe("completed");
    await page.reload();
    await expect(page.getByText("Completed").first()).toBeVisible();
    await expect.soft(page.getByLabel(/Unexplained difference/).first()).toContainText("₹0.00");
  });

  /* ---------- 7. Reports ---------- */
  await test.step("generate a report for the run", async () => {
    await page.goto("/reports");
    const form = page.getByRole("form", { name: "Report generator" });
    await expect(form).toBeVisible();
    await form.getByRole("radio", { name: /Anomaly investigation report/ }).click();
    await form.getByRole("combobox", { name: "Run" }).click();
    await page.getByRole("option", { name: runName }).click();

    const created = page.waitForResponse((r) => r.url().endsWith("/api/reports") && r.request().method() === "POST");
    await form.getByRole("button", { name: /Generate & download/ }).click();
    const res = await created;
    expect(res.ok(), `POST /api/reports → ${res.status()}`).toBeTruthy();
    const report = (await res.json()) as { id: string; name: string; runId: string };
    expect(report.runId).toBe(runId);

    const history = page.getByRole("table", { name: "Generated reports" });
    await expect(history.getByRole("row").filter({ hasText: report.name }).first()).toBeVisible({ timeout: 30_000 });
  });
});
