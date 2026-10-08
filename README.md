# ReconAI: Automated Bank Reconciliation & Anomaly Investigation Agent

Accountants spend **8–15 hours a month** matching bank statements to the general ledger by hand, then
digging through the leftovers to find out whether each one is a timing difference, a missing entry or
fraud. ReconAI automates this work in layers, cheapest and most reliable first:

1. **Deterministic rules first.** Exact, date-tolerant, group-sum and fuzzy-vendor matching clear the bulk
   of transactions, and the outcome is fully reproducible.
2. **LLM only on the hard leftovers.** A Gemini agent investigates the unmatched and suspicious items with
   deterministic tools, then returns a structured explanation, a category, a confidence and its evidence.
3. **Humans only on true outliers.** Potential fraud, high-value items, low-confidence and unknown
   cases go to a review queue. Nothing risky is auto-approved.

> **Deterministic code decides what is true. The AI explains why. Humans decide anything risky.**
> In the UI, every AI claim shows its confidence, model/version and supporting evidence, and carries a
> violet ✦ AI badge.

---

## Architecture

```mermaid
flowchart LR
    subgraph IN[Inputs]
      B[Bank statements<br/>PDF / CSV]
      L[Ledger export<br/>Tally / Zoho CSV]
    end

    B & L --> ING["<b>Ingest</b><br/>pdfplumber tables<br/>+ Tesseract OCR fallback<br/>balance sanity check"]
    ING --> NORM["<b>Normalize</b><br/>vendor canonicalization<br/>sign convention, dates<br/>account-number masking"]
    NORM --> MATCH["<b>Match</b><br/>P1 Exact → P2 Date ±3d →<br/>P4 Group sum 1:N / N:1 →<br/>P3 Fuzzy vendor<br/><i>blocking + scipy<br/>linear_sum_assignment</i>"]
    MATCH --> DET["<b>Detect</b><br/>10 detectors<br/>noisy-OR risk score"]
    DET --> AI["<b>AI Investigate</b> ✦<br/>Gemini function calling<br/>5 deterministic tools<br/>structured output<br/><i>offline template fallback</i>"]
    AI --> VER{"<b>Verify / Route</b>"}
    VER -- "potential fraud · high value ·<br/>confidence &lt; 0.7 · unknown" --> HR["<b>Human review</b><br/>approve / reject / escalate<br/>notes required for risky items"]
    VER -- "low risk, high confidence" --> AUTO[Auto-resolved]
    HR & AUTO --> FIN["<b>Finalize</b><br/>unexplained must be ₹0.00"]
    FIN --> REP["<b>Reports</b><br/>CSV / PDF + share link"]

    MATCH -. "unmatched leftovers" .-> RR["<b>P5 Relaxed re-run</b><br/>wider tolerances,<br/>labelled & reviewable"]
    RR -. "new pairs" .-> MATCH

    AI -. "recurring patterns" .-> PR["AI-proposed rules"]
    PR -- "human approves" --> RULES[(Active rules)]
    RULES -. "applied on next run" .-> MATCH
```

**Detectors** (`backend/app/detect/detectors.py`): `duplicate_detector`, `approval_limit` (just below the
approval threshold), `new_vendor`, `weekend_payment`, `high_value`, `period_boundary`, `amount_outlier`,
`no_counterpart`, `amount_mismatch`, `round_amount`. Signals are combined into one risk score with a
noisy-OR: `risk = 1 − ∏(1 − wᵢ·sᵢ)`.

**Agent tools** (`backend/app/agent/tools.py`): `search_ledger`, `find_duplicates`, `get_vendor_history`,
`check_period_boundary`, `get_balance_context`. All five are deterministic queries over the run's data,
so the model can only cite evidence that really exists. The output is validated against a schema
(category, explanation, evidence txn ids, suggested action, confidence). When no Gemini key is
configured, or the call fails or times out, a deterministic template explanation is used instead.

**Two feedback loops**

1. **Relaxed-tolerance re-run (P5).** Only the unmatched items are re-matched, with wider date, amount and
   vendor tolerances. New pairs are labelled "P5 · Relaxed re-run" and can be unmatched.
2. **Rule learning.** The agent proposes matching rules from recurring patterns (e.g. "2% TDS deducted by
   customer X"). A human approves, edits or rejects each proposal, and the matcher applies approved rules
   on later runs. Every rule is versioned.

## Repository layout

```
.
├── src/                         # React 18 + TypeScript + Vite frontend
│   ├── api/                     # types.ts (API contract), client.ts, endpoints.ts, queries.ts
│   │   └── mocks/               # MSW mock API + deterministic seed (VITE_USE_MOCKS=true)
│   ├── components/{ui,shared,shell}
│   ├── features/                # dashboard, runs (wizard, live pipeline), matches, anomalies,
│   │                            # review, rules, reports, audit, settings
│   ├── hooks/  lib/  routes/  styles/
│   └── test/                    # Vitest setup + unit/permission tests
├── e2e/                         # Playwright smoke test (real backend)
├── backend/
│   ├── app/
│   │   ├── api/routers/         # FastAPI routers (one per resource)
│   │   ├── schemas/             # pydantic models (camelCase wire format)
│   │   ├── core/                # config (pydantic-settings), auth, errors, money
│   │   ├── db/                  # SQLAlchemy models, session, init
│   │   ├── ingest/              # PDF/CSV parsers, OCR fallback
│   │   ├── normalize/           # vendor canonicalization, fuzzy matching, masking
│   │   ├── matching/            # multi-pass engine, scoring, rules
│   │   ├── detect/              # the 10 detectors + noisy-OR
│   │   ├── agent/               # Gemini client, tools, offline fallback, rule proposals
│   │   ├── verify/              # routing / human-review policy
│   │   ├── reports/             # CSV + PDF (reportlab)
│   │   ├── services/            # pipeline orchestration, runs, uploads, audit, views
│   │   └── jobs/                # background run executor + SSE progress
│   ├── alembic/                 # migrations
│   ├── tests/                   # pytest: API contract + unit tests
│   ├── scripts/seed_demo.py     # seeds the September 2026 demo data
│   ├── Dockerfile  docker-entrypoint.sh
│   └── pyproject.toml
├── Dockerfile.frontend  deploy/nginx.conf
└── docker-compose.yml
```

## Setup

### Option A: Docker (recommended)

```bash
cp backend/.env.example backend/.env    # optional: add GEMINI_API_KEY
docker compose up --build
```

- App: **http://localhost:5173**
- API: **http://localhost:8000** (health at `/api/health`)
- On first start the backend seeds a complete **September 2026** run (HDFC + ICICI vs the Tally day book)
  into the `reconai-data` volume. Run `docker compose down -v` to reset.

### Option B: Local development

Backend (Python 3.12, [uv](https://docs.astral.sh/uv/)):

```bash
cd backend
uv venv --python 3.12
uv pip install -e ".[dev]"
cp .env.example .env                   # add GEMINI_API_KEY, or leave empty for offline mode
.venv/bin/python -m scripts.seed_demo
.venv/bin/uvicorn app.main:app --reload # http://localhost:8000
```

PDF OCR fallback needs the `tesseract` binary (`brew install tesseract` / `apt install tesseract-ocr`).

Frontend (Node 18+, tested on Node 22/26):

```bash
npm ci
VITE_API_BASE_URL=http://localhost:8000 VITE_USE_MOCKS=false npm run dev   # http://localhost:5173
```

### Option C: Mock-only frontend (no backend)

```bash
VITE_USE_MOCKS=true npm run dev
```

The MSW mock API runs in the browser with 12 months of seeded runs, realistic latency and a 2% random
503 rate (configurable under **Settings → Developer**). Reloading the page resets the mock data.

## Configuration

Backend settings are read only from the environment or `backend/.env` (pydantic-settings).

| Variable          | Default                       | Description |
| ----------------- | ----------------------------- | ----------- |
| `GEMINI_API_KEY`  | *(empty)*                     | Google AI Studio key. Empty = fully offline (deterministic template explanations). |
| `DATABASE_URL`    | `sqlite:///./reconai.db`      | SQLAlchemy URL. Postgres also works: `postgresql://user:pass@host:5432/reconai`. Docker: `sqlite:////data/reconai.db`. |
| `CORS_ORIGINS`    | `http://localhost:5173`       | Comma-separated list of allowed browser origins. |
| `AUTH_MODE`       | `demo`                        | `demo` = role from the `X-Demo-Role` header (dev role switcher). `jwt` = HS256 bearer tokens. |
| `JWT_SECRET`      | *(unset)*                     | HS256 secret, required when `AUTH_MODE=jwt`. |
| `PUBLIC_BASE_URL` | `http://localhost:8000`       | Used to build report share links. |
| `DATA_DIR`        | `backend/data`                | Uploads and generated files (`/data` in Docker). |

Frontend variables are build-time and inlined by Vite (see `.env.example`):

| Variable            | Default                 | Description |
| ------------------- | ----------------------- | ----------- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Backend origin. Requests go to `${VITE_API_BASE_URL}/api/...`. Empty = same-origin `/api`. |
| `VITE_USE_MOCKS`    | `false`                 | `true` starts the in-browser MSW mock API instead of calling the backend. |

## 3-minute demo script

1. **Dashboard.** Stat cards, the 12-month auto-match trend, anomalies by category and the "Needs your attention" list.
2. **Runs → September 2026.** The summary strip shows the integrity check (*Unexplained* stays red until
   resolved), along with the waterfall and the Matched / Unmatched / Anomalies / Rules / Activity tabs.
3. **Live pipeline.** Go to **Runs → New reconciliation → Use sample files**. The HDFC PDF, ICICI CSV and Tally
   day book are uploaded and parsed, and the balance sanity check runs. Click **Continue** through mapping
   and rules, then **Start run** to watch Ingest → Normalize → Match → Detect → AI Investigate → Verify
   stream live over SSE.
4. **Matched / Unmatched.** Pass labels P1–P4 appear on each pair. You can drag a bank row onto a ledger row
   (or select one of each and press **M**) to create a manual match.
5. **Potential fraud.** Open the ₹49,900 payment to a 3-day-old vendor, just under the ₹50,000 approval limit.
   It shows the detector signals with the noisy-OR breakdown, the AI explanation with its evidence and agent
   trace (tool calls), and the model/version.
6. **Re-run with relaxed tolerances** (₹5,000). The amount mismatches match automatically as "P5 · Relaxed re-run".
7. **Review queue.** Select the low-risk items and **Approve selected**. Fraud and high-value items are never
   bulk-approvable. You can also try **Focus mode** (A / R / E, J / K).
8. **Rules.** Approve an AI-proposed rule. Under **Detectors**, change a threshold and use **Test** for a
   dry-run impact preview on the run.
9. **Finalize.** Decide the remaining items (notes are required for fraud and high-value items). *Unexplained*
   reaches **₹0.00**, and **Finalize run** locks the run.
10. **Reports.** Generate the anomaly investigation report as a PDF and copy the share link.
11. **Audit log.** Every system, AI and human action is listed with before/after values.
12. **Role switcher.** Use **User menu → Dev mode · switch role**. As Auditor or Reviewer, actions are hidden or
    disabled in the UI, and the API returns 403.

## Switching to JWT auth

Set the following in `backend/.env`:

```bash
AUTH_MODE=jwt
JWT_SECRET=change-me-to-a-long-random-string
```

The backend then ignores `X-Demo-Role` and verifies an `Authorization: Bearer <token>` header. The token
must be HS256-signed with claims `{ "sub", "name", "role": "admin" | "accountant" | "reviewer" | "auditor", "exp" }`.

Mint a test token with only the standard library:

```bash
JWT_SECRET=change-me-to-a-long-random-string python3 -c '
import base64, hashlib, hmac, json, os, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=").decode()
h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
p = b(json.dumps({"sub": "u_1", "name": "Priya Sharma", "role": "accountant", "exp": int(time.time()) + 8 * 3600}).encode())
s = b(hmac.new(os.environ["JWT_SECRET"].encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{s}")'
```

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/runs
```

The frontend's demo role switcher only sends `X-Demo-Role`. To use JWT from the browser, add the bearer
header in `src/api/client.ts` (the `headers` object in `request()` and the `fetch` in `streamEvents()`),
e.g. `Authorization: \`Bearer ${token}\``, where `token` comes from your login flow or SSO.

## API contract

All types live in [`src/api/types.ts`](src/api/types.ts), which is shared with the backend's pydantic schemas.

| Method & path                         | Request                         | Response                                   |
| ------------------------------------- | ------------------------------- | ------------------------------------------ |
| `GET  /api/health`                    | —                               | 200 when the API and DB are up             |
| `GET  /api/samples` / `GET /api/samples/:name` | —                      | `{ name, kind, accountId? }[]` / file bytes (demo sample files) |
| `POST /api/uploads`                   | multipart: `file`, `kind`, `accountId?` | `UploadedFile` (parse status, preview rows, sanity check, warnings) |
| `POST /api/uploads/:id/ocr`           | —                               | `UploadedFile`                             |
| `GET  /api/runs`                      | —                               | `Run[]`                                    |
| `POST /api/runs`                      | `CreateRunRequest`              | `Run` (status `running`)                   |
| `GET  /api/runs/:id`                  | —                               | `Run` (stats, stages, review progress)     |
| `GET  /api/runs/:id/events`           | —                               | **SSE** (see below)                        |
| `GET  /api/runs/:id/matches`          | —                               | `MatchPairView[]`                          |
| `GET  /api/runs/:id/unmatched`        | —                               | `{ bank: UnmatchedItem[], ledger: UnmatchedItem[] }` |
| `GET  /api/runs/:id/findings`         | —                               | `FindingView[]`                            |
| `GET  /api/runs/:id/activity`         | —                               | `{ events: RunEvent[], audit: AuditEntry[] }` |
| `POST /api/runs/:id/rerun`            | `RerunRequest`                  | `{ matchesGained, pairIds }`               |
| `POST /api/runs/:id/finalize`         | —                               | `Run` (409 if reviews are open)            |
| `GET  /api/findings/:id`              | —                               | `FindingDetail` (evidence, vendor history, comments, history, impact) |
| `POST /api/findings/:id/decision`     | `DecisionRequest`               | `FindingDetail` (422 if notes/reason missing) |
| `POST /api/findings/bulk-decision`    | `{ ids, action: "approve" }`    | `{ updated }` (never applies to fraud)     |
| `POST /api/findings/:id/comments`     | `{ body }`                      | `Comment`                                  |
| `POST /api/matches/manual`            | `{ runId, bankTxnIds, ledgerTxnIds, note }` | `MatchPair`                    |
| `POST /api/matches/:id/unmatch`       | `{ runId, reason }`             | `{ ok: true }`                             |
| `GET  /api/review-queue`              | —                               | `ReviewItem[]` (priority = risk × log amount) |
| `GET  /api/rules`                     | —                               | `RulesResponse` (active, proposed, detectors, versions) |
| `POST /api/rules/:id/decision`        | `{ action: approve \| edit_approve \| reject, params?, reason? }` | `ProposedRule` |
| `PUT  /api/rules/:id`                 | `Partial<Rule>` (e.g. `enabled`) | `Rule`                                    |
| `PUT  /api/detectors/:id`             | `Partial<Detector>`             | `Detector`                                 |
| `POST /api/detectors/:id/test`        | `{ runId, threshold, weight, enabled }` | impact preview                     |
| `GET  /api/reports` / `POST /api/reports` | `ReportRequest`             | `Report[]` / `Report`                      |
| `GET  /api/reports/:id/download`      | —                               | `Report` with `content` (CSV text or base64 PDF) |
| `GET  /api/audit`                     | query: `actor`, `q`, `from`, `to`, `runId` | `AuditEntry[]`                  |
| `GET  /api/settings` / `PUT /api/settings` | `Partial<Settings>`        | `Settings`                                 |
| `GET  /api/dashboard`                 | —                               | `DashboardData`                            |
| `GET  /api/search?q=`                 | —                               | `SearchResult` (runs, txns, vendors)       |

**Wire-format rules**

- JSON keys are **camelCase**.
- Money is a signed **decimal string with 2 decimal places** (`"-49900.00"`, where negative means money leaving
  the account). It is never a float. The frontend uses big.js and the backend uses `Decimal`.
- Dates are ISO `yyyy-MM-dd`. Timestamps are ISO 8601 UTC.
- Errors are JSON `{ "error": string, "detail"?: string }` with a 4xx/5xx status. The client does not retry
  4xx and retries 5xx once.
- **Progress stream:** `GET /api/runs/:id/events` returns `text/event-stream`. The frontend reads it with
  `fetch`, and falls back to polling `GET /api/runs/:id` every 2 s if the stream fails.

  ```
  event: log      data: RunEvent
  event: stages   data: { "status": RunStatus, "stages": RunStage[] }
  event: done     data: {}
  ```

- **Integrity rule:** `bankTotal − ledgerTotal = explained + unexplained`. Finalize is refused (409) while
  any finding is `open`, `in_review` or `escalated`.

## Testing

```bash
# Backend: API contract + unit tests (matching, detectors, money, routing, auth)
cd backend && .venv/bin/pytest

# Frontend: Vitest + React Testing Library (runs against the MSW handlers)
npm test
npm run typecheck

# End-to-end: Playwright against a running stack (backend :8000, frontend :5173)
npm run e2e:install        # one-time: downloads Chromium
npm run e2e                # or E2E_BASE_URL=http://localhost:5173 E2E_API_URL=http://localhost:8000 npm run e2e
E2E_WEB_SERVER=1 npm run e2e   # let Playwright start the Vite dev server itself
```

The e2e smoke test (`e2e/smoke.spec.ts`) runs the whole flow. It uploads the sample files through the
wizard, watches the live pipeline, bulk-approves the low-risk findings, decides the fraud and high-value
ones with notes, finalizes the run (with unexplained at ₹0.00) and generates a report. The test skips
itself if `/api/health` is unreachable.

Frontend unit tests include money formatting (Indian/international grouping, big.js arithmetic), risk
thresholds and noisy-OR, the finding decision flow (required notes, optimistic rollback), manual matching,
the full role × permission matrix, and role-gated rendering.

## Security

- **Never commit `.env` files.** `.gitignore` and `.dockerignore` exclude them. Only the `*.env.example` files are tracked.
- **Rotate any API key that has been pasted** into a chat, ticket, prompt, screenshot or log, even if it
  was only pasted once.
- The Gemini key is read only through pydantic-settings as a `SecretStr`. It is never logged, never
  returned by any endpoint and never sent to the frontend.
- Account numbers are **masked before any LLM call** (on by default, configurable per run).
- The LLM never decides what is true. Matching, totals and the integrity check are deterministic, and AI
  output is advisory, schema-validated and tied to evidence.
- The audit log is **append-only with a hash chain**. Each entry stores the hash of the previous one, so
  tampering can be detected.
- `AUTH_MODE=demo` trusts the `X-Demo-Role` header and is for demos only. Use `AUTH_MODE=jwt` anywhere else.

## Frontend notes

React 18 · TypeScript (strict) · Vite · Tailwind + shadcn-style components on Radix · React Router v6 ·
TanStack Query/Table/Virtual · Zustand · Recharts · react-hook-form + zod · big.js · MSW 2 · Vitest + RTL · Playwright.

- **Design system:** dark-first with a working light theme. Tokens are in `src/styles/globals.css`:
  `sys` (cyan, matched/system), `attn` (orange, unmatched), `crit` (red, fraud/critical), `warn` (amber, timing),
  `ai` (violet, always with ✦ AI) and `ok` (green, approved). Inter is used for UI text and JetBrains Mono for
  amounts and IDs.
- **Money display:** monospace and right-aligned, with Indian (`₹1,24,500.00`) or international grouping.
  Debits are red with a `−` and credits are green. Each value has an accessible label ("debit of ₹…").
- **Accessibility:** the app is keyboard-complete (**⌘K** command palette, **?** for shortcuts). It uses Radix
  dialogs and menus, `role="meter"` for risk and confidence, and charts with text summaries, and colour is
  never the only signal.
- **Roles:** Admin / Accountant / Reviewer / Auditor. The permission matrix is in `src/lib/permissions.ts`,
  mirrored in `backend/app/core/auth.py`.

## Verification status

| Check | Result |
| --- | --- |
| Backend tests (`cd backend && .venv/bin/python -m pytest`) | 332 passed: API contract (shapes vs `types.ts`, 2-dp money, `{error, detail}` errors, LF-only SSE frames, role permissions), reports, fuzzy/scorePair parity with the TypeScript sources, risk, matching, parsers |
| Frontend (`npm run typecheck && npm test && npm run build`) | typecheck clean, 94 Vitest tests passed, build OK |
| Unexplained → ₹0.00 after full resolution | verified by the contract test, and by the seed (Apr–Aug 2026 finalize at ₹0.00) |
| Works with `GEMINI_API_KEY` unset | yes; the contract suite runs with the key blank (deterministic template explanations) |
| Live app against the real API (no MSW) | verified in a browser: dashboard, runs, run detail + waterfall, findings drawer, new-run wizard with sample files → live SSE pipeline → awaiting review, review queue, rules, audit, settings |
| Playwright smoke test (`npm run e2e`) | written, **not executed**: the Chromium download failed in this environment (`npm run e2e:install` first) |

## Known limitations

- **Gemini:** the key used during development was blocked by Google (`403 API_KEY_SERVICE_BLOCKED`). The live agent path (function calling + structured output) is implemented but was only exercised up to the point where the API rejected the key, at which point the pipeline fell back to the deterministic explanations as designed. In offline mode explanation confidence is capped at 0.6, so every finding routes to human review ("Low AI confidence") unless an approved rule classifies it.
- **Not implemented:** batching of several small items into one LLM call (items are investigated individually, concurrency 2, with a case-file cache).
- **Stricter than the mock:** finalize also returns 409 while the unexplained difference is non-zero (for example after a rejected finding), so a finalized run is always ₹0.00.
- **Column mappings:** the wizard keys `columnMapping` by a client-side file id rather than the upload id. The backend accepts either, matching a mapping to an upload by its column headers.

- The Gemini key in this environment was blocked (`API_KEY_SERVICE_BLOCKED`), so the app was verified in offline fallback mode.
- The API ledger connector is not implemented. The ledger can only be loaded from a CSV.
- OCR requires the `tesseract` binary (included in the Docker image).
- XLSX export isn't offered (CSV/PDF only).
- Multi-org data is out of scope, and the org switcher is a placeholder.
