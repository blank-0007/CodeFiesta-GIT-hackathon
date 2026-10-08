/**
 * In-memory database behind the MSW handlers. All derived numbers
 * (totals, explained/unexplained, review progress) are recomputed from the
 * underlying records on every read, so decisions are reflected immediately.
 */
import Big from "big.js";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import type {
  AuditEntry,
  Comment,
  DashboardData,
  EvidenceItem,
  FindingDetail,
  FindingView,
  MatchPairView,
  Money,
  ReviewItem,
  Run,
  RunEvent,
  RunStage,
  Txn,
  UnmatchedItem,
  UploadedFile,
  Category,
  RoutingReason,
} from "../types";
import { vendorSimilarity } from "@/lib/fuzzy";
import { priorityScore } from "@/lib/risk";
import {
  DEFAULT_CONFIG,
  STAGE_NAMES,
  USERS,
  generateRun,
  seedAll,
  type FindingRec,
  type RunRecord,
  type SeedData,
} from "./seed";

export interface Db extends SeedData {
  uploads: Map<string, UploadedFile>;
  index: Map<string, RunRecord>;
  seq: number;
}

let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    const s = seedAll();
    db = { ...s, uploads: new Map(), index: new Map(s.runs.map((r) => [r.run.id, r])), seq: 1 };
  }
  return db;
}

export function resetDb() {
  db = null;
}

export const CURRENT_USER = USERS.me;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const sum = (xs: Money[]) => xs.reduce((a, v) => a.plus(v), new Big(0));

export function txnOf(rec: RunRecord, id: string): Txn | undefined {
  return rec.txns.get(id) ?? rec.external.get(id);
}

export function matchedIds(rec: RunRecord): Set<string> {
  const s = new Set<string>();
  for (const p of rec.pairs) {
    p.bankTxnIds.forEach((id) => s.add(id));
    p.ledgerTxnIds.forEach((id) => s.add(id));
  }
  return s;
}

const RESOLVED_EXPLAINED = new Set(["approved", "auto_resolved"]);

/** Signed contribution of a finding's still-unmatched txns to bank − ledger. */
export function contribution(rec: RunRecord, f: FindingRec, matched = matchedIds(rec)): Big {
  let c = new Big(0);
  for (const id of f.coveredTxnIds) {
    if (matched.has(id)) continue;
    const t = rec.txns.get(id);
    if (!t) continue;
    c = t.source === "bank" ? c.plus(t.amount) : c.minus(t.amount);
  }
  return c;
}

export function addAudit(e: Omit<AuditEntry, "id" | "ts"> & { ts?: string }) {
  const d = getDb();
  const entry: AuditEntry = { id: `A-${String(90000 + d.seq++)}`, ts: e.ts ?? new Date().toISOString(), ...e };
  d.audit.unshift(entry);
  return entry;
}

/* ------------------------------------------------------------------ */
/* Live run simulation                                                 */
/* ------------------------------------------------------------------ */
const SIM_STAGES = [
  { stage: "Ingest", ms: 2500 },
  { stage: "Normalize", ms: 2000 },
  { stage: "Match P1", ms: 2500 },
  { stage: "Match P2", ms: 2000 },
  { stage: "Match P3", ms: 2500 },
  { stage: "Detect", ms: 2000 },
  { stage: "AI Investigate", ms: 7000 },
  { stage: "Verify", ms: 1500 },
];

export function createSimulatedRun(input: { period: string; accounts: string[]; name?: string; config?: Run["config"] }): RunRecord {
  const d = getDb();
  const now = Date.now();
  const id = `run_${input.period.replace("-", "_")}_${now.toString(36).slice(-4)}`;
  let at = 0;
  const timeline = SIM_STAGES.map((s) => {
    const x = { ...s, at };
    at += s.ms;
    return x;
  });
  const msgs: Record<string, [RunEvent["level"], string][]> = {
    Ingest: [["info", "Uploading files to secure storage"], ["info", "Parsing HDFC PDF statement (3 pages)"], ["warn", "Page 3: table not detected — OCR fallback succeeded"], ["info", "Parsed 600 bank rows, 610 ledger rows"]],
    Normalize: [["info", "Normalizing dates, signs and vendor names"], ["info", "Account numbers masked before AI analysis"]],
    "Match P1": [["info", "Pass 1 (exact amount + date + reference) running"]],
    "Match P2": [["info", "Pass 2 (date ±3d) and group-sum matching"]],
    "Match P3": [["info", "Pass 3 (fuzzy vendor) running"], ["info", "577 bank transactions matched"]],
    Detect: [["info", "Running 9 detectors on 36 unmatched items"]],
    "AI Investigate": [["ai", "Agent: search_ledger, find_duplicates on 33 items"], ["ai", "Agent: escalating 2 potential-fraud items to gemini-2.5-pro"], ["ai", "Agent: proposed 4 matching rules (need approval)"]],
    Verify: [["info", "Scoring & routing: 14 auto-resolved, 19 to human review"], ["info", "Integrity check passed"]],
  };
  let seq = 0;
  const events = timeline.flatMap((s) =>
    (msgs[s.stage] ?? []).map(([level, message], i, arr) => ({
      seq: ++seq,
      at: s.at + Math.round(((i + 0.5) / arr.length) * s.ms),
      ts: "",
      level,
      stage: s.stage,
      message,
    })),
  );
  events.push({ seq: ++seq, at, ts: "", level: "info", stage: "Done", message: "Run complete — items routed to human review" });

  const rec: RunRecord = {
    run: {
      id,
      name: input.name || `${format(parseISO(`${input.period}-01`), "MMMM yyyy")} — ${input.accounts.length === 2 ? "HDFC + ICICI" : input.accounts.map((a) => (a === "acc_hdfc" ? "HDFC" : "ICICI")).join(" + ")}`,
      period: input.period,
      status: "running",
      accounts: input.accounts,
      config: { ...DEFAULT_CONFIG, ...(input.config ?? {}) },
      stages: STAGE_NAMES.map((name) => ({ name, state: "pending" })),
      createdAt: new Date(now).toISOString(),
      createdBy: CURRENT_USER,
    },
    txns: new Map(),
    bankIds: [],
    ledgerIds: [],
    pairs: [],
    findings: [],
    events: [],
    comments: {},
    proposedRules: [],
    relaxable: [],
    external: new Map(),
    sim: { startedAt: now, timeline, finalized: false, events },
  };
  d.runs.push(rec);
  d.index.set(id, rec);
  addAudit({ actor: { type: "user", name: CURRENT_USER }, action: "run.created", target: id, after: { period: input.period, accounts: input.accounts }, runId: id, ip: "10.20.4.17" });
  return rec;
}

export function simTotalMs(rec: RunRecord) {
  const last = rec.sim!.timeline[rec.sim!.timeline.length - 1];
  return last.at + last.ms;
}

export function advanceSim(rec: RunRecord) {
  const sim = rec.sim;
  if (!sim || sim.finalized) return;
  const elapsed = Date.now() - sim.startedAt;
  const total = simTotalMs(rec);
  const counts: Record<string, number> = { Ingest: 1210, Normalize: 1210, "Match P1": 402, "Match P2": 128, "Match P3": 47, Detect: 36, "AI Investigate": 33, Verify: 33 };
  rec.run.stages = STAGE_NAMES.map((name): RunStage => {
    if (name === "Done") return { name, state: elapsed >= total ? "done" : "pending" };
    const t = sim.timeline.find((s) => s.stage === name)!;
    if (elapsed >= t.at + t.ms) return { name, state: "done", count: counts[name], ms: t.ms };
    if (elapsed >= t.at) {
      const frac = (elapsed - t.at) / t.ms;
      return { name, state: "active", count: Math.round(counts[name] * frac), ms: elapsed - t.at };
    }
    return { name, state: "pending" };
  });
  rec.events = sim.events
    .filter((e) => e.at <= elapsed)
    .map(({ at, ...e }) => ({ ...e, ts: new Date(sim.startedAt + at).toISOString() }));

  if (elapsed >= total) {
    const gen = generateRun({
      runId: rec.run.id,
      period: rec.run.period,
      seed: [...rec.run.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0,
      lowConfPairs: 48,
      templateProb: 1,
      mode: "fresh",
      createdAt: rec.run.createdAt,
      createdBy: rec.run.createdBy,
    });
    Object.assign(rec, {
      txns: gen.txns,
      bankIds: gen.bankIds,
      ledgerIds: gen.ledgerIds,
      pairs: gen.pairs,
      findings: gen.findings,
      proposedRules: gen.proposedRules,
      relaxable: gen.relaxable,
      external: gen.external,
    });
    rec.run.status = "awaiting_review";
    rec.run.durationMs = total;
    rec.run.stages = gen.run.stages;
    sim.finalized = true;
    addAudit({ actor: { type: "system", name: "pipeline" }, action: "run.completed", target: rec.run.id, after: { pairs: gen.pairs.length, findings: gen.findings.length }, runId: rec.run.id });
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */
export function runView(rec: RunRecord): Run {
  advanceSim(rec);
  const matched = matchedIds(rec);
  const bank = rec.bankIds.map((id) => rec.txns.get(id)!);
  const ledger = rec.ledgerIds.map((id) => rec.txns.get(id)!);
  const bankTotal = sum(bank.map((t) => t.amount));
  const ledgerTotal = sum(ledger.map((t) => t.amount));
  let toleranceDiff = new Big(0);
  let autoBank = 0;
  for (const p of rec.pairs) {
    const b = sum(p.bankTxnIds.map((id) => rec.txns.get(id)!.amount));
    const l = sum(p.ledgerTxnIds.map((id) => rec.txns.get(id)!.amount));
    toleranceDiff = toleranceDiff.plus(b.minus(l));
    if (p.status === "auto" && p.score >= 0.9) autoBank += p.bankTxnIds.length;
  }
  let explained = toleranceDiff;
  for (const f of rec.findings) if (RESOLVED_EXPLAINED.has(f.status)) explained = explained.plus(contribution(rec, f, matched));

  const categoryCounts: Record<Category, number> = { duplicate: 0, missing: 0, timing: 0, potential_fraud: 0, unknown: 0 };
  for (const f of rec.findings) categoryCounts[f.humanCategory ?? f.category]++;
  const human = rec.findings.filter((f) => f.routing === "human_review");
  const resolved = human.filter((f) => f.status === "approved" || f.status === "rejected").length;

  return {
    ...rec.run,
    stats: {
      bankCount: bank.length,
      ledgerCount: ledger.length,
      matched: rec.pairs.length,
      unmatchedBank: bank.filter((t) => !matched.has(t.id)).length,
      unmatchedLedger: ledger.filter((t) => !matched.has(t.id)).length,
      anomalies: rec.findings.length,
      autoMatchRate: bank.length ? Math.round((autoBank / bank.length) * 1000) / 1000 : 0,
      bankTotal: bankTotal.toFixed(2),
      ledgerTotal: ledgerTotal.toFixed(2),
      explained: explained.toFixed(2),
    },
    review: { resolved, total: human.length },
    categoryCounts,
    toleranceDiff: toleranceDiff.toFixed(2),
  };
}

export function unexplained(run: Run): Big {
  return new Big(run.stats.bankTotal).minus(run.stats.ledgerTotal).minus(run.stats.explained);
}

export function matchesView(rec: RunRecord): MatchPairView[] {
  return rec.pairs.map((p) => {
    const bank = p.bankTxnIds.map((id) => rec.txns.get(id)!);
    const ledger = p.ledgerTxnIds.map((id) => rec.txns.get(id)!);
    return {
      ...p,
      bank,
      ledger,
      dateDiffDays: differenceInCalendarDays(parseISO(bank[0].date), parseISO(ledger[0].date)),
      vendorSimilarity: Math.round((p.breakdown.vendor / 0.25) * 100) / 100,
      amountDiff: sum(bank.map((t) => t.amount)).minus(sum(ledger.map((t) => t.amount))).toFixed(2),
    };
  });
}

export function findingFor(rec: RunRecord, txnId: string): FindingRec | undefined {
  return rec.findings.find((f) => f.coveredTxnIds.includes(txnId));
}

export function unmatchedView(rec: RunRecord): { bank: UnmatchedItem[]; ledger: UnmatchedItem[] } {
  const matched = matchedIds(rec);
  const item = (t: Txn): UnmatchedItem => {
    const f = findingFor(rec, t.id);
    return {
      txn: t,
      signals: f?.signals.map((s) => ({ ...s, txnId: t.id })) ?? [],
      riskScore: f?.riskScore ?? 0.1,
      findingId: f?.id,
      category: f ? (f.humanCategory ?? f.category) : undefined,
    };
  };
  return {
    bank: rec.bankIds.filter((id) => !matched.has(id)).map((id) => item(rec.txns.get(id)!)),
    ledger: rec.ledgerIds.filter((id) => !matched.has(id)).map((id) => item(rec.txns.get(id)!)),
  };
}

export function findingView(rec: RunRecord, f: FindingRec): FindingView {
  const { coveredTxnIds: _c, ...rest } = f;
  return { ...rest, txn: rec.txns.get(f.txnId)!, runPeriod: rec.run.period };
}

function evidenceFor(rec: RunRecord, f: FindingRec): EvidenceItem[] {
  const t = rec.txns.get(f.txnId)!;
  const out: EvidenceItem[] = [];
  const seen = new Set<string>([t.id]);
  const sim = (o: Txn) => {
    const a = new Big(t.amount).abs();
    const b = new Big(o.amount).abs();
    const amountSim = a.eq(0) ? 0 : Math.max(0, 1 - Number(a.minus(b).abs().div(a).toFixed(4)));
    const dateSim = Math.max(0, 1 - Math.abs(differenceInCalendarDays(parseISO(t.date), parseISO(o.date))) * 0.1);
    return Math.round((0.5 * amountSim + 0.2 * dateSim + 0.3 * vendorSimilarity(t.vendorNorm, o.vendorNorm)) * 100) / 100;
  };
  for (const id of f.evidenceTxnIds) {
    const o = txnOf(rec, id);
    if (!o || seen.has(id)) continue;
    seen.add(id);
    const relation: EvidenceItem["relation"] = rec.external.has(id) ? "period_boundary" : f.category === "duplicate" && o.source === t.source ? "duplicate" : "candidate";
    out.push({ txn: o, relation, similarity: sim(o), note: rec.external.has(id) ? "Next-period entry (outside this run)" : undefined });
  }
  // Nearest unmatched candidates on the other side
  const um = unmatchedView(rec);
  const other = (t.source === "bank" ? um.ledger : um.bank).map((x) => x.txn).filter((o) => !seen.has(o.id));
  other
    .map((o) => ({ o, s: sim(o) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .forEach(({ o, s }) => {
      seen.add(o.id);
      out.push({ txn: o, relation: "candidate", similarity: s });
    });
  // Vendor history (same side, same vendor)
  [...rec.txns.values()]
    .filter((o) => o.source === t.source && o.vendorNorm === t.vendorNorm && !seen.has(o.id))
    .slice(0, 3)
    .forEach((o) => out.push({ txn: o, relation: "vendor_history", similarity: sim(o) }));
  return out;
}

function vendorHistory(f: FindingRec, t: Txn) {
  const d = getDb();
  const hist: { date: string; amount: Money; txnId?: string }[] = [];
  for (const r of d.runs) {
    for (const o of r.txns.values()) {
      if (o.source === t.source && o.vendorNorm === t.vendorNorm) hist.push({ date: o.date, amount: o.amount, txnId: o.id === f.txnId ? o.id : undefined });
    }
  }
  return hist.sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
}

export function findingDetail(rec: RunRecord, f: FindingRec): FindingDetail {
  const d = getDb();
  const run = runView(rec);
  return {
    ...findingView(rec, f),
    evidence: evidenceFor(rec, f),
    vendorHistory: vendorHistory(f, rec.txns.get(f.txnId)!),
    comments: rec.comments[f.id] ?? [],
    history: d.audit.filter((a) => a.target === f.id).sort((a, b) => a.ts.localeCompare(b.ts)),
    impact: { contribution: contribution(rec, f).toFixed(2), unexplainedBefore: unexplained(run).toFixed(2) },
  };
}

export function locateFinding(id: string): { rec: RunRecord; f: FindingRec } | undefined {
  for (const rec of getDb().runs) {
    const f = rec.findings.find((x) => x.id === id);
    if (f) return { rec, f };
  }
  return undefined;
}

export function isOpen(status: string) {
  return status === "open" || status === "in_review" || status === "escalated";
}

export function reviewQueue(): ReviewItem[] {
  const out: ReviewItem[] = [];
  const now = Date.now();
  for (const rec of getDb().runs) {
    for (const f of rec.findings) {
      if (f.routing !== "human_review") continue;
      const fv = findingView(rec, f);
      out.push({
        finding: fv,
        priority: Math.round(priorityScore(f.riskScore, Math.abs(Number(new Big(fv.txn.amount).toFixed(0)))) * 100) / 100,
        routingReason: (f.routingReason as RoutingReason) ?? "Unknown category",
        waitingDays: Math.max(0, Math.floor((now - parseISO(f.createdAt).getTime()) / 86400000)),
      });
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export function dashboard(): DashboardData {
  const d = getDb();
  const now = new Date();
  const views = d.runs.map((r) => ({ rec: r, run: runView(r) }));
  const ok = views.filter((v) => v.run.status !== "failed" && v.run.status !== "running" && v.run.status !== "queued");
  const sorted = [...ok].sort((a, b) => a.run.period.localeCompare(b.run.period) || a.run.createdAt.localeCompare(b.run.createdAt));
  const byPeriod = new Map<string, (typeof sorted)[number]>();
  sorted.forEach((v) => byPeriod.set(v.run.period, v));
  const series = [...byPeriod.values()].slice(-12);
  const open = d.runs.flatMap((r) => r.findings.filter((f) => isOpen(f.status)).map((f) => ({ rec: r, f })));
  const attention = open
    .map(({ rec, f }) => ({ fv: findingView(rec, f), p: priorityScore(f.riskScore, Math.abs(Number(new Big(rec.txns.get(f.txnId)!.amount).toFixed(0)))) }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5)
    .map((x) => x.fv);
  const unrec = ok
    .filter((v) => v.run.status === "awaiting_review")
    .reduce((a, v) => a.plus(unexplained(v.run).abs()), new Big(0));
  const hours = series.map((v) => (v.run.stats.matched * 1.2) / 60);
  return {
    runsThisMonth: d.runs.filter((r) => {
      const c = parseISO(r.run.createdAt);
      return c.getFullYear() === now.getFullYear() && c.getMonth() === now.getMonth();
    }).length,
    autoMatchRate: series.length ? series[series.length - 1].run.stats.autoMatchRate : 0,
    openAnomalies: open.length,
    pendingReviews: open.filter(({ f }) => f.routing === "human_review").length,
    unreconciledAmount: unrec.toFixed(2),
    avgHoursSaved: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : 0,
    trend: series.map((v) => ({ period: v.run.period, autoMatchRate: v.run.stats.autoMatchRate })),
    anomaliesByMonth: series.map((v) => ({ period: v.run.period, ...v.run.categoryCounts })),
    attention,
  };
}

export function addComment(rec: RunRecord, findingId: string, body: string): Comment {
  const mentions = [...body.matchAll(/@([A-Z][a-z]+ [A-Z][a-z]+)/g)].map((m) => m[1]);
  const c: Comment = { id: `c${Date.now().toString(36)}`, author: CURRENT_USER, body, createdAt: new Date().toISOString(), mentions };
  (rec.comments[findingId] ??= []).push(c);
  return c;
}
