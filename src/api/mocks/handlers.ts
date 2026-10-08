import { http, HttpResponse, delay } from "msw";
import Big from "big.js";
import { format } from "date-fns";
import type {
  CreateRunRequest,
  DecisionRequest,
  Detector,
  FindingStatus,
  ReportRequest,
  Report,
  RerunRequest,
  Rule,
  SearchResult,
  Settings,
  UploadedFile,
} from "../types";
import { roleCan, type Permission, type Role } from "@/lib/permissions";
import { scorePair, USERS } from "./seed";
import {
  addAudit,
  addComment,
  advanceSim,
  createSimulatedRun,
  CURRENT_USER,
  dashboard,
  findingDetail,
  findingView,
  getDb,
  isOpen,
  locateFinding,
  matchedIds,
  matchesView,
  reviewQueue,
  runView,
  unexplained,
  unmatchedView,
} from "./db";

/* ------------------------------------------------------------------ */
/* Latency / error injection                                           */
/* ------------------------------------------------------------------ */
const IS_TEST = import.meta.env.MODE === "test";

export interface MockConfig {
  minLatency: number;
  maxLatency: number;
  errorRate: number;
}

export function getMockConfig(): MockConfig {
  if (IS_TEST) return { minLatency: 0, maxLatency: 0, errorRate: 0 };
  try {
    const raw = localStorage.getItem("reconai-mock");
    if (raw) return { minLatency: 200, maxLatency: 800, errorRate: 0.02, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { minLatency: 200, maxLatency: 800, errorRate: 0.02 };
}

async function simulate(): Promise<HttpResponse<{ error: string; detail: string }> | null> {
  const cfg = getMockConfig();
  if (cfg.maxLatency > 0) await delay(cfg.minLatency + Math.random() * (cfg.maxLatency - cfg.minLatency));
  if (Math.random() < cfg.errorRate) {
    return HttpResponse.json({ error: "upstream_unavailable", detail: "Simulated server error (mock error injection) — please retry." }, { status: 503 });
  }
  return null;
}

const notFound = (what: string) => HttpResponse.json({ error: "not_found", detail: `${what} not found` }, { status: 404 });
const bad = (detail: string, status = 422) => HttpResponse.json({ error: "validation_error", detail }, { status });

function forbid(request: Request, perm: Permission) {
  const role = (request.headers.get("x-demo-role") ?? "admin") as Role;
  if (!roleCan(role, perm)) return HttpResponse.json({ error: "forbidden", detail: `Role '${role}' cannot perform '${perm}'` }, { status: 403 });
  return null;
}

const api = (path: string) => `*/api${path}`;

/* ------------------------------------------------------------------ */
/* Report builders                                                     */
/* ------------------------------------------------------------------ */
function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const h = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [h.join(","), ...rows.map((r) => h.map((k) => esc(r[k])).join(","))].join("\n");
}

/** Minimal valid single-font PDF (text only) — enough for a realistic download. */
function buildPdf(pages: string[][]): string {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) && objs.length;
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES_PLACEHOLDER");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds: number[] = [];
  for (const lines of pages) {
    const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7E]/g, "?");
    let y = 800;
    const body = lines
      .map((l, i) => {
        const isH = l.startsWith("# ");
        const txt = esc(isH ? l.slice(2) : l);
        y -= isH ? (i ? 26 : 0) : 15;
        return `BT /${isH ? "F2 15" : "F1 9.5"} Tf 48 ${y} Td (${txt}) Tj ET`;
      })
      .join("\n");
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

const rs = (m: string) => `Rs ${new Big(m).toFixed(2)}`;

function buildReport(req: ReportRequest): { content: string; size: number } {
  const rec = getDb().index.get(req.runId)!;
  const run = runView(rec);
  const um = unmatchedView(rec);
  if (req.type === "reconciled_ledger" && req.format === "csv") {
    const rows: Record<string, unknown>[] = matchesView(rec).map((p) => ({
      match_id: p.id,
      pass: p.passName,
      confidence: p.score,
      status: p.status,
      bank_ids: p.bankTxnIds.join(" "),
      bank_date: p.bank[0].date,
      bank_description: p.bank[0].descriptionRaw,
      bank_amount: new Big(p.bank.reduce((a, t) => a.plus(t.amount), new Big(0))).toFixed(2),
      ledger_ids: p.ledgerTxnIds.join(" "),
      ledger_date: p.ledger[0].date,
      ledger_vendor: p.ledger[0].vendorNorm,
      gl_code: p.ledger[0].glCode ?? "",
      ledger_amount: p.ledger.reduce((a, t) => a.plus(t.amount), new Big(0)).toFixed(2),
      difference: p.amountDiff,
    }));
    for (const side of [um.bank, um.ledger])
      for (const u of side)
        rows.push({ match_id: "", pass: "UNMATCHED", confidence: "", status: u.category ?? "unclassified", bank_ids: u.txn.source === "bank" ? u.txn.id : "", bank_date: u.txn.source === "bank" ? u.txn.date : "", bank_description: u.txn.source === "bank" ? u.txn.descriptionRaw : "", bank_amount: u.txn.source === "bank" ? u.txn.amount : "", ledger_ids: u.txn.source === "ledger" ? u.txn.id : "", ledger_date: u.txn.source === "ledger" ? u.txn.date : "", ledger_vendor: u.txn.source === "ledger" ? u.txn.vendorNorm : "", gl_code: u.txn.glCode ?? "", ledger_amount: u.txn.source === "ledger" ? u.txn.amount : "", difference: "" });
    const c = csv(rows);
    return { content: c, size: c.length };
  }
  if (req.type === "audit_trail") {
    const c = csv(getDb().audit.filter((a) => a.runId === req.runId).map((a) => ({ id: a.id, timestamp: a.ts, actor_type: a.actor.type, actor: a.actor.name, action: a.action, target: a.target, before: JSON.stringify(a.before ?? ""), after: JSON.stringify(a.after ?? ""), model_version: a.modelVersion ?? "", ip: a.ip ?? "" })));
    return { content: c, size: c.length };
  }
  const findings = rec.findings.map((f) => findingView(rec, f));
  if (req.type === "unresolved_items" || req.format === "csv") {
    const list = req.type === "unresolved_items" ? findings.filter((f) => isOpen(f.status)) : findings;
    const c = csv(list.map((f) => ({ finding_id: f.id, txn_id: f.txnId, date: f.txn.date, description: f.txn.descriptionRaw, amount: f.txn.amount, category: f.humanCategory ?? f.category, risk: f.riskScore, ai_confidence: f.confidence, status: f.status, assignee: f.assignee ?? "", ...(req.includeAiExplanations ? { ai_explanation: f.explanation, suggested_action: f.suggestedAction, model: `${f.model.name}@${f.model.version}` } : {}), ...(req.includeEvidence ? { evidence_ids: f.evidenceTxnIds.join(" "), signals: f.signals.map((s) => s.humanText).join(" | ") } : {}) })));
    return { content: c, size: c.length };
  }
  // PDF anomaly report
  const diff = new Big(run.stats.bankTotal).minus(run.stats.ledgerTotal);
  const cover = [
    "# ReconAI - Anomaly Investigation Report",
    `${run.name}`,
    `Generated ${format(new Date(), "dd MMM yyyy HH:mm")} by ${CURRENT_USER}`,
    "",
    "# Totals",
    `Bank total: ${rs(run.stats.bankTotal)}`,
    `Ledger total: ${rs(run.stats.ledgerTotal)}`,
    `Difference: ${rs(diff.toFixed(2))}`,
    `Explained: ${rs(run.stats.explained)}`,
    `Unexplained: ${rs(unexplained(run).toFixed(2))}`,
    `Auto-match rate: ${(run.stats.autoMatchRate * 100).toFixed(1)}%   Matched pairs: ${run.stats.matched}`,
    "",
    "# Anomalies by category",
    ...Object.entries(run.categoryCounts).map(([k, v]) => `${k.replace("_", " ")}: ${v}`),
    "",
    "Deterministic code decides what is true. The AI explains why. Humans decide anything risky.",
  ];
  const detail: string[][] = [];
  let page: string[] = ["# Detailed findings"];
  for (const f of findings.sort((a, b) => b.riskScore - a.riskScore)) {
    const block = [
      `${f.id}  [${(f.humanCategory ?? f.category).toUpperCase()}]  risk ${Math.round(f.riskScore * 100)}  status ${f.status}`,
      `   ${f.txn.date}  ${f.txn.descriptionRaw.slice(0, 70)}  ${rs(f.txn.amount)}`,
      ...(req.includeAiExplanations ? wrap(`   AI (${Math.round(f.confidence * 100)}% conf, ${f.model.name}): ${f.explanation}`, 100) : []),
      ...(req.includeEvidence ? f.signals.map((s) => `   - ${s.humanText}`.slice(0, 110)) : []),
      "",
    ];
    if (page.length + block.length > 48) {
      detail.push(page);
      page = [];
    }
    page.push(...block);
  }
  detail.push(page);
  const pdf = buildPdf([cover, ...detail]);
  return { content: btoa(pdf), size: pdf.length };
}

function wrap(s: string, n: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(" ")) {
    if ((line + " " + w).length > n) {
      out.push(line);
      line = "      " + w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/* ------------------------------------------------------------------ */
/* Upload parsing (mock)                                               */
/* ------------------------------------------------------------------ */
const KNOWN_DATE = /^(txn date|date|transaction date|value date|posting date|voucher date)$/i;
const KNOWN_AMT = /^(amount|debit|credit|withdrawal amt\.?|deposit amt\.?|withdrawal|deposit)$/i;

async function parseUpload(file: File, kind: "bank" | "ledger", accountId?: string): Promise<UploadedFile> {
  const isPdf = /\.pdf$/i.test(file.name);
  const isCsv = /\.(csv|txt)$/i.test(file.name);
  const id = `up_${Math.random().toString(36).slice(2, 9)}`;
  if (!isPdf && !isCsv) {
    return { id, name: file.name, size: file.size, kind, format: "csv", detectedFormat: "Unknown", status: "error", accountId, rowCount: 0, columns: [], autoMapped: false, previewRows: [], warnings: [], error: "Unsupported file type. Upload a PDF statement or a CSV export." };
  }
  if (isPdf) {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      Date: `${String(1 + Math.floor(i * 1.4)).padStart(2, "0")}/09/26`,
      Narration: ["NEFT DR-HDFC0000123-ACME TRADERS-INV2041", "UPI/412345678901/SWIGGY/swiggy@ybl", "NACH-DR-ZOHO CORP-4471029381", "RTGS CR-UTIB0000789-FLIPKART INTERNET-88120934", "POS 4521XXXXXXXX9921 MAKEMYTRIP BANGALORE"][i % 5],
      "Chq./Ref.No.": `HDFCN${520260900000 + i * 7919}`,
      "Withdrawal Amt.": i % 4 === 3 ? "" : (1250 + i * 913.5).toFixed(2),
      "Deposit Amt.": i % 4 === 3 ? (245000 + i * 1000).toFixed(2) : "",
      "Closing Balance": (4825310.45 - i * 9000).toFixed(2),
    }));
    return {
      id, name: file.name, size: file.size, kind, format: "pdf", detectedFormat: "HDFC Bank statement (PDF v3)", status: "parsed", accountId,
      rowCount: 386, columns: Object.keys(rows[0]), autoMapped: true, previewRows: rows,
      sanity: { openingBalance: "4825310.45", sumOfTxns: "-1188210.60", closingBalance: "3584389.85", computedClosing: "3637099.85", ok: false, explanation: "Computed closing balance is ₹52,710.00 higher than the statement's closing balance. 26 rows on page 3 were not detected — retrying with OCR usually fixes this." },
      warnings: [{ page: 3, message: "Page 3: table could not be detected — retry with OCR", canRetryOcr: true }],
    };
  }
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const columns = (lines[0] ?? "").split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const previewRows = lines.slice(1, 21).map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? "").trim().replace(/^"|"$/g, "")]));
  });
  const autoMapped = columns.some((c) => KNOWN_DATE.test(c)) && columns.some((c) => KNOWN_AMT.test(c)) && !columns.some((c) => /^vch|particulars/i.test(c));
  const detectedFormat = kind === "ledger" ? (columns.some((c) => /vch/i.test(c)) ? "Tally Prime day book (CSV)" : "Generic ledger CSV") : columns.includes("Txn Date") ? "ICICI iBizz CSV" : "Generic bank CSV";
  return {
    id, name: file.name, size: file.size, kind, format: "csv", detectedFormat, status: autoMapped ? "parsed" : "needs_mapping", accountId,
    rowCount: Math.max(0, lines.length - 1), columns, autoMapped, previewRows,
    sanity: kind === "bank" ? { openingBalance: "1240880.00", sumOfTxns: "312450.75", closingBalance: "1553330.75", computedClosing: "1553330.75", ok: true } : undefined,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */
export const handlers = [
  /* ---------- Uploads ---------- */
  http.post(api("/uploads"), async ({ request }) => {
    const err = await simulate();
    if (err) return err;
    const fd = await request.formData();
    const file = fd.get("file");
    if (!(file instanceof File)) return bad("Missing file");
    const parsed = await parseUpload(file, (fd.get("kind") as "bank" | "ledger") ?? "bank", (fd.get("accountId") as string) || undefined);
    getDb().uploads.set(parsed.id, parsed);
    return HttpResponse.json(parsed, { status: parsed.status === "error" ? 422 : 201 });
  }),

  http.post(api("/uploads/:id/ocr"), async ({ params }) => {
    await delay(IS_TEST ? 0 : 1200);
    const up = getDb().uploads.get(params.id as string);
    if (!up) return notFound("Upload");
    const fixed: UploadedFile = { ...up, rowCount: up.rowCount + 26, warnings: [], sanity: up.sanity && { ...up.sanity, sumOfTxns: "-1240920.60", computedClosing: up.sanity.closingBalance, ok: true, explanation: undefined } };
    getDb().uploads.set(fixed.id, fixed);
    return HttpResponse.json(fixed);
  }),

  /* ---------- Runs ---------- */
  http.get(api("/runs"), async () => {
    const err = await simulate();
    if (err) return err;
    const runs = getDb().runs.map(runView).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json(runs);
  }),

  http.post(api("/runs"), async ({ request }) => {
    const denied = forbid(request, "run.create");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const body = (await request.json()) as CreateRunRequest;
    if (!body.period || !body.accounts?.length) return bad("period and at least one account are required");
    const rec = createSimulatedRun({ period: body.period, accounts: body.accounts, name: body.name, config: { ...body.config, maskAccountNumbers: body.maskAccountNumbers } });
    return HttpResponse.json(runView(rec), { status: 201 });
  }),

  http.get(api("/runs/:id"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    return HttpResponse.json(runView(rec));
  }),

  http.get(api("/runs/:id/matches"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    advanceSim(rec);
    return HttpResponse.json(matchesView(rec));
  }),

  http.get(api("/runs/:id/unmatched"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    advanceSim(rec);
    return HttpResponse.json(unmatchedView(rec));
  }),

  http.get(api("/runs/:id/findings"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    advanceSim(rec);
    return HttpResponse.json(rec.findings.map((f) => findingView(rec, f)));
  }),

  http.get(api("/runs/:id/activity"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    return HttpResponse.json({ events: rec.events, audit: getDb().audit.filter((a) => a.runId === rec.run.id) });
  }),

  /** SSE progress stream: text/event-stream over fetch (works through the service worker). */
  http.get(api("/runs/:id/events"), ({ params }) => {
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        let sent = 0;
        const push = () => {
          advanceSim(rec);
          const run = runView(rec);
          for (; sent < rec.events.length; sent++) controller.enqueue(enc.encode(`event: log\ndata: ${JSON.stringify(rec.events[sent])}\n\n`));
          controller.enqueue(enc.encode(`event: stages\ndata: ${JSON.stringify({ status: run.status, stages: run.stages })}\n\n`));
          if (run.status !== "running" && run.status !== "queued") {
            controller.enqueue(enc.encode(`event: done\ndata: {}\n\n`));
            clearInterval(timer);
            controller.close();
          }
        };
        push();
        timer = setInterval(push, 700);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }),

  http.post(api("/runs/:id/rerun"), async ({ params, request }) => {
    const denied = forbid(request, "run.rerun");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    const body = (await request.json()) as RerunRequest;
    const matched = matchedIds(rec);
    const gained: string[] = [];
    for (const r of rec.relaxable) {
      if ([...r.bankIds, ...r.ledgerIds].some((id) => matched.has(id))) continue;
      if (new Big(body.amountTolerance).lt(r.amountTolerance) || body.dateToleranceDays < r.dateToleranceDays || body.vendorThreshold > r.vendorThreshold) continue;
      const bank = r.bankIds.map((id) => rec.txns.get(id)!);
      const ledger = r.ledgerIds.map((id) => rec.txns.get(id)!);
      const { breakdown, score } = scorePair(bank, ledger, true);
      const id = `M-RR-${rec.pairs.length + 1}`;
      rec.pairs.push({ id, bankTxnIds: r.bankIds, ledgerTxnIds: r.ledgerIds, score, breakdown, passName: "P5 · Relaxed re-run", status: "auto", note: `Matched with amount tolerance ₹${body.amountTolerance}` });
      gained.push(id);
      for (const f of rec.findings) if (f.coveredTxnIds.some((t) => r.bankIds.includes(t) || r.ledgerIds.includes(t)) && isOpen(f.status)) f.status = "auto_resolved";
    }
    rec.events.push({ seq: rec.events.length + 1, ts: new Date().toISOString(), level: "info", stage: "Match P5", message: `Relaxed re-run (±${body.dateToleranceDays}d, ₹${body.amountTolerance}, vendor ≥ ${Math.round(body.vendorThreshold * 100)}%) on unmatched items: ${gained.length} new matches` });
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "run.rerun", target: rec.run.id, after: { ...body, matchesGained: gained.length }, runId: rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json({ matchesGained: gained.length, pairIds: gained });
  }),

  http.post(api("/runs/:id/finalize"), async ({ params, request }) => {
    const denied = forbid(request, "run.finalize");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const rec = getDb().index.get(params.id as string);
    if (!rec) return notFound("Run");
    const open = rec.findings.filter((f) => isOpen(f.status)).length;
    if (open) return bad(`${open} findings are still unresolved`, 409);
    const before = rec.run.status;
    rec.run.status = "completed";
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "run.finalized", target: rec.run.id, before: { status: before }, after: { status: "completed" }, runId: rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json(runView(rec));
  }),

  http.post(api("/runs/bulk-archive"), async ({ request }) => {
    const err = await simulate();
    if (err) return err;
    const { ids } = (await request.json()) as { ids: string[] };
    ids.forEach((id) => {
      const r = getDb().index.get(id);
      if (r) r.run.archived = true;
    });
    return HttpResponse.json({ archived: ids.length });
  }),

  /* ---------- Findings ---------- */
  http.get(api("/findings/:id"), async ({ params }) => {
    const err = await simulate();
    if (err) return err;
    const loc = locateFinding(params.id as string);
    if (!loc) return notFound("Finding");
    return HttpResponse.json(findingDetail(loc.rec, loc.f));
  }),

  http.post(api("/findings/:id/decision"), async ({ params, request }) => {
    const denied = forbid(request, "finding.decide");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const loc = locateFinding(params.id as string);
    if (!loc) return notFound("Finding");
    const body = (await request.json()) as DecisionRequest;
    const { rec, f } = loc;
    const txn = rec.txns.get(f.txnId)!;
    const highValue = new Big(txn.amount).abs().gte(getDb().settings.organization.highValueThreshold);
    const needsNotes = (f.category === "potential_fraud" || highValue) && ["approve", "change_category", "false_positive"].includes(body.action);
    if ((body.action === "reject" || needsNotes) && !(body.reason && body.reason.trim().length >= 5)) {
      return bad(body.action === "reject" ? "A reason is required to reject." : "Resolution notes are required for potential fraud and high-value items.");
    }
    if (body.action === "change_category" && !body.category) return bad("category is required");
    const before = { status: f.status, category: f.humanCategory ?? f.category };
    const prev = (f as unknown as { prevStatus?: FindingStatus }).prevStatus;
    (f as unknown as { prevStatus?: FindingStatus }).prevStatus = f.status;
    switch (body.action) {
      case "approve":
        f.status = "approved";
        break;
      case "change_category":
        f.humanCategory = body.category;
        f.status = "approved";
        break;
      case "reject":
        f.status = "rejected";
        break;
      case "escalate":
        f.status = "escalated";
        f.assignee = USERS.controller;
        break;
      case "false_positive":
        f.status = "approved";
        f.falsePositive = true;
        break;
      case "reopen":
        f.status = prev && prev !== f.status ? prev : "open";
        f.falsePositive = false;
        f.humanCategory = undefined;
        break;
    }
    f.updatedAt = new Date().toISOString();
    if (body.comment?.trim()) addComment(rec, f.id, body.comment.trim());
    if (body.reason?.trim() && body.action !== "reopen") addComment(rec, f.id, `[${body.action.replace("_", " ")}] ${body.reason.trim()}`);
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: body.action === "reopen" ? "finding.undo" : `finding.${body.action}`, target: f.id, before, after: { status: f.status, category: f.humanCategory ?? f.category, reason: body.reason }, runId: rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json(findingDetail(rec, f));
  }),

  http.post(api("/findings/bulk-decision"), async ({ request }) => {
    const denied = forbid(request, "finding.decide");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const { ids, action } = (await request.json()) as { ids: string[]; action: "approve" };
    let done = 0;
    for (const id of ids) {
      const loc = locateFinding(id);
      if (!loc || !isOpen(loc.f.status)) continue;
      if (loc.f.category === "potential_fraud") continue; // never bulk-approve fraud
      loc.f.status = action === "approve" ? "approved" : loc.f.status;
      addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "finding.approve", target: id, before: { status: "open" }, after: { status: "approved", bulk: true }, runId: loc.rec.run.id, ip: "10.20.4.17" });
      done++;
    }
    return HttpResponse.json({ updated: done });
  }),

  http.post(api("/findings/:id/comments"), async ({ params, request }) => {
    const err = await simulate();
    if (err) return err;
    const loc = locateFinding(params.id as string);
    if (!loc) return notFound("Finding");
    const { body } = (await request.json()) as { body: string };
    if (!body?.trim()) return bad("Comment cannot be empty");
    const c = addComment(loc.rec, loc.f.id, body.trim());
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "finding.commented", target: loc.f.id, after: { body: c.body }, runId: loc.rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json(c, { status: 201 });
  }),

  /* ---------- Matches ---------- */
  http.post(api("/matches/manual"), async ({ request }) => {
    const denied = forbid(request, "match.manual");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const body = (await request.json()) as { runId: string; bankTxnIds: string[]; ledgerTxnIds: string[]; note: string };
    const rec = getDb().index.get(body.runId);
    if (!rec) return notFound("Run");
    if (!body.note || body.note.trim().length < 5) return bad("A note of at least 5 characters is required for manual matches.");
    if (!body.bankTxnIds?.length || !body.ledgerTxnIds?.length) return bad("Select at least one bank and one ledger transaction.");
    const matched = matchedIds(rec);
    const already = [...body.bankTxnIds, ...body.ledgerTxnIds].filter((id) => matched.has(id));
    if (already.length) return bad(`Already matched: ${already.join(", ")}`, 409);
    const bank = body.bankTxnIds.map((id) => rec.txns.get(id));
    const ledger = body.ledgerTxnIds.map((id) => rec.txns.get(id));
    if (bank.some((t) => !t) || ledger.some((t) => !t)) return notFound("Transaction");
    const { breakdown, score } = scorePair(bank as never, ledger as never, null);
    const pair = { id: `M-MAN-${Date.now().toString(36).slice(-5).toUpperCase()}`, bankTxnIds: body.bankTxnIds, ledgerTxnIds: body.ledgerTxnIds, score, breakdown, passName: "Manual", status: "manual" as const, note: body.note.trim(), createdBy: CURRENT_USER };
    rec.pairs.push(pair);
    for (const f of rec.findings) {
      if (f.coveredTxnIds.some((id) => body.bankTxnIds.includes(id) || body.ledgerTxnIds.includes(id)) && isOpen(f.status)) {
        f.status = "approved";
        addComment(rec, f.id, `Resolved by manual match ${pair.id}: ${body.note.trim()}`);
      }
    }
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "match.manual", target: pair.id, after: { bank: body.bankTxnIds, ledger: body.ledgerTxnIds, note: body.note }, runId: rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json(pair, { status: 201 });
  }),

  http.post(api("/matches/:id/unmatch"), async ({ params, request }) => {
    const denied = forbid(request, "match.unmatch");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const { reason, runId } = (await request.json()) as { reason: string; runId: string };
    if (!reason || reason.trim().length < 5) return bad("A reason is required to unmatch.");
    const rec = getDb().index.get(runId);
    if (!rec) return notFound("Run");
    const idx = rec.pairs.findIndex((p) => p.id === params.id);
    if (idx < 0) return notFound("Match");
    const [p] = rec.pairs.splice(idx, 1);
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "match.unmatched", target: p.id, before: { bank: p.bankTxnIds, ledger: p.ledgerTxnIds, score: p.score }, after: { reason }, runId: rec.run.id, ip: "10.20.4.17" });
    return HttpResponse.json({ ok: true });
  }),

  /* ---------- Review queue ---------- */
  http.get(api("/review-queue"), async () => {
    const err = await simulate();
    if (err) return err;
    return HttpResponse.json(reviewQueue());
  }),

  /* ---------- Rules & detectors ---------- */
  http.get(api("/rules"), async () => {
    const err = await simulate();
    if (err) return err;
    const d = getDb();
    return HttpResponse.json({ active: d.rules, proposed: d.runs.flatMap((r) => r.proposedRules), detectors: d.detectors, versions: d.versions });
  }),

  http.post(api("/rules/:id/decision"), async ({ params, request }) => {
    const denied = forbid(request, "rule.decide");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const d = getDb();
    const pr = d.runs.flatMap((r) => r.proposedRules).find((p) => p.id === params.id);
    if (!pr) return notFound("Proposed rule");
    const body = (await request.json()) as { action: "approve" | "edit_approve" | "reject"; params?: Record<string, unknown>; reason?: string };
    if (body.action === "reject") {
      if (!body.reason || body.reason.trim().length < 5) return bad("A reason is required to reject a rule.");
      pr.status = "rejected";
    } else {
      pr.status = "approved";
      const ruleParams = body.action === "edit_approve" && body.params ? body.params : pr.params;
      const rule: Rule = { id: `R-${String(d.rules.length + 1).padStart(3, "0")}`, name: pr.title, description: pr.description, scope: pr.scope.startsWith("vendor") ? "vendor" : "global", scopeValue: pr.scope.split(": ")[1], params: ruleParams, enabled: true, createdBy: { type: "ai", name: pr.model.name }, hitCount: 0, version: 1 };
      d.rules.push(rule);
      d.versions.unshift({ id: `v${Date.now()}`, ruleId: rule.id, version: 1, changedBy: CURRENT_USER, changedAt: new Date().toISOString(), before: body.action === "edit_approve" ? pr.params : null, after: ruleParams, note: body.action === "edit_approve" ? "AI proposal edited and approved" : "AI proposal approved" });
    }
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: `rule.${body.action === "reject" ? "rejected" : "approved"}`, target: pr.id, before: { status: "proposed", params: pr.params }, after: { status: pr.status, params: body.params ?? pr.params, reason: body.reason }, runId: pr.runId, ip: "10.20.4.17" });
    return HttpResponse.json(pr);
  }),

  http.put(api("/rules/:id"), async ({ params, request }) => {
    const denied = forbid(request, "rule.toggle");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const d = getDb();
    const rule = d.rules.find((r) => r.id === params.id);
    if (!rule) return notFound("Rule");
    const body = (await request.json()) as Partial<Rule>;
    const before = { enabled: rule.enabled, params: rule.params };
    Object.assign(rule, { enabled: body.enabled ?? rule.enabled, params: body.params ?? rule.params, version: rule.version + 1 });
    d.versions.unshift({ id: `v${Date.now()}`, ruleId: rule.id, version: rule.version, changedBy: CURRENT_USER, changedAt: new Date().toISOString(), before, after: { enabled: rule.enabled, params: rule.params }, note: body.enabled === false ? "Disabled" : body.enabled ? "Enabled" : "Parameters updated" });
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "rule.updated", target: rule.id, before, after: { enabled: rule.enabled, params: rule.params }, ip: "10.20.4.17" });
    return HttpResponse.json(rule);
  }),

  http.put(api("/detectors/:id"), async ({ params, request }) => {
    const denied = forbid(request, "detector.configure");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const det = getDb().detectors.find((x) => x.id === params.id);
    if (!det) return notFound("Detector");
    const body = (await request.json()) as Partial<Detector>;
    const before = { enabled: det.enabled, threshold: det.threshold, weight: det.weight };
    Object.assign(det, body);
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "detector.updated", target: det.id, before, after: { enabled: det.enabled, threshold: det.threshold, weight: det.weight }, ip: "10.20.4.17" });
    return HttpResponse.json(det);
  }),

  http.post(api("/detectors/:id/test"), async ({ params, request }) => {
    await delay(IS_TEST ? 0 : 900);
    const det = getDb().detectors.find((x) => x.id === params.id);
    if (!det) return notFound("Detector");
    const { runId, threshold, weight, enabled } = (await request.json()) as { runId: string; threshold: number; weight: number; enabled: boolean };
    const rec = getDb().index.get(runId);
    if (!rec) return notFound("Run");
    const withSignal = rec.findings.filter((f) => f.signals.some((s) => s.detector === det.id));
    const ratio = det.threshold ? threshold / det.threshold : 1;
    const flaggedNow = withSignal.length;
    const after = !enabled ? 0 : Math.max(0, Math.round(flaggedNow * (ratio > 1 ? 1 / Math.sqrt(ratio) : 1 + (1 - ratio) * 1.5) * (0.6 + weight * 0.4)));
    return HttpResponse.json({
      flaggedNow,
      flaggedAfter: after,
      newlyFlagged: Math.max(0, after - flaggedNow),
      cleared: Math.max(0, flaggedNow - after),
      routedToReviewDelta: Math.round((after - flaggedNow) * 0.6),
      sample: withSignal.slice(0, 3).map((f) => ({ id: f.id, text: f.signals.find((s) => s.detector === det.id)!.humanText })),
    });
  }),

  /* ---------- Reports ---------- */
  http.get(api("/reports"), async () => {
    const err = await simulate();
    if (err) return err;
    return HttpResponse.json(getDb().reports.map(({ content: _c, ...r }) => r));
  }),

  http.post(api("/reports"), async ({ request }) => {
    const denied = forbid(request, "report.generate");
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const body = (await request.json()) as ReportRequest;
    const rec = getDb().index.get(body.runId);
    if (!rec) return notFound("Run");
    if (rec.run.status === "running" || rec.run.status === "failed") return bad("Reports can only be generated for runs that have finished.", 409);
    const { content, size } = buildReport(body);
    const typeName = { reconciled_ledger: "reconciled-ledger", anomaly_report: "anomaly-report", audit_trail: "audit-trail", unresolved_items: "unresolved-items" }[body.type];
    const report: Report = { id: `RP-${200 + getDb().reports.length}`, runId: body.runId, runPeriod: rec.run.period, type: body.type, format: body.format, name: `${typeName}-${rec.run.period}.${body.format}`, size, createdAt: new Date().toISOString(), createdBy: CURRENT_USER, content, shareUrl: `https://reconai.app/s/${Math.random().toString(36).slice(2, 10)}` };
    getDb().reports.unshift(report);
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "report.generated", target: report.id, after: { type: body.type, format: body.format, includeAi: body.includeAiExplanations }, runId: body.runId, ip: "10.20.4.17" });
    return HttpResponse.json(report, { status: 201 });
  }),

  http.get(api("/reports/:id/download"), async ({ params }) => {
    const r = getDb().reports.find((x) => x.id === params.id);
    if (!r) return notFound("Report");
    if (!r.content) {
      const built = buildReport({ runId: r.runId, type: r.type, format: r.format, includeAiExplanations: true, includeEvidence: true });
      r.content = built.content;
    }
    return HttpResponse.json(r);
  }),

  /* ---------- Audit ---------- */
  http.get(api("/audit"), async ({ request }) => {
    const err = await simulate();
    if (err) return err;
    const u = new URL(request.url);
    const actor = u.searchParams.get("actor");
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const from = u.searchParams.get("from");
    const to = u.searchParams.get("to");
    const runId = u.searchParams.get("runId");
    const rows = getDb().audit.filter(
      (a) =>
        (!actor || actor.split(",").includes(a.actor.type)) &&
        (!runId || a.runId === runId) &&
        (!from || a.ts >= from) &&
        (!to || a.ts <= `${to}T23:59:59.999Z`) &&
        (!q || `${a.action} ${a.target} ${a.actor.name} ${a.runId ?? ""} ${JSON.stringify(a.after ?? "")}`.toLowerCase().includes(q)),
    );
    return HttpResponse.json(rows);
  }),

  /* ---------- Settings ---------- */
  http.get(api("/settings"), async () => {
    const err = await simulate();
    if (err) return err;
    return HttpResponse.json(getDb().settings);
  }),

  http.put(api("/settings"), async ({ request }) => {
    const body = (await request.json()) as Partial<Settings>;
    const denied = body.organization ? forbid(request, "settings.org") : body.ai ? forbid(request, "settings.ai") : null;
    if (denied) return denied;
    const err = await simulate();
    if (err) return err;
    const d = getDb();
    const before = JSON.parse(JSON.stringify(d.settings));
    d.settings = {
      organization: { ...d.settings.organization, ...body.organization },
      ai: { ...d.settings.ai, ...body.ai },
      notifications: { ...d.settings.notifications, ...body.notifications },
    };
    const section = Object.keys(body)[0] as keyof Settings;
    addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "settings.updated", target: section, before: before[section], after: d.settings[section], ip: "10.20.4.17" });
    return HttpResponse.json(d.settings);
  }),

  /* ---------- Dashboard & search ---------- */
  http.get(api("/dashboard"), async () => {
    const err = await simulate();
    if (err) return err;
    return HttpResponse.json(dashboard());
  }),

  http.get(api("/search"), async ({ request }) => {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
    await delay(IS_TEST ? 0 : 120);
    const out: SearchResult = { runs: [], txns: [], vendors: [] };
    if (q.length < 2) return HttpResponse.json(out);
    const d = getDb();
    const vendors = new Map<string, number>();
    for (const rec of d.runs) {
      if (`${rec.run.id} ${rec.run.name} ${rec.run.period}`.toLowerCase().includes(q)) out.runs.push({ id: rec.run.id, name: rec.run.name, period: rec.run.period });
      for (const t of rec.txns.values()) {
        if (t.vendorNorm.toLowerCase().includes(q)) vendors.set(t.vendorNorm, (vendors.get(t.vendorNorm) ?? 0) + 1);
        if (out.txns.length < 8 && (t.id.toLowerCase().includes(q) || t.descriptionRaw.toLowerCase().includes(q))) {
          const f = rec.findings.find((x) => x.coveredTxnIds.includes(t.id));
          out.txns.push({ id: t.id, runId: rec.run.id, description: t.descriptionRaw, amount: t.amount, findingId: f?.id });
        }
      }
      for (const f of rec.findings) if (f.id.toLowerCase() === q && !out.txns.some((t) => t.findingId === f.id)) out.txns.unshift({ id: f.txnId, runId: rec.run.id, description: rec.txns.get(f.txnId)!.descriptionRaw, amount: rec.txns.get(f.txnId)!.amount, findingId: f.id });
    }
    out.vendors = [...vendors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
    out.runs = out.runs.slice(0, 5);
    return HttpResponse.json(out);
  }),
];

