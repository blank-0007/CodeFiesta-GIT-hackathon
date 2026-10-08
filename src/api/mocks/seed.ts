/**
 * Deterministic seed generator for the mock API.
 *
 * Each monthly run has ~600 bank and ~610 ledger transactions across two accounts.
 * The September 2026 run includes every scenario the UI needs to demonstrate:
 * duplicates, missing-in-ledger / missing-in-bank, month-end timing items,
 * two potential-fraud cases, amount mismatches, 1:N and N:1 group matches.
 */
import Big from "big.js";
import { addDays, format, getDaysInMonth, isWeekend, parseISO, subMonths, addMinutes } from "date-fns";
import type {
  AgentStep,
  AuditEntry,
  Category,
  Comment,
  Detector,
  FindingStatus,
  MatchPair,
  ProposedRule,
  Report,
  Rule,
  RuleVersion,
  RunEvent,
  RunStage,
  Settings,
  Signal,
  Txn,
  Finding,
  Run,
} from "../types";
import { vendorSimilarity } from "@/lib/fuzzy";
import { noisyOr } from "@/lib/risk";
import { DEFAULT_CONFIG } from "@/lib/matching";

/* ------------------------------------------------------------------ */
/* RNG                                                                 */
/* ------------------------------------------------------------------ */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  digits(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += this.int(0, 9);
    return s;
  }
  weighted<T extends { weight: number }>(arr: readonly T[]): T {
    const total = arr.reduce((a, b) => a + b.weight, 0);
    let r = this.next() * total;
    for (const x of arr) {
      r -= x.weight;
      if (r <= 0) return x;
    }
    return arr[arr.length - 1];
  }
}

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */
export const ACCOUNTS = [
  { id: "acc_hdfc", name: "HDFC Bank Current A/c", bank: "HDFC Bank", last4: "4521", parserTemplate: "HDFC PDF v3", currency: "INR", opening: "4825310.45", file: "HDFC_Statement_Sep2026.pdf" },
  { id: "acc_icici", name: "ICICI Bank Current A/c", bank: "ICICI Bank", last4: "8834", parserTemplate: "ICICI CSV (iBizz)", currency: "INR", opening: "1240880.00", file: "ICICI_Statement_Sep2026.csv" },
] as const;

export const USERS = {
  me: "Priya Sharma",
  controller: "Rahul Mehta",
  reviewer: "Ananya Iyer",
  auditor: "Vikram Rao",
} as const;
export const ALL_USERS = Object.values(USERS);
const USER_IP: Record<string, string> = {
  "Priya Sharma": "10.20.4.17",
  "Rahul Mehta": "10.20.4.22",
  "Ananya Iyer": "10.20.6.41",
  "Vikram Rao": "10.20.9.8",
};

export const MODELS = {
  flash: { name: "gemini-2.5-flash", version: "2026-06-17" },
  pro: { name: "gemini-2.5-pro", version: "2026-06-17" },
};

type Channel = "NEFT" | "RTGS" | "UPI" | "NACH" | "IMPS" | "POS" | "CHQ";

interface Party {
  name: string;
  alias: string;
  fuzzy: string[];
  gl: string;
  channels: Channel[];
  min: number;
  max: number;
  weight: number;
  credit?: boolean;
  paise?: boolean;
  fixed?: number;
  acct?: "acc_hdfc" | "acc_icici";
  memo: string;
}

const P: Party[] = [
  { name: "ACME Traders Pvt Ltd", alias: "ACME TRADERS", fuzzy: ["ACME TRDRS", "ACME TRADING CO"], gl: "5010 Raw Materials", channels: ["NEFT"], min: 40000, max: 300000, weight: 6, memo: "Raw material purchase" },
  { name: "Sharma Steel Industries", alias: "SHARMA STEEL IND", fuzzy: ["SHARMA STL INDS"], gl: "5010 Raw Materials", channels: ["RTGS", "NEFT"], min: 120000, max: 480000, weight: 3, memo: "Steel coils" },
  { name: "Amazon Web Services India", alias: "AMAZON WEB SERVICES", fuzzy: ["AWS INDIA", "AMZN WEB SVCS"], gl: "6200 Cloud & Software", channels: ["NACH"], min: 45000, max: 120000, weight: 2, paise: true, memo: "Cloud hosting" },
  { name: "Zoho Corporation", alias: "ZOHO CORP", fuzzy: ["ZOHOCORP", "ZOHO CORPORATION PVT"], gl: "6200 Cloud & Software", channels: ["NACH"], min: 8000, max: 25000, weight: 2, memo: "Zoho One subscription" },
  { name: "Google Cloud India", alias: "GOOGLE CLOUD INDIA", fuzzy: ["GOOGLE INDIA DIGITAL", "GOOGLE ASIA PACIFIC"], gl: "6200 Cloud & Software", channels: ["NACH"], min: 12000, max: 60000, weight: 2, paise: true, memo: "Workspace & GCP" },
  { name: "Reliance Jio Infocomm", alias: "RELIANCE JIO", fuzzy: ["RJIL POSTPAID", "JIO PLATFORMS"], gl: "6400 Telecom", channels: ["UPI", "NACH"], min: 2000, max: 15000, weight: 4, memo: "Postpaid & leased line" },
  { name: "Bharti Airtel Ltd", alias: "BHARTI AIRTEL", fuzzy: ["AIRTEL PAYMENTS BANK", "AIRTEL BB"], gl: "6400 Telecom", channels: ["NACH"], min: 3000, max: 12000, weight: 3, memo: "Broadband" },
  { name: "BESCOM", alias: "BESCOM BANGALORE", fuzzy: ["BANGALORE ELEC SUPPLY"], gl: "6300 Utilities", channels: ["NACH"], min: 18000, max: 60000, weight: 2, paise: true, memo: "Electricity" },
  { name: "Blue Dart Express", alias: "BLUEDART EXPRESS", fuzzy: ["BLUE DART EXP LTD"], gl: "6500 Logistics", channels: ["NEFT"], min: 5000, max: 40000, weight: 6, memo: "Courier charges" },
  { name: "Delhivery Ltd", alias: "DELHIVERY", fuzzy: ["DLVRY LOGISTICS", "DELHIVERY PVT"], gl: "6500 Logistics", channels: ["NEFT"], min: 6000, max: 55000, weight: 6, memo: "Freight" },
  { name: "Mahindra Logistics", alias: "MAHINDRA LOGISTICS", fuzzy: ["MLL SUPPLY CHAIN"], gl: "6500 Logistics", channels: ["RTGS", "NEFT"], min: 60000, max: 250000, weight: 3, memo: "Warehousing" },
  { name: "MakeMyTrip India", alias: "MAKEMYTRIP", fuzzy: ["MMT INDIA", "MAKE MY TRIP"], gl: "6600 Travel", channels: ["UPI", "POS"], min: 4000, max: 45000, weight: 5, memo: "Business travel" },
  { name: "Uber India", alias: "UBER INDIA", fuzzy: ["UBER BV", "UBER TRIP"], gl: "6600 Travel", channels: ["UPI"], min: 200, max: 2000, weight: 9, paise: true, memo: "Local conveyance" },
  { name: "Swiggy", alias: "SWIGGY", fuzzy: ["BUNDL TECHNOLOGIES", "SWIGGY INSTAMART"], gl: "6610 Staff Welfare", channels: ["UPI"], min: 300, max: 4000, weight: 9, paise: true, memo: "Team meals" },
  { name: "Office Mart Supplies", alias: "OFFICEMART", fuzzy: ["OFFICE MART SUPP"], gl: "6800 Office Supplies", channels: ["UPI", "IMPS"], min: 1000, max: 12000, weight: 5, memo: "Stationery" },
  { name: "Quess Corp", alias: "QUESS CORP", fuzzy: ["QUESS CORP LTD"], gl: "7200 Contract Staff", channels: ["NEFT"], min: 100000, max: 300000, weight: 1.5, memo: "Contract staffing" },
  { name: "Khaitan & Co", alias: "KHAITAN AND CO", fuzzy: ["KHAITAN CO LLP"], gl: "6700 Professional Fees", channels: ["NEFT"], min: 60000, max: 200000, weight: 0.6, memo: "Legal retainer" },
  { name: "Godrej Interio", alias: "GODREJ INTERIO", fuzzy: ["GODREJ AND BOYCE"], gl: "1500 Furniture & Fixtures", channels: ["NEFT"], min: 25000, max: 150000, weight: 0.6, memo: "Office furniture" },
  // Customers (credits)
  { name: "Flipkart Internet Pvt Ltd", alias: "FLIPKART INTERNET", fuzzy: ["FKRT INTERNET", "FLIPKART PAYMENTS"], gl: "4000 Revenue — Sales", channels: ["RTGS", "NEFT"], min: 150000, max: 900000, weight: 4, credit: true, memo: "Customer receipt" },
  { name: "Tata Motors Ltd", alias: "TATA MOTORS LTD", fuzzy: ["TATA MOTORS PASS VEH"], gl: "4000 Revenue — Sales", channels: ["RTGS"], min: 300000, max: 1200000, weight: 2, credit: true, memo: "Customer receipt" },
  { name: "Larsen & Toubro", alias: "LARSEN AND TOUBRO", fuzzy: ["L AND T LTD"], gl: "4000 Revenue — Sales", channels: ["NEFT", "RTGS"], min: 200000, max: 800000, weight: 2, credit: true, memo: "Customer receipt" },
  { name: "Asian Paints Ltd", alias: "ASIAN PAINTS LTD", fuzzy: ["ASIANPAINTS"], gl: "4000 Revenue — Sales", channels: ["NEFT"], min: 100000, max: 600000, weight: 2, credit: true, memo: "Customer receipt" },
  { name: "Hindustan Unilever", alias: "HINDUSTAN UNILEVER", fuzzy: ["HUL MUMBAI"], gl: "4000 Revenue — Sales", channels: ["RTGS"], min: 250000, max: 900000, weight: 1.5, credit: true, memo: "Customer receipt" },
  { name: "Razorpay Software", alias: "RAZORPAY SOFTWARE", fuzzy: ["RZP SETTLEMENT", "RAZORPAY PAYMENTS"], gl: "4010 Revenue — Online", channels: ["NEFT"], min: 20000, max: 150000, weight: 10, credit: true, paise: true, memo: "Gateway settlement" },
];

const PAYEES = P.filter((p) => !p.credit);
const PAYERS = P.filter((p) => p.credit);
const byName = (n: string) => P.find((p) => p.name === n)!;

const IFSC = ["HDFC0000123", "ICIC0000456", "UTIB0000789", "SBIN0001234", "KKBK0000958", "YESB0000221"];

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function amt(rupees: number, paise = 0, negative = false): string {
  const s = `${rupees}.${String(paise).padStart(2, "0")}`;
  return negative ? `-${s}` : s;
}

function bankDesc(rng: Rng, ch: Channel, alias: string, credit: boolean, invoice?: string): { desc: string; ref: string } {
  const ifsc = rng.pick(IFSC);
  switch (ch) {
    case "NEFT": {
      const utr = `${ifsc.slice(0, 4)}N${rng.digits(11)}`;
      return { desc: `NEFT ${credit ? "CR" : "DR"}-${ifsc}-${alias}${invoice ? `-${invoice.replace("-", "")}` : ""}`, ref: utr };
    }
    case "RTGS": {
      const utr = `${ifsc.slice(0, 4)}R${rng.digits(15)}`;
      return { desc: `RTGS ${credit ? "CR" : "DR"}-${ifsc}-${alias}-${utr.slice(-8)}`, ref: utr };
    }
    case "UPI": {
      const rrn = rng.digits(12);
      return { desc: `UPI/${rrn}/${alias}/${alias.split(" ")[0].toLowerCase()}@${rng.pick(["okhdfcbank", "ybl", "paytm", "okaxis"])}`, ref: rrn };
    }
    case "NACH": {
      const umrn = `${ifsc.slice(0, 4)}${rng.digits(14)}`;
      return { desc: `NACH-DR-${alias}-${umrn.slice(-10)}`, ref: umrn };
    }
    case "IMPS": {
      const rrn = rng.digits(12);
      return { desc: `IMPS/P2A/${rrn}/${alias}`, ref: rrn };
    }
    case "POS": {
      const auth = rng.digits(6);
      return { desc: `POS 4521XXXXXXXX${rng.digits(4)} ${alias} BANGALORE`, ref: auth };
    }
    case "CHQ": {
      const chq = `00${rng.int(4100, 4999)}`;
      return { desc: credit ? `CHQ DEP-${chq}-${alias}` : `CHQ PAID-${chq}-${alias}`, ref: chq };
    }
  }
}

const SCORE_W = { amount: 0.45, date: 0.15, vendor: 0.25, reference: 0.15 };

export function scorePair(bank: Txn[], ledger: Txn[], refMatch: boolean | null) {
  const b = bank.reduce((a, t) => a.plus(t.amount), new Big(0));
  const l = ledger.reduce((a, t) => a.plus(t.amount), new Big(0));
  const diff = b.minus(l).abs();
  const amountSim = diff.eq(0) ? 1 : Math.max(0, 1 - Number(diff.toFixed(2)) * 0.05);
  const lag = Math.abs((parseISO(bank[0].date).getTime() - parseISO(ledger[0].date).getTime()) / 86400000);
  const dateSim = Math.max(0, 1 - lag * 0.08);
  const vendorSim = vendorSimilarity(bank[0].vendorNorm, ledger[0].vendorNorm);
  const refSim = refMatch === null ? 0.6 : refMatch ? 1 : 0.2;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const breakdown = {
    amount: r3(SCORE_W.amount * amountSim),
    date: r3(SCORE_W.date * dateSim),
    vendor: r3(SCORE_W.vendor * vendorSim),
    reference: r3(SCORE_W.reference * refSim),
  };
  const score = Math.min(1, r3(breakdown.amount + breakdown.date + breakdown.vendor + breakdown.reference));
  return { breakdown, score };
}

export interface FindingRec extends Finding {
  coveredTxnIds: string[];
}

export interface Relaxable {
  bankIds: string[];
  ledgerIds: string[];
  amountTolerance: string;
  dateToleranceDays: number;
  vendorThreshold: number;
}

export type RunMeta = Omit<Run, "stats" | "review" | "categoryCounts" | "toleranceDiff">;

export interface RunRecord {
  run: RunMeta;
  txns: Map<string, Txn>;
  bankIds: string[];
  ledgerIds: string[];
  pairs: MatchPair[];
  findings: FindingRec[];
  events: RunEvent[];
  comments: Record<string, Comment[]>;
  proposedRules: ProposedRule[];
  relaxable: Relaxable[];
  /** Extra transactions referenced as evidence (e.g. next-period entries). */
  external: Map<string, Txn>;
  /** For simulated live runs. */
  sim?: { startedAt: number; timeline: { stage: string; at: number; ms: number }[]; finalized: boolean; events: (RunEvent & { at: number })[] };
}

export { DEFAULT_CONFIG };

export const STAGE_NAMES = ["Ingest", "Normalize", "Match P1", "Match P2", "Match P3", "Detect", "AI Investigate", "Verify", "Done"];

/* ------------------------------------------------------------------ */
/* Run generator                                                       */
/* ------------------------------------------------------------------ */
interface GenOptions {
  runId: string;
  period: string; // yyyy-MM
  seed: number;
  lowConfPairs: number;
  /** Probability each anomaly template is included (1 for the showcase month). */
  templateProb: number;
  /** "showcase" leaves the human-review queue partially open. */
  mode: "showcase" | "completed" | "aged" | "fresh";
  createdAt: string;
  createdBy: string;
}

export function generateRun(opts: GenOptions): RunRecord {
  const rng = new Rng(opts.seed);
  const [y, m] = opts.period.split("-").map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const dim = getDaysInMonth(monthStart);
  const ym = `${String(y).slice(2)}${String(m).padStart(2, "0")}`;
  const iso = (d: Date) => format(d, "yyyy-MM-dd");
  const day = (n: number) => new Date(y, m - 1, Math.min(n, dim));
  const businessDay = () => {
    for (;;) {
      const d = day(rng.int(1, dim));
      if (!isWeekend(d) || rng.chance(0.06)) return d;
    }
  };
  const lastSundayBefore = (n: number) => {
    for (let d = Math.min(n, dim); d > 0; d--) if (day(d).getDay() === 0) return day(d);
    return day(1);
  };

  const txns = new Map<string, Txn>();
  const external = new Map<string, Txn>();
  const bankIds: string[] = [];
  const ledgerIds: string[] = [];
  const pairs: MatchPair[] = [];
  const findings: FindingRec[] = [];
  const relaxable: Relaxable[] = [];
  let bSeq = 0;
  let lSeq = 0;
  let mSeq = 0;
  let fSeq = 0;
  let voucher = rng.int(100, 400);
  let invoice = rng.int(1800, 2600);

  const addBank = (t: Omit<Txn, "id" | "source" | "rawRow" | "sourceFile" | "sourcePage"> & { rawExtra?: Record<string, unknown> }): Txn => {
    const id = `B-${ym}-${String(++bSeq).padStart(4, "0")}`;
    const acct = ACCOUNTS.find((a) => a.id === t.accountId)!;
    const { rawExtra, ...rest } = t;
    const txn: Txn = {
      ...rest,
      id,
      source: "bank",
      sourceFile: acct.file.replace("Sep2026", format(monthStart, "MMMyyyy")),
      rawRow: { ...rawExtra },
    };
    txns.set(id, txn);
    bankIds.push(id);
    return txn;
  };

  const addLedger = (t: Omit<Txn, "id" | "source" | "rawRow" | "sourceFile">): Txn => {
    const id = `L-${ym}-${String(++lSeq).padStart(4, "0")}`;
    const txn: Txn = { ...t, id, source: "ledger", sourceFile: `Tally_DayBook_${format(monthStart, "MMMyyyy")}.csv`, rawRow: {} };
    txns.set(id, txn);
    ledgerIds.push(id);
    return txn;
  };

  const addPair = (bank: Txn[], ledger: Txn[], passName: string, refMatch: boolean | null) => {
    const { breakdown, score } = scorePair(bank, ledger, refMatch);
    pairs.push({
      id: `M-${ym}-${String(++mSeq).padStart(4, "0")}`,
      bankTxnIds: bank.map((t) => t.id),
      ledgerTxnIds: ledger.map((t) => t.id),
      score,
      passName,
      breakdown,
      status: "auto",
    });
  };

  const partyAmount = (p: Party) => {
    if (p.fixed) return amt(p.fixed, 0, !p.credit);
    let r = rng.int(p.min, p.max);
    if (r > 20000) r = Math.round(r / 10) * 10;
    const paise = p.paise ? rng.int(0, 99) : 0;
    return amt(r, paise, !p.credit);
  };

  const ledgerFor = (p: Party, date: Date, amount: string, ref: string, account: string, narr?: string) =>
    addLedger({
      date: iso(date),
      amount,
      descriptionRaw: narr ?? `${p.credit ? "Receipt" : "Payment"} — ${p.name}${ref ? ` ${ref}` : ""} · ${p.memo}`,
      vendorNorm: p.name,
      reference: ref || `${p.credit ? "RV" : "PV"}-${String(m).padStart(2, "0")}-${String(++voucher).padStart(4, "0")}`,
      accountId: account,
      glCode: p.gl,
    });

  /* ---------- Base 1:1 pairs ---------- */
  const BASE_PAIRS = 573;
  const p3Prob = opts.lowConfPairs / BASE_PAIRS;
  for (let i = 0; i < BASE_PAIRS; i++) {
    const p = rng.chance(0.24) ? rng.weighted(PAYERS) : rng.weighted(PAYEES);
    const account = p.acct ?? (rng.chance(0.7) ? "acc_hdfc" : "acc_icici");
    const ledgerDate = businessDay();
    const amount = partyAmount(p);
    const ch = rng.pick(p.channels);
    const kind = rng.next() < p3Prob ? "p3" : rng.chance(0.2) ? "p2" : "p1";
    const inv = !p.credit && (ch === "NEFT" || ch === "RTGS") && rng.chance(0.7) ? `INV-${++invoice}` : "";
    const lag = kind === "p1" ? 0 : kind === "p2" ? rng.int(1, 3) : rng.int(0, 2);
    const bankDate = addDays(ledgerDate, lag) > day(dim) ? ledgerDate : addDays(ledgerDate, lag);
    const alias = kind === "p3" ? rng.pick(p.fuzzy) : p.alias;
    const { desc, ref } = bankDesc(rng, ch, alias, !!p.credit, kind === "p3" ? undefined : inv || undefined);
    // Small FX/rounding differences on a handful of USD-billed cloud invoices
    let bankAmount = amount;
    if (p.name === "Amazon Web Services India" && rng.chance(0.35)) bankAmount = new Big(amount).minus("0.50").toFixed(2);
    const b = addBank({
      date: iso(bankDate),
      amount: bankAmount,
      descriptionRaw: desc,
      vendorNorm: kind === "p3" ? titleCase(alias) : p.name,
      reference: ref,
      accountId: account,
    });
    const l = ledgerFor(p, ledgerDate, amount, inv, account);
    const passName = kind === "p1" && bankAmount === amount ? "P1 · Exact" : kind === "p3" ? "P3 · Fuzzy vendor" : "P2 · Date ±3d";
    addPair([b], [l], passName, kind === "p3" ? false : inv ? true : null);
  }

  /* ---------- 1:N — one Flipkart deposit settles three invoices ---------- */
  {
    const fk = byName("Flipkart Internet Pvt Ltd");
    const d = day(12);
    const parts = ["248000.00", "312850.00", "181500.00"];
    const total = parts.reduce((a, v) => a.plus(v), new Big(0)).toFixed(2);
    const b = addBank({ date: iso(d), amount: total, descriptionRaw: `NEFT CR-HDFC0000999-FLIPKART INTERNET-SETTL ${format(d, "MMdd")}`, vendorNorm: fk.name, reference: `HDFCN${rng.digits(11)}`, accountId: "acc_hdfc" });
    const ls = parts.map((v, i) => ledgerFor(fk, d, v, `INV-2026-0${871 + i * 4}`, "acc_hdfc"));
    addPair([b], ls, "P4 · Group sum", true);
  }

  /* ---------- 1:N — bulk salary debit vs per-employee ledger lines ---------- */
  {
    const d = day(dim);
    const payDay = isWeekend(d) ? day(dim - (d.getDay() === 0 ? 2 : 1)) : d;
    const salaries = Array.from({ length: 20 }, () => amt(Math.round(rng.int(45000, 210000) / 100) * 100));
    const total = salaries.reduce((a, v) => a.plus(v), new Big(0));
    const b = addBank({ date: iso(payDay), amount: total.times(-1).toFixed(2), descriptionRaw: `BULK NEFT DR-SALARY ${format(monthStart, "MMMyyyy").toUpperCase()}-BATCH 42`, vendorNorm: "Payroll — Bulk salary", reference: `HDFCB${rng.digits(10)}`, accountId: "acc_hdfc" });
    const depts = ["Engineering", "Sales", "Operations", "Finance", "Design"];
    const ls = salaries.map((s, i) =>
      addLedger({
        date: iso(payDay),
        amount: `-${s}`,
        descriptionRaw: `Salary ${format(monthStart, "MMM yyyy")} — EMP-${1040 + i} (${depts[i % depts.length]})`,
        vendorNorm: "Payroll — Bulk salary",
        reference: `SAL-${ym}-${String(i + 1).padStart(2, "0")}`,
        accountId: "acc_hdfc",
        glCode: "7100 Salaries",
      }),
    );
    addPair([b], ls, "P4 · Group sum", true);
  }

  /* ---------- N:1 — Sharma Steel invoice paid in two RTGS tranches ---------- */
  {
    const ss = byName("Sharma Steel Industries");
    const l = ledgerFor(ss, day(10), "-600000.00", "INV-SS-3391", "acc_hdfc");
    const b1 = addBank({ date: iso(day(10)), amount: "-300000.00", descriptionRaw: "RTGS DR-SBIN0001234-SHARMA STEEL IND-TRANCHE1", vendorNorm: ss.name, reference: `HDFCR${rng.digits(15)}`, accountId: "acc_hdfc" });
    const b2 = addBank({ date: iso(day(11)), amount: "-300000.00", descriptionRaw: "RTGS DR-SBIN0001234-SHARMA STEEL IND-TRANCHE2", vendorNorm: ss.name, reference: `HDFCR${rng.digits(15)}`, accountId: "acc_hdfc" });
    addPair([b1, b2], [l], "P4 · Group sum", true);
  }

  /* ---------- Anomaly templates ---------- */
  const showcase = opts.mode === "showcase";
  const include = () => showcase || rng.chance(opts.templateProb);
  const createdAt = opts.createdAt;
  const findingTs = (minutes: number) => addMinutes(parseISO(createdAt), minutes).toISOString();

  type Tpl = {
    txn: Txn;
    covered?: Txn[];
    category: Category;
    signals: Omit<Signal, "txnId">[];
    explanation: string;
    evidence: string[];
    action: string;
    confidence: number;
    routing: "auto_resolve" | "human_review";
    reason?: Finding["routingReason"];
    status?: FindingStatus;
    assignee?: string;
    trace: AgentStep[];
    pro?: boolean;
  };

  const mkFinding = (t: Tpl) => {
    const signals: Signal[] = t.signals.map((s) => ({ ...s, txnId: t.txn.id }));
    const risk = noisyOr(signals.map((s) => s.score)).combined;
    const id = `F-${ym}-${String(++fSeq).padStart(3, "0")}`;
    const status: FindingStatus =
      t.routing === "auto_resolve" ? "auto_resolved" : opts.mode === "completed" ? "approved" : (t.status ?? "open");
    findings.push({
      id,
      runId: opts.runId,
      txnId: t.txn.id,
      category: t.category,
      riskScore: Math.round(risk * 1000) / 1000,
      signals,
      explanation: t.explanation,
      evidenceTxnIds: t.evidence,
      suggestedAction: t.action,
      confidence: t.confidence,
      routing: t.routing,
      routingReason: t.routing === "human_review" ? t.reason : undefined,
      status,
      agentTrace: t.trace,
      model: t.pro ? MODELS.pro : MODELS.flash,
      assignee: t.assignee,
      createdAt: findingTs(rng.int(6, 14)),
      updatedAt: findingTs(rng.int(15, 60)),
      coveredTxnIds: [t.txn.id, ...(t.covered ?? []).map((c) => c.id)],
    });
    return id;
  };

  const fmtINR = (a: string) => {
    const [i, f] = new Big(a).abs().toFixed(2).split(".");
    const last3 = i.slice(-3);
    const rest = i.slice(0, -3);
    return `₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : ""}${last3}.${f}`;
  };
  const balanceCtx = (account: string): AgentStep => ({
    tool: "get_balance_context",
    input: { account_id: account, period: opts.period },
    outputSummary: `Opening/closing balances reconcile to parsed rows; ${rng.int(28, 41)} unmatched items in period`,
    ms: rng.int(80, 220),
  });
  const searchLedger = (t: Txn, summary: string): AgentStep => ({
    tool: "search_ledger",
    input: { amount: t.amount, date_from: iso(addDays(parseISO(t.date), -7)), date_to: iso(addDays(parseISO(t.date), 7)), vendor: t.vendorNorm },
    outputSummary: summary,
    ms: rng.int(140, 520),
  });

  // -- Duplicates (bank side) --------------------------------------------------
  const dupSources = ["Blue Dart Express", "Amazon Web Services India", "Zoho Corporation"];
  dupSources.forEach((vendor, i) => {
    if (!include()) return;
    const pair = pairs.find((pp) => pp.bankTxnIds.length === 1 && pp.ledgerTxnIds.length === 1 && txns.get(pp.bankTxnIds[0])!.vendorNorm === vendor && pp.passName !== "P3 · Fuzzy vendor");
    if (!pair) return;
    const orig = txns.get(pair.bankTxnIds[0])!;
    const dupDate = addDays(parseISO(orig.date), i === 1 ? 0 : 1);
    const dup = addBank({
      date: iso(dupDate > day(dim) ? parseISO(orig.date) : dupDate),
      amount: orig.amount,
      descriptionRaw: orig.descriptionRaw.replace(/(\d{4})$/, (s) => String((Number(s) + 7) % 10000).padStart(4, "0")),
      vendorNorm: orig.vendorNorm,
      reference: `${orig.reference?.slice(0, -4)}${rng.digits(4)}`,
      accountId: orig.accountId,
    });
    mkFinding({
      txn: dup,
      category: "duplicate",
      signals: [
        { detector: "duplicate_detector", score: 0.6, evidenceIds: [orig.id], details: { matchedTxn: orig.id, amountEqual: true, daysApart: i === 1 ? 0 : 1 }, humanText: `Same amount ${fmtINR(orig.amount)} and payee as ${orig.id} ${i === 1 ? "on the same day" : "one day earlier"}` },
        { detector: "no_counterpart", score: 0.25, evidenceIds: [], details: { ledgerCandidates: 0 }, humanText: "No unmatched ledger entry for this amount within ±7 days" },
      ],
      explanation: `This debit repeats ${orig.id} — same payee (${vendor}), same amount ${fmtINR(orig.amount)}, ${i === 1 ? "same value date" : "posted one day apart"}, with a different bank reference. The original is already matched to ledger entry ${pair.ledgerTxnIds[0]}. Only one invoice exists in the ledger, so this looks like a double charge${vendor === "Amazon Web Services India" ? " from a retried NACH mandate" : ""}.`,
      evidence: [orig.id, pair.ledgerTxnIds[0]],
      action: `Raise a refund / reversal request with ${vendor}. Do not book a second expense.`,
      confidence: [0.94, 0.91, 0.89][i],
      routing: "human_review",
      reason: "Low AI confidence",
      status: showcase ? (["open", "approved", "in_review"] as const)[i] : undefined,
      assignee: showcase ? [USERS.me, USERS.me, USERS.reviewer][i] : USERS.me,
      trace: [
        balanceCtx(orig.accountId),
        { tool: "find_duplicates", input: { amount: orig.amount, vendor, window_days: 3 }, outputSummary: `1 prior bank txn with identical amount & payee: ${orig.id} (already matched)`, ms: rng.int(90, 260) },
        searchLedger(dup, `0 unmatched candidates; only ledger entry for this invoice is ${pair.ledgerTxnIds[0]} (matched to ${orig.id})`),
        { tool: "get_vendor_history", input: { vendor }, outputSummary: `${rng.int(9, 30)} payments in last 12 months; no prior duplicates`, ms: rng.int(100, 300) },
      ],
    });
  });

  // -- Duplicate on the ledger side (posted twice) -------------------------------
  if (include()) {
    const om = byName("Office Mart Supplies");
    const d = businessDay();
    const a = "-6240.00";
    const b = addBank({ date: iso(d), amount: a, descriptionRaw: `UPI/${rng.digits(12)}/OFFICEMART/officemart@okaxis`, vendorNorm: om.name, reference: rng.digits(12), accountId: "acc_icici" });
    const l1 = ledgerFor(om, d, a, "PV-OM-0912", "acc_icici");
    const l2 = ledgerFor(om, addDays(d, 1) > day(dim) ? d : addDays(d, 1), a, "PV-OM-0913", "acc_icici");
    addPair([b], [l1], "P1 · Exact", null);
    mkFinding({
      txn: l2,
      category: "duplicate",
      signals: [
        { detector: "duplicate_detector", score: 0.55, evidenceIds: [l1.id], details: { matchedTxn: l1.id }, humanText: `Ledger voucher PV-OM-0913 repeats PV-OM-0912 (same vendor & amount ₹6,240.00)` },
        { detector: "no_counterpart", score: 0.3, evidenceIds: [], details: {}, humanText: "No bank debit for a second ₹6,240.00 payment" },
      ],
      explanation: `The ledger has two payment vouchers to Office Mart Supplies for ₹6,240.00 on consecutive days, but the bank shows a single UPI debit (${b.id}), already matched to PV-OM-0912. The second voucher was most likely entered twice.`,
      evidence: [l1.id, b.id],
      action: "Reverse ledger voucher PV-OM-0913.",
      confidence: 0.9,
      routing: "human_review",
      reason: "Low AI confidence",
      status: showcase ? "open" : undefined,
      trace: [
        balanceCtx("acc_icici"),
        { tool: "find_duplicates", input: { side: "ledger", amount: a, vendor: om.name, window_days: 3 }, outputSummary: `Voucher PV-OM-0912 (${l1.id}) has identical amount and vendor`, ms: rng.int(80, 200) },
        { tool: "search_ledger", input: { side: "bank", amount: a, vendor: om.name }, outputSummary: `Only one bank debit found (${b.id}), already matched`, ms: rng.int(150, 400) },
      ],
    });
  }

  // -- Missing in ledger (bank charges, interest, unbooked spends) -------------
  const missingLedger: { desc: string; amount: string; vendor: string; acct: string; auto: boolean; conf: number; explain: string; action: string; gl: string; d: number }[] = [
    { desc: `CHRG: NEFT/RTGS CHGS ${format(monthStart, "MMMyy").toUpperCase()}`, amount: "-1180.00", vendor: "HDFC Bank — charges", acct: "acc_hdfc", auto: true, conf: 0.97, gl: "6900 Bank Charges", d: dim, explain: "Monthly NEFT/RTGS service charge (₹1,000 + 18% GST) debited by the bank. These are never pre-booked in the ledger; same pattern in each of the last 11 months.", action: "Post to GL 6900 Bank Charges." },
    { desc: "GST ON CHGS", amount: "-212.40", vendor: "HDFC Bank — charges", acct: "acc_hdfc", auto: true, conf: 0.96, gl: "6900 Bank Charges", d: dim, explain: "GST at 18% on bank service charges of ₹1,180.00. Recurring monthly; matches the bank's published tariff.", action: "Post to GL 6900 Bank Charges (input GST claimable)." },
    { desc: `INT.PD:01-${String(m).padStart(2, "0")}-${String(y).slice(2)} TO ${dim}-${String(m).padStart(2, "0")}-${String(y).slice(2)}`, amount: "4318.00", vendor: "ICICI Bank — interest", acct: "acc_icici", auto: true, conf: 0.95, gl: "4900 Interest Income", d: dim, explain: "Quarterly sweep-account interest credited by the bank. Interest is booked on receipt, so no ledger entry is expected before the statement.", action: "Post to GL 4900 Interest Income." },
    { desc: "DEBIT CARD ANNUAL FEE", amount: "-590.00", vendor: "ICICI Bank — charges", acct: "acc_icici", auto: true, conf: 0.94, gl: "6900 Bank Charges", d: 14, explain: "Annual debit-card fee of ₹500 + GST. Small, recurring bank charge.", action: "Post to GL 6900 Bank Charges." },
    { desc: `NACH-DR-LIC OF INDIA-POL${rng.digits(6)}`, amount: "-48250.00", vendor: "Life Insurance Corporation", acct: "acc_hdfc", auto: false, conf: 0.82, gl: "6950 Insurance", d: 18, explain: "Keyman insurance premium collected via NACH mandate. The policy exists in the fixed-asset register notes but the premium was not booked this month. Amount equals last year's premium.", action: "Book premium to GL 6950 Insurance; confirm policy is still active." },
    { desc: `POS 4521XXXXXXXX${rng.digits(4)} AMAZON PAY INDIA BANGALORE`, amount: "-23600.00", vendor: "Amazon Pay India", acct: "acc_hdfc", auto: false, conf: 0.71, gl: "6800 Office Supplies", d: 22, explain: "Corporate card purchase on Amazon with no matching expense claim or PO in the ledger. Similar purchases in the past were IT peripherals booked to Office Supplies.", action: "Request the invoice from the card holder and book to GL 6800." },
    { desc: `UPI/${rng.digits(12)}/GOOGLE CLOUD INDIA/gpay@okicici`, amount: "-36840.00", vendor: "Google Cloud India", acct: "acc_icici", auto: false, conf: 0.86, gl: "6200 Cloud & Software", d: 9, explain: "Annual Google Workspace add-on renewal paid by UPI instead of the usual NACH mandate, so it was missed during ledger entry. Vendor and amount are consistent with last year's renewal (₹35,400 + price increase).", action: "Book to GL 6200 Cloud & Software against the renewal invoice." },
    { desc: `IMPS/P2A/${rng.digits(12)}/MEDPLUS HEALTH`, amount: "-8450.00", vendor: "MedPlus Health Services", acct: "acc_icici", auto: false, conf: 0.66, gl: "6610 Staff Welfare", d: 16, explain: "Payment to a pharmacy chain with no ledger entry. Possibly a first-aid kit purchase or a staff reimbursement paid directly — the agent could not confirm which.", action: "Ask the office admin for the bill; book to Staff Welfare if confirmed." },
  ];
  missingLedger.forEach((x, i) => {
    if (!include()) return;
    const t = addBank({ date: iso(day(x.d)), amount: x.amount, descriptionRaw: x.desc, vendorNorm: x.vendor, reference: rng.digits(10), accountId: x.acct });
    mkFinding({
      txn: t,
      category: "missing",
      signals: [
        { detector: "no_counterpart", score: x.auto ? 0.3 : 0.5, evidenceIds: [], details: { side: "ledger" }, humanText: "No ledger entry with this amount within ±7 days" },
        ...(x.auto ? [] : [{ detector: "amount_outlier", score: 0.25 + (i % 3) * 0.1, evidenceIds: [], details: {}, humanText: "Amount within normal range for this category" }]),
      ],
      explanation: x.explain,
      evidence: [],
      action: x.action,
      confidence: x.conf,
      routing: x.auto ? "auto_resolve" : "human_review",
      reason: x.conf < 0.75 ? "Low AI confidence" : "Unknown category",
      status: showcase ? (["approved", "open", "in_review", "open"] as const)[i % 4] : undefined,
      assignee: x.auto ? undefined : i % 2 ? USERS.me : undefined,
      trace: [
        balanceCtx(x.acct),
        searchLedger(t, "0 candidates for this amount; nearest differs by > 20%"),
        { tool: "get_vendor_history", input: { vendor: x.vendor }, outputSummary: x.auto ? "Recurring monthly charge — 11 of last 11 months" : "1 similar debit in last 12 months", ms: rng.int(90, 280) },
      ],
    });
  });

  // -- Potential fraud ----------------------------------------------------------
  if (include()) {
    const d = day(24);
    const firstSeen = addDays(d, -3);
    const t = addBank({ date: iso(isWeekend(d) ? addDays(d, 1) : d), amount: "-49900.00", descriptionRaw: "NEFT DR-YESB0000221-NOVA INFRA SOLUTIONS-INV0007", vendorNorm: "Nova Infra Solutions", reference: `HDFCN${rng.digits(11)}`, accountId: "acc_hdfc" });
    mkFinding({
      txn: t,
      category: "potential_fraud",
      signals: [
        { detector: "approval_limit", score: 0.78, evidenceIds: [], details: { amount: "49900.00", limit: "50000.00", pctBelow: 0.2 }, humanText: "Amount ₹49,900.00 is 0.2% below the ₹50,000.00 approval limit" },
        { detector: "new_vendor", score: 0.7, evidenceIds: [], details: { firstSeen: iso(firstSeen), priorPayments: 0 }, humanText: `Vendor first seen 3 days ago (${format(firstSeen, "dd MMM")}); no prior payments` },
        { detector: "no_counterpart", score: 0.5, evidenceIds: [], details: {}, humanText: "No purchase order, GRN or ledger invoice references INV0007" },
        { detector: "round_amount", score: 0.3, evidenceIds: [], details: {}, humanText: "Near-round amount (₹100 below a round threshold)" },
      ],
      explanation: "Payment of ₹49,900.00 to Nova Infra Solutions, a vendor added to the master 3 days before payment. The amount sits just under the ₹50,000 approval limit, so it bypassed second-level approval. There is no matching PO, goods receipt or invoice in the ledger. This combination — new vendor, just-below-threshold amount, no supporting document — is a common pattern for split or fictitious-vendor payments.",
      evidence: [],
      action: "Hold further payments to this vendor. Verify vendor onboarding (GSTIN, bank account ownership) and obtain the invoice and approver details before booking.",
      confidence: 0.81,
      routing: "human_review",
      reason: "Potential fraud",
      status: showcase ? "open" : opts.mode === "aged" ? "approved" : undefined,
      assignee: USERS.me,
      pro: true,
      trace: [
        balanceCtx("acc_hdfc"),
        searchLedger(t, "0 ledger entries for Nova Infra Solutions; 0 entries for ₹49,900.00 ± ₹500"),
        { tool: "get_vendor_history", input: { vendor: "Nova Infra Solutions" }, outputSummary: `Vendor created ${format(firstSeen, "dd MMM yyyy")} by user ops.desk; 0 prior payments; bank a/c differs from GST-registered name`, ms: rng.int(200, 400) },
        { tool: "find_duplicates", input: { vendor: "Nova Infra Solutions", window_days: 30 }, outputSummary: "No other payments — but 2 payments of ₹49,500 to another new vendor last quarter", ms: rng.int(150, 300) },
        { tool: "check_period_boundary", input: { date: t.date }, outputSummary: "Not near period end — timing explanation ruled out", ms: rng.int(30, 80) },
      ],
    });
  }

  if (include()) {
    const d = lastSundayBefore(28);
    const t = addBank({ date: iso(d), amount: "-875000.00", descriptionRaw: "RTGS DR-ICIC0000456-GLOBAL TECH VENTURES-RTGS77120", vendorNorm: "Global Tech Ventures", reference: `ICICR${rng.digits(15)}`, accountId: "acc_icici" });
    mkFinding({
      txn: t,
      category: "potential_fraud",
      signals: [
        { detector: "weekend_payment", score: 0.65, evidenceIds: [], details: { weekday: "Sunday", priorWeekendRtgs: 0 }, humanText: `Initiated on Sunday ${format(d, "dd MMM yyyy")} — none of the 412 prior RTGS payments were made on a weekend` },
        { detector: "high_value", score: 0.6, evidenceIds: [], details: { amount: "875000.00", threshold: "500000.00" }, humanText: "₹8,75,000.00 exceeds the ₹5,00,000.00 high-value threshold" },
        { detector: "new_vendor", score: 0.55, evidenceIds: [], details: { priorPayments: 0 }, humanText: "First payment to this beneficiary" },
        { detector: "no_counterpart", score: 0.5, evidenceIds: [], details: {}, humanText: "No ledger entry or approved PO for this amount" },
      ],
      explanation: "A ₹8,75,000.00 RTGS to a first-time beneficiary was initiated on a Sunday, outside normal treasury hours. It exceeds the high-value threshold, has no ledger entry or approved PO, and the beneficiary name does not appear in the vendor master. Weekend high-value transfers to new payees are a known business-email-compromise pattern.",
      evidence: [],
      action: "Escalate to the Finance Controller immediately; contact ICICI to attempt a recall; verify who authorised the transfer in net-banking logs.",
      confidence: 0.77,
      routing: "human_review",
      reason: "Potential fraud",
      status: showcase ? "escalated" : opts.mode === "aged" ? "escalated" : undefined,
      assignee: USERS.controller,
      pro: true,
      trace: [
        balanceCtx("acc_icici"),
        searchLedger(t, "0 candidates; no PO or invoice for Global Tech Ventures"),
        { tool: "get_vendor_history", input: { vendor: "Global Tech Ventures" }, outputSummary: "Not in vendor master; 0 prior payments", ms: rng.int(150, 300) },
        { tool: "check_period_boundary", input: { date: t.date }, outputSummary: "4 days before cut-off — but no ledger entry in next period either", ms: rng.int(40, 90) },
      ],
    });
  }

  // -- Amount mismatches (bank & ledger both unmatched) -------------------------
  const mismatches = [
    { party: "Mahindra Logistics", bank: "-147000.00", ledger: "-150000.00", d: 15, ch: "NEFT" as Channel, tol: "3000.00", conf: 0.84, why: "The ₹3,000.00 difference is exactly 2% of ₹1,50,000 — the TDS rate under section 194C for contractor payments. The bank paid the net amount; the ledger booked the gross invoice value without the TDS split.", action: "Split the ledger entry: ₹1,47,000 to bank and ₹3,000 to GL 2400 TDS Payable." },
    { party: "Asian Paints Ltd", bank: "499410.00", ledger: "500000.00", d: 17, ch: "NEFT" as Channel, tol: "590.00", conf: 0.88, why: "Customer remitted ₹5,00,000 less ₹590.00 — matching the remitter bank's NEFT charge plus GST that some banks deduct at source. Invoice number appears in both narrations.", action: "Book ₹590.00 to GL 6900 Bank Charges and match the receipt." },
    { party: "Blue Dart Express", bank: "-9680.00", ledger: "-9860.00", d: 8, ch: "NEFT" as Channel, tol: "180.00", conf: 0.92, why: "The ₹180.00 difference is divisible by 9 and the amounts differ only by swapped digits (9,680 vs 9,860) — a classic transposition error in the ledger entry. The invoice reference matches on both sides.", action: "Correct the ledger voucher amount to ₹9,680.00." },
  ];
  mismatches.forEach((x) => {
    if (!include()) return;
    const p = byName(x.party);
    const inv = `INV-${++invoice}`;
    const { desc, ref } = bankDesc(rng, x.ch, p.alias, !!p.credit, inv);
    const b = addBank({ date: iso(day(x.d)), amount: x.bank, descriptionRaw: desc, vendorNorm: p.name, reference: ref, accountId: "acc_hdfc" });
    const l = ledgerFor(p, day(x.d), x.ledger, inv, "acc_hdfc");
    relaxable.push({ bankIds: [b.id], ledgerIds: [l.id], amountTolerance: x.tol, dateToleranceDays: 0, vendorThreshold: 0.9 });
    const diff = new Big(x.bank).minus(x.ledger).abs().toFixed(2);
    mkFinding({
      txn: b,
      covered: [l],
      category: "unknown",
      signals: [
        { detector: "amount_mismatch", score: 0.45, evidenceIds: [l.id], details: { ledgerTxn: l.id, diff }, humanText: `Ledger ${l.id} matches vendor, date and invoice ${inv} but differs by ${fmtINR(diff)}` },
        { detector: "no_counterpart", score: 0.2, evidenceIds: [], details: {}, humanText: "No exact-amount counterpart" },
      ],
      explanation: x.why,
      evidence: [l.id],
      action: x.action,
      confidence: x.conf,
      routing: "human_review",
      reason: "Unknown category",
      status: showcase ? "in_review" : undefined,
      assignee: showcase ? USERS.reviewer : undefined,
      trace: [
        balanceCtx("acc_hdfc"),
        searchLedger(b, `1 candidate with same vendor & invoice ${inv}: ${l.id}, amount differs by ${fmtINR(diff)}`),
        { tool: "get_vendor_history", input: { vendor: p.name }, outputSummary: `${rng.int(6, 24)} payments in last 12 months, all exact matches`, ms: rng.int(100, 250) },
      ],
    });
  });

  // -- Timing items near month end ---------------------------------------------
  const nextMonth = (n: number) => addDays(day(dim), n);
  const extId = (n: number) => `L-${format(nextMonth(1), "yyMM")}-${String(n).padStart(4, "0")}`;
  const timingBank = [
    { party: "Razorpay Software", amount: "124500.00", d: dim, booked: 1, conf: 0.95 },
    { party: "MakeMyTrip India", amount: "-32400.00", d: dim, booked: 2, conf: 0.93, ch: "POS" as Channel },
    { party: "Tata Motors Ltd", amount: "680000.00", d: dim, booked: 1, conf: 0.94 },
  ];
  timingBank.forEach((x, i) => {
    if (!include()) return;
    const p = byName(x.party);
    const { desc, ref } = bankDesc(rng, x.ch ?? p.channels[0], p.alias, !!p.credit);
    const d = isWeekend(day(x.d)) ? day(x.d - (day(x.d).getDay() === 0 ? 2 : 1)) : day(x.d);
    const t = addBank({ date: iso(d), amount: x.amount, descriptionRaw: desc, vendorNorm: p.name, reference: ref, accountId: "acc_hdfc" });
    const ext: Txn = { id: extId(12 + i), source: "ledger", date: iso(nextMonth(x.booked)), amount: x.amount, descriptionRaw: `${p.credit ? "Receipt" : "Payment"} — ${p.name} · booked next period`, vendorNorm: p.name, reference: `RV-${format(nextMonth(1), "MM")}-00${12 + i}`, accountId: "acc_hdfc", glCode: p.gl, rawRow: {}, sourceFile: `Tally_DayBook_${format(nextMonth(1), "MMMyyyy")}.csv` };
    external.set(ext.id, ext);
    const high = new Big(x.amount).abs().gte("500000");
    mkFinding({
      txn: t,
      category: "timing",
      signals: [
        { detector: "period_boundary", score: 0.35, evidenceIds: [ext.id], details: { nextPeriodEntry: ext.id, daysAfterCutoff: x.booked }, humanText: `Ledger entry ${ext.id} for the same amount is dated ${format(nextMonth(x.booked), "dd MMM")} — ${x.booked} day(s) after cut-off` },
        ...(high ? [{ detector: "high_value", score: 0.6, evidenceIds: [], details: { threshold: "500000.00" }, humanText: `${fmtINR(x.amount)} exceeds the ₹5,00,000.00 high-value threshold` }] : []),
      ],
      explanation: `Bank recorded this ${p.credit ? "receipt" : "payment"} on ${format(d, "dd MMM")} (cut-off) but the ledger booked it on ${format(nextMonth(x.booked), "dd MMM")} in the next period (${ext.id}, exact amount and vendor). This is a timing difference that will reverse automatically next month.`,
      evidence: [ext.id],
      action: "No adjustment needed. Carry forward as a reconciling item; confirm it clears next month.",
      confidence: x.conf,
      routing: high ? "human_review" : "auto_resolve",
      reason: "High value",
      status: showcase && high ? "open" : undefined,
      assignee: high ? USERS.me : undefined,
      trace: [
        balanceCtx("acc_hdfc"),
        searchLedger(t, "0 candidates in current period"),
        { tool: "check_period_boundary", input: { date: t.date, cutoff: iso(day(dim)), lookahead_days: 5 }, outputSummary: `Next-period ledger entry ${ext.id} matches amount & vendor exactly`, ms: rng.int(120, 300) },
      ],
    });
  });

  const timingLedger = [
    { party: "Sharma Steel Industries", amount: "-245000.00", d: dim - 1, label: "Cheque #004512 issued", clears: 3, kind: "Outstanding cheque" },
    { party: "Khaitan & Co", amount: "-118000.00", d: dim, label: "Cheque #004513 issued", clears: 4, kind: "Outstanding cheque" },
    { party: "Larsen & Toubro", amount: "340000.00", d: dim, label: "Cheque deposited", clears: 1, kind: "Deposit in transit" },
    { party: "Zoho Corporation", amount: "-141600.00", d: dim, label: "Annual plan — NACH presented", clears: 2, kind: "Payment in transit" },
  ];
  timingLedger.forEach((x, i) => {
    if (!include()) return;
    const p = byName(x.party);
    const l = addLedger({ date: iso(day(x.d)), amount: x.amount, descriptionRaw: `${x.label} — ${p.name} · ${p.memo}`, vendorNorm: p.name, reference: x.label.includes("#") ? x.label.split("#")[1].split(" ")[0] : `PV-${String(m).padStart(2, "0")}-${++voucher}`, accountId: "acc_hdfc", glCode: p.gl });
    const nextBankId = `B-${format(nextMonth(1), "yyMM")}-${String(30 + i).padStart(4, "0")}`;
    external.set(nextBankId, { id: nextBankId, source: "bank", date: iso(nextMonth(x.clears)), amount: x.amount, descriptionRaw: x.kind === "Deposit in transit" ? `CLG CHQ DEP-${p.alias}` : x.kind === "Payment in transit" ? `NACH-DR-${p.alias}` : `CHQ PAID-${l.reference}-${p.alias}`, vendorNorm: p.name, reference: l.reference, accountId: "acc_hdfc", rawRow: {}, sourceFile: `HDFC_Statement_${format(nextMonth(1), "MMMyyyy")}.pdf` });
    mkFinding({
      txn: l,
      category: "timing",
      signals: [{ detector: "period_boundary", score: 0.3, evidenceIds: [nextBankId], details: { clears: iso(nextMonth(x.clears)) }, humanText: `${x.kind}: clears in bank on ${format(nextMonth(x.clears), "dd MMM")} (${nextBankId})` }],
      explanation: `${x.kind}. The ledger recorded this on ${format(day(x.d), "dd MMM")}; the bank processed it on ${format(nextMonth(x.clears), "dd MMM")} (${nextBankId} in next month's statement, same amount and reference). No error — this is a normal cut-off timing difference.`,
      evidence: [nextBankId],
      action: `Carry forward as ${x.kind.toLowerCase()}.`,
      confidence: 0.96 - i * 0.01,
      routing: "auto_resolve",
      trace: [
        balanceCtx("acc_hdfc"),
        { tool: "search_ledger", input: { side: "bank", amount: x.amount, reference: l.reference }, outputSummary: "0 bank txns in current period", ms: rng.int(120, 300) },
        { tool: "check_period_boundary", input: { date: l.date, cutoff: iso(day(dim)), lookahead_days: 7 }, outputSummary: `Next-period bank txn ${nextBankId} matches amount and reference`, ms: rng.int(120, 300) },
      ],
    });
  });

  // -- Missing in bank ---------------------------------------------------------
  const missingBank = [
    { party: "Quess Corp", amount: "-186400.00", d: 21, conf: 0.79, explain: "Payment voucher booked to the HDFC bank ledger, but no matching debit exists in either bank account. The NEFT batch file for this date shows the transfer was rejected (beneficiary IFSC changed). The liability is still outstanding.", action: "Reverse the payment voucher and re-initiate the transfer with the updated IFSC.", acct: "acc_hdfc", reason: "Low AI confidence" as const },
    { party: "Larsen & Toubro", amount: "295000.00", d: 19, conf: 0.68, explain: "Receipt booked against invoice, but no credit appears in either bank account this period or the first week of next month. The customer may not have paid yet — the receipt may have been booked on the strength of a remittance advice.", action: "Confirm with the customer; if unpaid, reverse the receipt and keep the invoice open.", acct: "acc_hdfc", reason: "Low AI confidence" as const },
    { party: "Delhivery Ltd", amount: "-22815.00", d: 11, conf: 0.9, explain: "Booked against the HDFC account, but the identical debit (same amount, invoice reference) appears in the ICICI statement. The payment was made from the other account; the ledger entry used the wrong bank GL.", action: "Reclassify the voucher to the ICICI bank GL; it will then auto-match.", acct: "acc_hdfc", reason: "Unknown category" as const },
    { party: "Hindustan Unilever", amount: "420000.00", d: 23, conf: 0.87, explain: "Customer receipt booked against HDFC, but the credit landed in ICICI (customer used old bank details). Same amount and invoice number appear in the ICICI narration.", action: "Reclassify to ICICI bank GL and notify the customer to update remittance details.", acct: "acc_hdfc", reason: "High value" as const },
  ];
  missingBank.forEach((x, i) => {
    if (!include()) return;
    const p = byName(x.party);
    const inv = `INV-${++invoice}`;
    const l = ledgerFor(p, day(x.d), x.amount, inv, x.acct);
    let evidence: string[] = [];
    if (i >= 2) {
      // The counterpart sits (matched-looking) in the other account's statement.
      const { desc, ref } = bankDesc(rng, "NEFT", p.alias, !!p.credit, inv);
      const other = addBank({ date: iso(day(x.d)), amount: x.amount, descriptionRaw: desc, vendorNorm: p.name, reference: ref, accountId: "acc_icici" });
      evidence = [other.id];
      mkFinding({
        txn: other,
        category: "missing",
        signals: [{ detector: "no_counterpart", score: 0.4, evidenceIds: [l.id], details: { otherAccountLedger: l.id }, humanText: `No ICICI ledger entry; HDFC ledger ${l.id} has same amount & invoice ${inv}` }],
        explanation: `Counterpart to ${l.id}: same amount and invoice ${inv}, but booked against the HDFC bank GL. See linked finding.`,
        evidence: [l.id],
        action: "Resolve together with the HDFC ledger entry by reclassifying the GL.",
        confidence: x.conf,
        routing: "human_review",
        reason: x.reason,
        status: showcase ? "open" : undefined,
        trace: [balanceCtx("acc_icici"), searchLedger(other, `Found ${l.id} in HDFC ledger with same invoice`)],
      });
    }
    mkFinding({
      txn: l,
      category: "missing",
      signals: [
        { detector: "no_counterpart", score: 0.55, evidenceIds: evidence, details: { side: "bank" }, humanText: evidence.length ? `No HDFC bank txn; identical txn ${evidence[0]} found in ICICI` : "No bank transaction within ±10 days in any account" },
        ...(new Big(x.amount).abs().gte(100000) ? [{ detector: "high_value", score: 0.4, evidenceIds: [], details: {}, humanText: `${fmtINR(x.amount)} is a material amount` }] : []),
      ],
      explanation: x.explain,
      evidence,
      action: x.action,
      confidence: x.conf,
      routing: "human_review",
      reason: x.reason,
      status: showcase ? (["open", "open", "approved", "in_review"] as const)[i] : undefined,
      assignee: showcase ? [USERS.me, undefined, USERS.me, USERS.reviewer][i] : undefined,
      trace: [
        balanceCtx(x.acct),
        { tool: "search_ledger", input: { side: "bank", amount: x.amount, accounts: ["acc_hdfc", "acc_icici"], window_days: 10 }, outputSummary: evidence.length ? `Exact match ${evidence[0]} found in ICICI statement` : "0 candidates in either account", ms: rng.int(200, 500) },
        { tool: "check_period_boundary", input: { date: l.date, lookahead_days: 7 }, outputSummary: "Nothing in the first week of next month", ms: rng.int(60, 140) },
      ],
    });
  });

  // -- Unknown / unidentified ---------------------------------------------------
  const unknowns = [
    { desc: `IMPS/P2A/${rng.digits(12)}/RAKESH KUMAR`, amount: "-15000.00", vendor: "Rakesh Kumar", d: 13, conf: 0.52, explain: "Transfer to an individual with no employee ID, vendor record or reimbursement claim on file. Could be an employee advance or a personal payment — the agent cannot tell from the available data.", action: "Identify the beneficiary with the payment initiator; book as employee advance or recover." },
    { desc: `CASH WDL ATM 4521 MG ROAD BLR`, amount: "-20000.00", vendor: "ATM cash withdrawal", d: 6, conf: 0.61, explain: "Cash withdrawn using the corporate debit card. Petty-cash top-ups are usually booked the same day; there is no petty-cash voucher this time.", action: "Obtain petty-cash voucher and book to GL 1100 Petty Cash." },
    { desc: `UPI/${rng.digits(12)}/PAYTM-98XXXXXX21/paytm`, amount: "2500.00", vendor: "Unidentified UPI credit", d: 20, conf: 0.48, explain: "Small UPI credit from a masked mobile number. No customer invoice for ₹2,500.00 is open. Possibly a refund or an incorrect transfer.", action: "Hold in suspense (GL 2999) until the remitter is identified." },
    { desc: `NEFT CR-SBIN0001234-SRI LAKSHMI ENTERPRISES-ADV`, amount: "56640.00", vendor: "Sri Lakshmi Enterprises", d: 26, conf: 0.58, explain: "Credit from a party not in the customer master. Narration says 'ADV' — likely an advance against a quotation. ₹56,640 = ₹48,000 + 18% GST, consistent with a proforma invoice.", action: "Confirm with Sales; book as customer advance (GL 2150) and create the customer record." },
  ];
  unknowns.forEach((x, i) => {
    if (!include()) return;
    const t = addBank({ date: iso(day(x.d)), amount: x.amount, descriptionRaw: x.desc, vendorNorm: x.vendor, reference: rng.digits(12), accountId: i % 2 ? "acc_hdfc" : "acc_icici" });
    mkFinding({
      txn: t,
      category: "unknown",
      signals: [
        { detector: "no_counterpart", score: 0.5, evidenceIds: [], details: {}, humanText: "No ledger entry within ±7 days" },
        { detector: "new_vendor", score: 0.35, evidenceIds: [], details: {}, humanText: "Counterparty not in vendor or customer master" },
      ],
      explanation: x.explain,
      evidence: [],
      action: x.action,
      confidence: x.conf,
      routing: "human_review",
      reason: "Low AI confidence",
      status: showcase ? (["open", "rejected", "open", "in_review"] as const)[i] : undefined,
      assignee: showcase ? [undefined, USERS.me, undefined, USERS.me][i] : undefined,
      trace: [balanceCtx(t.accountId), searchLedger(t, "0 candidates"), { tool: "get_vendor_history", input: { vendor: x.vendor }, outputSummary: "Unknown counterparty", ms: rng.int(80, 200) }],
    });
  });

  // Ledger-only petty cash entry with no bank side
  if (include()) {
    const l = addLedger({ date: iso(day(27)), amount: "-10000.00", descriptionRaw: "Petty cash replenishment — Office", vendorNorm: "Petty cash", reference: `PC-${ym}-07`, accountId: "acc_icici", glCode: "1100 Petty Cash" });
    mkFinding({
      txn: l,
      category: "unknown",
      signals: [{ detector: "no_counterpart", score: 0.45, evidenceIds: [], details: {}, humanText: "No ATM withdrawal or cheque for ₹10,000.00 within ±7 days" }],
      explanation: "Petty-cash replenishment booked against the ICICI bank GL, but no matching withdrawal exists. A ₹20,000 ATM withdrawal on the 6th (also unmatched) may have funded two replenishments.",
      evidence: [],
      action: "Check petty-cash register; consider linking to the ₹20,000 ATM withdrawal.",
      confidence: 0.55,
      routing: "human_review",
      reason: "Low AI confidence",
      status: showcase ? "open" : undefined,
      trace: [balanceCtx("acc_icici"), searchLedger(l, "Nearest: ATM withdrawal ₹20,000.00 on the 6th (unmatched)")],
    });
  }

  /* ---------- Raw rows (with running balances) ---------- */
  for (const acct of ACCOUNTS) {
    const ids = bankIds.filter((id) => txns.get(id)!.accountId === acct.id).sort((a, b) => txns.get(a)!.date.localeCompare(txns.get(b)!.date) || a.localeCompare(b));
    let bal = new Big(acct.opening);
    ids.forEach((id, idx) => {
      const t = txns.get(id)!;
      bal = bal.plus(t.amount);
      const isPdf = acct.file.endsWith(".pdf");
      if (isPdf) t.sourcePage = Math.floor(idx / 26) + 1;
      const debit = new Big(t.amount).lt(0);
      t.rawRow = {
        ...(isPdf ? { _page: t.sourcePage, _line: (idx % 26) + 1 } : { _row: idx + 2 }),
        [isPdf ? "Date" : "Txn Date"]: format(parseISO(t.date), "dd/MM/yy"),
        [isPdf ? "Narration" : "Description"]: t.descriptionRaw,
        [isPdf ? "Chq./Ref.No." : "Ref No"]: t.reference ?? "",
        [isPdf ? "Withdrawal Amt." : "Debit"]: debit ? new Big(t.amount).abs().toFixed(2) : "",
        [isPdf ? "Deposit Amt." : "Credit"]: debit ? "" : t.amount,
        [isPdf ? "Closing Balance" : "Balance"]: bal.toFixed(2),
      };
    });
  }
  ledgerIds.forEach((id, idx) => {
    const t = txns.get(id)!;
    const debit = new Big(t.amount).lt(0);
    t.rawRow = {
      _row: idx + 2,
      "Voucher Date": format(parseISO(t.date), "dd-MMM-yyyy"),
      "Vch Type": debit ? "Payment" : "Receipt",
      "Vch No.": t.reference,
      Particulars: t.vendorNorm,
      Ledger: t.accountId === "acc_hdfc" ? "HDFC Bank A/c 4521" : "ICICI Bank A/c 8834",
      Debit: debit ? "" : t.amount,
      Credit: debit ? new Big(t.amount).abs().toFixed(2) : "",
      "Cost Centre": t.glCode,
      Narration: t.descriptionRaw,
    };
  });

  /* ---------- Proposed rules, events ---------- */
  const proposedRules =
    showcase || opts.mode === "fresh"
      ? buildProposedRules(opts.runId, txns, pairs).map((p, i) => ({ ...p, id: `PR-${ym}${opts.mode === "fresh" ? `-${opts.runId.slice(-4)}` : ""}-${i + 1}` }))
      : [];
  const events = buildEvents(createdAt, bankIds.length, ledgerIds.length, pairs, findings.length, rng);

  const durationMs = rng.int(150, 260) * 1000;
  const stages = buildStages(bankIds.length, ledgerIds.length, pairs, findings.length, rng);

  const run: RunMeta = {
    id: opts.runId,
    name: `${format(monthStart, "MMMM yyyy")} — HDFC + ICICI`,
    period: opts.period,
    status: opts.mode === "completed" ? "completed" : "awaiting_review",
    accounts: ACCOUNTS.map((a) => a.id),
    config: { ...DEFAULT_CONFIG },
    stages,
    createdAt,
    createdBy: opts.createdBy,
    durationMs,
  };

  return { run, txns, bankIds, ledgerIds, pairs, findings, events, comments: {}, proposedRules, relaxable, external };
}

function buildStages(bank: number, ledger: number, pairs: MatchPair[], findings: number, rng: Rng): RunStage[] {
  const byPass = (p: string) => pairs.filter((x) => x.passName === p).length;
  return [
    { name: "Ingest", state: "done", count: bank + ledger, ms: rng.int(6000, 14000) },
    { name: "Normalize", state: "done", count: bank + ledger, ms: rng.int(2000, 5000) },
    { name: "Match P1", state: "done", count: byPass("P1 · Exact"), ms: rng.int(1500, 4000) },
    { name: "Match P2", state: "done", count: byPass("P2 · Date ±3d") + byPass("P4 · Group sum"), ms: rng.int(1500, 4000) },
    { name: "Match P3", state: "done", count: byPass("P3 · Fuzzy vendor"), ms: rng.int(3000, 8000) },
    { name: "Detect", state: "done", count: findings, ms: rng.int(2000, 5000) },
    { name: "AI Investigate", state: "done", count: findings, ms: rng.int(60000, 140000) },
    { name: "Verify", state: "done", count: findings, ms: rng.int(1500, 3000) },
    { name: "Done", state: "done" },
  ];
}

function buildEvents(createdAt: string, bank: number, ledger: number, pairs: MatchPair[], findings: number, rng: Rng): RunEvent[] {
  const t0 = parseISO(createdAt).getTime();
  let seq = 0;
  let t = t0;
  const ev = (stage: string, message: string, level: RunEvent["level"] = "info", dt = 1500) => {
    t += dt + rng.int(0, 1500);
    return { seq: ++seq, ts: new Date(t).toISOString(), level, stage, message };
  };
  const byPass = (p: string) => pairs.filter((x) => x.passName === p).length;
  return [
    ev("Ingest", "Received 2 bank statements and 1 ledger export"),
    ev("Ingest", `Parsed ${bank} bank rows (HDFC PDF: 3 pages, ICICI CSV)`),
    ev("Ingest", "Page 3 of HDFC PDF used OCR fallback — 26 rows recovered", "warn"),
    ev("Normalize", `Normalized ${bank + ledger} transactions; 214 vendor aliases resolved`),
    ev("Normalize", "Account numbers masked before AI analysis"),
    ev("Match P1", `Pass 1 (exact): ${byPass("P1 · Exact")} pairs`),
    ev("Match P2", `Pass 2 (date ±3d): ${byPass("P2 · Date ±3d")} pairs; group-sum: ${byPass("P4 · Group sum")} groups`),
    ev("Match P3", `Pass 3 (fuzzy vendor ≥ 55%): ${byPass("P3 · Fuzzy vendor")} pairs`),
    ev("Detect", `9 detectors produced signals on ${findings} unmatched items`),
    ev("AI Investigate", `Agent investigating ${findings} items with gemini-2.5-flash`, "ai"),
    ev("AI Investigate", "Escalated 2 potential-fraud items to gemini-2.5-pro", "ai", 30000),
    ev("AI Investigate", "Agent proposed 4 matching rules (pending human approval)", "ai", 20000),
    ev("Verify", "Integrity check: bank − ledger = Σ explained + unexplained ✓"),
    ev("Done", "Run complete — routed items to human review"),
  ];
}

function buildProposedRules(runId: string, txns: Map<string, Txn>, pairs: MatchPair[]): ProposedRule[] {
  const pick = (vendor: string, n: number) =>
    pairs
      .filter((p) => txns.get(p.ledgerTxnIds[0])?.vendorNorm === vendor)
      .slice(0, n)
      .map((p) => txns.get(p.bankTxnIds[0])!);
  const aws = pairs.filter((p) => p.passName === "P3 · Fuzzy vendor" && txns.get(p.ledgerTxnIds[0])?.vendorNorm === "Amazon Web Services India").map((p) => txns.get(p.bankTxnIds[0])!);
  const acme = pick("ACME Traders Pvt Ltd", 6);
  const charges = [...txns.values()].filter((t) => t.source === "bank" && /CHRG|GST ON CHGS|ANNUAL FEE/.test(t.descriptionRaw));
  const mahindra = [...txns.values()].filter((t) => t.vendorNorm === "Mahindra Logistics").slice(0, 4);
  return [
    {
      id: "PR-001",
      runId,
      title: "ACME Traders: widen date tolerance to 7 days",
      description: "Payments to ACME Traders consistently clear 4–6 days after the ledger posting date (their bank batches NEFT credits weekly). Use a 7-day date tolerance for this vendor only.",
      scope: "vendor: ACME Traders Pvt Ltd",
      params: { vendor: "ACME Traders Pvt Ltd", dateToleranceDays: 7, appliesTo: "bank_debits" },
      supportingTxnIds: acme.map((t) => t.id),
      supportingTxns: acme,
      simulation: { matchesGained: 9, matchesChanged: 0, examples: ["Would have auto-matched 9 items across the last 3 runs that needed manual matching"] },
      confidence: 0.91,
      status: "proposed",
      model: MODELS.flash,
    },
    {
      id: "PR-002",
      runId,
      title: "Alias: 'AWS INDIA' / 'AMZN WEB SVCS' → Amazon Web Services India",
      description: "Bank narrations for the AWS NACH mandate use two abbreviations that only fuzzy-match at 55–65%. Adding them as aliases lets Pass 1 match these exactly instead of relying on low-confidence fuzzy matches.",
      scope: "vendor alias",
      params: { canonical: "Amazon Web Services India", aliases: ["AWS INDIA", "AMZN WEB SVCS"] },
      supportingTxnIds: aws.map((t) => t.id),
      supportingTxns: aws.slice(0, 6),
      simulation: { matchesGained: 0, matchesChanged: aws.length, examples: [`${aws.length} existing matches move from Pass 3 (fuzzy) to Pass 1 (exact) with higher confidence`] },
      confidence: 0.95,
      status: "proposed",
      model: MODELS.flash,
    },
    {
      id: "PR-003",
      runId,
      title: "Auto-classify small bank charges",
      description: "Bank debits whose narration starts with 'CHRG', 'GST ON CHGS' or 'ANNUAL FEE' and are under ₹2,000 are always bank charges. Classify them as 'missing in ledger — bank charge' and suggest GL 6900 automatically.",
      scope: "global",
      params: { pattern: "^(CHRG|GST ON CHGS|DEBIT CARD ANNUAL FEE)", maxAmount: "2000.00", category: "missing", suggestedGl: "6900 Bank Charges" },
      supportingTxnIds: charges.map((t) => t.id),
      supportingTxns: charges,
      simulation: { matchesGained: 0, matchesChanged: 0, examples: ["~4 items per month auto-resolved with a GL suggestion instead of AI investigation (saves ~₹3/run in model cost)"] },
      confidence: 0.97,
      status: "proposed",
      model: MODELS.flash,
    },
    {
      id: "PR-004",
      runId,
      title: "Match contractor payments net of 2% TDS",
      description: "When bank debit = ledger amount × 0.98 for vendors tagged as contractors (section 194C), match them and propose a TDS-payable split for the difference.",
      scope: "vendor group: contractors",
      params: { vendorGroup: "contractors", tdsRate: 0.02, section: "194C", action: "match_with_split" },
      supportingTxnIds: mahindra.map((t) => t.id),
      supportingTxns: mahindra,
      simulation: { matchesGained: 3, matchesChanged: 1, examples: ["Would match the Mahindra Logistics ₹1,47,000 / ₹1,50,000 pair", "1 existing match would gain a TDS split suggestion"] },
      confidence: 0.74,
      status: "proposed",
      model: MODELS.pro,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Global seed                                                         */
/* ------------------------------------------------------------------ */
export interface SeedData {
  runs: RunRecord[];
  rules: Rule[];
  detectors: Detector[];
  versions: RuleVersion[];
  audit: AuditEntry[];
  reports: Report[];
  settings: Settings;
}

export function seedAll(): SeedData {
  const runs: RunRecord[] = [];
  const anchor = new Date(2026, 8, 1); // Sep 2026
  for (let i = 11; i >= 0; i--) {
    const month = subMonths(anchor, i);
    const period = format(month, "yyyy-MM");
    const idx = 11 - i; // 0 = Oct 2025
    const created = addDays(addMonths1(month), 2 + (idx % 3));
    created.setHours(10, 12 + idx, 0, 0);
    const mode = i === 0 ? "showcase" : i === 1 ? "aged" : "completed";
    const rec = generateRun({
      runId: `run_${period.replace("-", "_")}`,
      period,
      seed: 1000 + idx * 7919,
      lowConfPairs: Math.round(112 - idx * 5.6),
      templateProb: 0.45 + (idx % 4) * 0.1,
      mode,
      createdAt: created.toISOString(),
      createdBy: idx % 3 === 2 ? USERS.controller : USERS.me,
    });
    if (mode === "aged") {
      // Leave three items open from last month so the review queue has aged/SLA items.
      rec.run.status = "awaiting_review";
      let open = 0;
      for (const f of rec.findings) {
        if (f.routing !== "human_review") continue;
        if (f.category === "potential_fraud" && f.status === "escalated") {
          open++;
          continue;
        }
        if (open < 3 && f.category === "unknown") {
          f.status = "in_review";
          f.assignee = open === 1 ? USERS.me : undefined;
          open++;
          continue;
        }
        f.status = "approved";
      }
    }
    runs.push(rec);
  }

  // A failed run to show error handling in the runs list.
  const failedCreated = new Date(2026, 9, 6, 16, 40).toISOString();
  runs.push({
    run: {
      id: "run_2026_09_icici_retry",
      name: "September 2026 — ICICI (re-upload)",
      period: "2026-09",
      status: "failed",
      accounts: ["acc_icici"],
      config: { ...DEFAULT_CONFIG },
      stages: [
        { name: "Ingest", state: "failed", count: 0, ms: 4200 },
        ...STAGE_NAMES.slice(1).map((name) => ({ name, state: "pending" as const })),
      ],
      createdAt: failedCreated,
      createdBy: USERS.me,
      durationMs: 4200,
    },
    txns: new Map(),
    bankIds: [],
    ledgerIds: [],
    pairs: [],
    findings: [],
    events: [
      { seq: 1, ts: failedCreated, level: "info", stage: "Ingest", message: "Received 1 bank statement" },
      { seq: 2, ts: failedCreated, level: "error", stage: "Ingest", message: "ICICI_Sep2026_v2.csv: header row not found (file appears to be an XLS saved with .csv extension)" },
    ],
    comments: {},
    proposedRules: [],
    relaxable: [],
    external: new Map(),
  });

  const showcase = runs.find((r) => r.run.id === "run_2026_09")!;
  const fraud = showcase.findings.find((f) => f.category === "potential_fraud" && f.status === "open");
  if (fraud) {
    showcase.comments[fraud.id] = [
      { id: "c1", author: USERS.controller, body: `@${USERS.me} please hold this one — checking with procurement whether Nova Infra went through vendor onboarding.`, createdAt: addMinutes(parseISO(showcase.run.createdAt), 180).toISOString(), mentions: [USERS.me] },
      { id: "c2", author: USERS.me, body: "Procurement has no record of an RFQ for Nova Infra. GSTIN on the invoice belongs to a different trade name.", createdAt: addMinutes(parseISO(showcase.run.createdAt), 420).toISOString(), mentions: [] },
    ];
  }

  return {
    runs,
    rules: seedRules(),
    detectors: seedDetectors(),
    versions: seedVersions(),
    audit: seedAudit(runs),
    reports: seedReports(runs),
    settings: seedSettings(),
  };
}

function addMonths1(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

function seedRules(): Rule[] {
  return [
    { id: "R-001", name: "Exact amount + date + reference", description: "Pass 1: match when amount, value date and reference agree exactly.", scope: "global", params: { pass: 1, dateToleranceDays: 0, amountTolerance: "0.00" }, enabled: true, createdBy: { type: "human", name: USERS.controller }, hitCount: 5812, lastTriggered: "2026-10-03T05:01:00Z", version: 3 },
    { id: "R-002", name: "Date tolerance ±3 business days", description: "Pass 2: allow posting-date lag of up to 3 business days.", scope: "global", params: { pass: 2, dateToleranceDays: 3, amountTolerance: "1.00" }, enabled: true, createdBy: { type: "human", name: USERS.controller }, hitCount: 1406, lastTriggered: "2026-10-03T05:01:00Z", version: 2 },
    { id: "R-003", name: "Fuzzy vendor ≥ 55%", description: "Pass 3: fuzzy vendor similarity with amount exact and date ±3d.", scope: "global", params: { pass: 3, vendorThreshold: 0.55 }, enabled: true, createdBy: { type: "human", name: USERS.controller }, hitCount: 922, lastTriggered: "2026-10-03T05:01:00Z", version: 4 },
    { id: "R-004", name: "Group-sum matching (1:N, N:1)", description: "Match one bank txn to up to 25 ledger lines whose sum is exact (payroll, settlements).", scope: "global", params: { maxGroupSize: 25, dateToleranceDays: 2 }, enabled: true, createdBy: { type: "human", name: USERS.me }, hitCount: 61, lastTriggered: "2026-10-03T05:01:00Z", version: 1 },
    { id: "R-005", name: "Mahindra Logistics posts ~2 days late", description: "Vendor-specific date tolerance of 5 days.", scope: "vendor", scopeValue: "Mahindra Logistics", params: { dateToleranceDays: 5 }, enabled: true, createdBy: { type: "ai", name: "gemini-2.5-flash" }, hitCount: 38, lastTriggered: "2026-10-03T05:01:00Z", version: 1 },
    { id: "R-006", name: "Razorpay settlement alias", description: "Treat 'RZP SETTLEMENT' as Razorpay Software.", scope: "vendor", scopeValue: "Razorpay Software", params: { aliases: ["RZP SETTLEMENT"] }, enabled: true, createdBy: { type: "ai", name: "gemini-2.5-flash" }, hitCount: 214, lastTriggered: "2026-10-03T05:01:00Z", version: 1 },
    { id: "R-007", name: "ICICI CSV amount precision", description: "ICICI CSV exports round to 2 dp; allow ₹0.01 tolerance on this account.", scope: "account", scopeValue: "ICICI ••8834", params: { amountTolerance: "0.01" }, enabled: true, createdBy: { type: "human", name: USERS.me }, hitCount: 17, lastTriggered: "2026-09-04T07:30:00Z", version: 1 },
    { id: "R-008", name: "USD-billed cloud: ₹1 FX tolerance", description: "Allow up to ₹1.00 difference on AWS & Google Cloud due to FX rounding.", scope: "vendor", scopeValue: "Amazon Web Services India", params: { amountTolerance: "1.00" }, enabled: true, createdBy: { type: "ai", name: "gemini-2.5-flash" }, hitCount: 44, lastTriggered: "2026-10-03T05:01:00Z", version: 2 },
    { id: "R-009", name: "Weekend payment hold", description: "Never auto-match RTGS payments initiated on weekends.", scope: "global", params: { channel: "RTGS", weekdays: ["Sat", "Sun"], action: "route_to_review" }, enabled: false, createdBy: { type: "human", name: USERS.controller }, hitCount: 3, lastTriggered: "2026-07-27T09:00:00Z", version: 1 },
  ];
}

function seedDetectors(): Detector[] {
  return [
    { id: "duplicate_detector", name: "Duplicate detector", description: "Flags transactions with identical amount and counterparty within a time window.", example: "Two ₹18,450 NEFT debits to Blue Dart one day apart.", enabled: true, threshold: 0.8, weight: 1 },
    { id: "approval_limit", name: "Just-below approval limit", description: "Flags payments within X% below the approval limit — a common way to avoid second-level approval.", example: "₹49,900 when the limit is ₹50,000.", enabled: true, threshold: 0.02, weight: 1 },
    { id: "new_vendor", name: "New vendor", description: "Flags payments to vendors first seen within N days.", example: "Vendor created 3 days before a ₹49,900 payment.", enabled: true, threshold: 30, weight: 0.9 },
    { id: "weekend_payment", name: "Weekend / off-hours payment", description: "Flags payments initiated on weekends or outside treasury hours.", example: "₹8.75L RTGS initiated on a Sunday.", enabled: true, threshold: 0.5, weight: 0.8 },
    { id: "high_value", name: "High value", description: "Flags transactions above the high-value threshold.", example: "Any item > ₹5,00,000.", enabled: true, threshold: 500000, weight: 0.7 },
    { id: "period_boundary", name: "Period boundary", description: "Looks for counterparts just across the cut-off date (timing differences).", example: "Cheque issued 30 Sep, cleared 3 Oct.", enabled: true, threshold: 5, weight: 0.5 },
    { id: "amount_outlier", name: "Amount outlier", description: "Flags amounts more than k standard deviations from the vendor's history.", example: "₹2.4L to a vendor whose median is ₹18K.", enabled: true, threshold: 3, weight: 0.6 },
    { id: "round_amount", name: "Round amount", description: "Flags suspiciously round amounts on vendor payments.", example: "₹50,000.00 to a logistics vendor.", enabled: true, threshold: 0.5, weight: 0.3 },
    { id: "no_counterpart", name: "No counterpart", description: "Baseline signal for any item with no candidate on the other side.", example: "Bank charge with no ledger entry.", enabled: true, threshold: 0.5, weight: 0.5 },
  ];
}

function seedVersions(): RuleVersion[] {
  return [
    { id: "v1", ruleId: "R-003", version: 2, changedBy: USERS.controller, changedAt: "2026-03-11T06:20:00Z", before: { pass: 3, vendorThreshold: 0.7 }, after: { pass: 3, vendorThreshold: 0.65 }, note: "Too many vendor aliases falling through to manual" },
    { id: "v2", ruleId: "R-003", version: 3, changedBy: USERS.controller, changedAt: "2026-05-02T09:45:00Z", before: { pass: 3, vendorThreshold: 0.65 }, after: { pass: 3, vendorThreshold: 0.6 }, note: "After alias table cleanup" },
    { id: "v3", ruleId: "R-003", version: 4, changedBy: USERS.me, changedAt: "2026-08-06T11:10:00Z", before: { pass: 3, vendorThreshold: 0.6 }, after: { pass: 3, vendorThreshold: 0.55, requireAmountExact: true }, note: "Lower threshold but require exact amount" },
    { id: "v4", ruleId: "R-008", version: 2, changedBy: USERS.me, changedAt: "2026-06-14T04:00:00Z", before: { amountTolerance: "0.50" }, after: { amountTolerance: "1.00" }, note: "Approved AI suggestion after INR depreciation" },
    { id: "v5", ruleId: "R-002", version: 2, changedBy: USERS.controller, changedAt: "2026-01-20T08:00:00Z", before: { pass: 2, dateToleranceDays: 2, amountTolerance: "0.00" }, after: { pass: 2, dateToleranceDays: 3, amountTolerance: "1.00" }, note: "Quarter-end posting lag" },
  ];
}

function seedAudit(runs: RunRecord[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  let n = 0;
  const id = () => `A-${String(++n).padStart(5, "0")}`;
  for (const r of runs) {
    const t0 = parseISO(r.run.createdAt);
    const at = (min: number) => addMinutes(t0, min).toISOString();
    out.push({ id: id(), ts: at(0), actor: { type: "user", name: r.run.createdBy }, action: "run.created", target: r.run.id, after: { period: r.run.period, accounts: r.run.accounts }, runId: r.run.id, ip: USER_IP[r.run.createdBy] });
    if (r.run.status === "failed") {
      out.push({ id: id(), ts: at(1), actor: { type: "system", name: "ingest-worker" }, action: "run.failed", target: r.run.id, after: { stage: "Ingest", error: "header row not found" }, runId: r.run.id });
      continue;
    }
    out.push({ id: id(), ts: at(1), actor: { type: "system", name: "ingest-worker" }, action: "ingest.completed", target: r.run.id, after: { bankRows: r.bankIds.length, ledgerRows: r.ledgerIds.length }, runId: r.run.id });
    out.push({ id: id(), ts: at(2), actor: { type: "system", name: "matcher" }, action: "match.completed", target: r.run.id, after: { pairs: r.pairs.length }, runId: r.run.id });
    r.findings.forEach((f, i) => {
      out.push({ id: id(), ts: at(4 + i * 0.2), actor: { type: "ai", name: "Investigation agent" }, action: "finding.classified", target: f.id, after: { category: f.category, confidence: f.confidence, riskScore: f.riskScore }, runId: r.run.id, modelVersion: `${f.model.name}@${f.model.version}` });
      if (f.status === "auto_resolved") out.push({ id: id(), ts: at(5 + i * 0.2), actor: { type: "system", name: "verifier" }, action: "finding.auto_resolved", target: f.id, before: { status: "open" }, after: { status: "auto_resolved" }, runId: r.run.id });
      if (f.status === "approved" || f.status === "rejected" || f.status === "escalated") {
        const who = f.assignee ?? USERS.me;
        out.push({ id: id(), ts: at(600 + i * 37), actor: { type: "user", name: who }, action: `finding.${f.status}`, target: f.id, before: { status: "open" }, after: { status: f.status }, runId: r.run.id, ip: USER_IP[who] });
      }
    });
    r.proposedRules.forEach((p, i) => out.push({ id: id(), ts: at(8 + i), actor: { type: "ai", name: "Investigation agent" }, action: "rule.proposed", target: p.id, after: { title: p.title, params: p.params }, runId: r.run.id, modelVersion: `${p.model.name}@${p.model.version}` }));
    if (r.run.status === "completed") out.push({ id: id(), ts: at(2880), actor: { type: "user", name: USERS.controller }, action: "run.finalized", target: r.run.id, before: { status: "awaiting_review" }, after: { status: "completed" }, runId: r.run.id, ip: USER_IP[USERS.controller] });
  }
  out.push({ id: id(), ts: "2026-08-06T11:10:00Z", actor: { type: "user", name: USERS.me }, action: "rule.updated", target: "R-003", before: { vendorThreshold: 0.6 }, after: { vendorThreshold: 0.55, requireAmountExact: true }, ip: USER_IP[USERS.me] });
  out.push({ id: id(), ts: "2026-09-15T07:00:00Z", actor: { type: "user", name: USERS.controller }, action: "settings.updated", target: "organization.approvalLimit", before: { approvalLimit: "40000.00" }, after: { approvalLimit: "50000.00" }, ip: USER_IP[USERS.controller] });
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

function seedReports(runs: RunRecord[]): Report[] {
  return runs
    .filter((r) => r.run.status === "completed")
    .slice(-4)
    .flatMap((r, i) => [
      { id: `RP-${100 + i * 2}`, runId: r.run.id, runPeriod: r.run.period, type: "reconciled_ledger" as const, format: "csv" as const, name: `reconciled-ledger-${r.run.period}.csv`, size: 182_000 + i * 3100, createdAt: addMinutes(parseISO(r.run.createdAt), 2900).toISOString(), createdBy: USERS.controller, shareUrl: `https://reconai.app/s/${r.run.id}-ledger` },
      { id: `RP-${101 + i * 2}`, runId: r.run.id, runPeriod: r.run.period, type: "anomaly_report" as const, format: "pdf" as const, name: `anomaly-report-${r.run.period}.pdf`, size: 412_000 + i * 9000, createdAt: addMinutes(parseISO(r.run.createdAt), 2910).toISOString(), createdBy: USERS.controller, shareUrl: `https://reconai.app/s/${r.run.id}-anomalies` },
    ])
    .reverse();
}

function seedSettings(): Settings {
  return {
    organization: {
      name: "Acme Manufacturing Pvt Ltd",
      accounts: ACCOUNTS.map(({ opening: _o, file: _f, ...a }) => a),
      connector: { type: "csv", provider: "Tally Prime", status: "connected" },
      approvalLimit: "50000.00",
      highValueThreshold: "500000.00",
    },
    ai: {
      provider: "gemini",
      defaultModel: "gemini-2.5-flash",
      escalationModel: "gemini-2.5-pro",
      sendDataToAi: true,
      maskAccountNumbers: true,
      maskPersonalNames: false,
      retentionDays: 30,
      estCostPerRun: "38.40",
    },
    notifications: { email: true, slack: false, slackChannel: "#finance-close", digest: "daily" },
  };
}
