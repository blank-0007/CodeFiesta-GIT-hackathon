import { z } from "zod";
import type { UploadedFile } from "@/api/types";
import { DEFAULT_CONFIG } from "@/lib/matching";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 1000 or 0.50");

export const passSchema = z.object({
  name: z.string().min(1, "Name required").max(40),
  dateToleranceDays: z.coerce.number().int().min(0).max(30),
  amountTolerance: money,
  vendorThreshold: z.coerce.number().min(0).max(1),
  confidence: z.coerce.number().min(0).max(1),
});

export const configSchema = z
  .object({
    preset: z.enum(["strict", "balanced", "relaxed", "custom"]),
    dateToleranceDays: z.number().int().min(0).max(10),
    amountMode: z.enum(["exact", "tolerance"]),
    amountTolerance: money,
    vendorThreshold: z.number().min(0.5).max(1),
    referenceMatching: z.boolean(),
    multiPass: z.boolean(),
    passes: z.array(passSchema).min(1, "At least one pass is required"),
    highValueThreshold: money,
    approvalLimit: money,
    detectors: z.record(z.boolean()),
  })
  .refine((c) => Number(c.approvalLimit) <= Number(c.highValueThreshold), {
    message: "Approval limit should not exceed the high-value threshold",
    path: ["approvalLimit"],
  });

export const CANONICAL_FIELDS = [
  { id: "date", label: "Date", required: true },
  { id: "description", label: "Description / narration", required: true },
  { id: "amount", label: "Amount (signed)", required: false },
  { id: "debit", label: "Debit", required: false },
  { id: "credit", label: "Credit", required: false },
  { id: "reference", label: "Reference", required: false },
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number]["id"];

export const wizardSchema = z.object({
  name: z.string().max(80).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Choose a statement period"),
  ledgerSource: z.enum(["csv", "api"]),
  connector: z.string(),
  apiFrom: z.string(),
  apiTo: z.string(),
  signConvention: z.enum(["debit_negative", "credit_negative"]),
  mappings: z.record(z.record(z.string())),
  config: configSchema,
  maskAccountNumbers: z.boolean(),
});

export type WizardValues = z.infer<typeof wizardSchema>;

export const wizardDefaults: WizardValues = {
  name: "",
  period: "2026-09",
  ledgerSource: "csv",
  connector: "tally",
  apiFrom: "2026-09-01",
  apiTo: "2026-09-30",
  signConvention: "debit_negative",
  mappings: {},
  config: { ...DEFAULT_CONFIG, detectors: { ...DEFAULT_CONFIG.detectors } } as WizardValues["config"],
  maskAccountNumbers: true,
};

export interface FileEntry {
  localId: string;
  file: File;
  kind: "bank" | "ledger";
  accountId?: string;
  status: "uploading" | "parsed" | "needs_mapping" | "error";
  result?: UploadedFile;
  error?: string;
  ocrPending?: boolean;
}

/** Guess a mapping from column names. */
export function guessMapping(columns: string[]): Record<string, string> {
  const find = (re: RegExp) => columns.find((c) => re.test(c)) ?? "";
  return {
    date: find(/date/i),
    description: find(/narration|description|particulars|details/i),
    amount: find(/^amount$/i),
    debit: find(/debit|withdrawal/i),
    credit: find(/credit|deposit/i),
    reference: find(/ref|vch no|voucher no|chq/i),
  };
}

export function mappingErrors(m: Record<string, string> | undefined): string[] {
  const errs: string[] = [];
  if (!m?.date) errs.push("Map a Date column");
  if (!m?.description) errs.push("Map a Description column");
  if (!m?.amount && !(m?.debit && m?.credit)) errs.push("Map either a signed Amount column, or both Debit and Credit");
  return errs;
}
