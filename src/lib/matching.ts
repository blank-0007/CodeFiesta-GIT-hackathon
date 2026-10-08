import type { MatchingConfig } from "@/api/types";

export const DETECTOR_LABELS: Record<string, string> = {
  duplicate_detector: "Duplicate detector",
  approval_limit: "Just-below approval limit",
  new_vendor: "New vendor",
  weekend_payment: "Weekend / off-hours payment",
  high_value: "High value",
  period_boundary: "Period boundary (timing)",
  amount_outlier: "Amount outlier",
  round_amount: "Round amount",
  no_counterpart: "No counterpart",
};

export const DEFAULT_CONFIG: MatchingConfig = {
  preset: "balanced",
  dateToleranceDays: 3,
  amountMode: "tolerance",
  amountTolerance: "1.00",
  vendorThreshold: 0.85,
  referenceMatching: true,
  multiPass: true,
  passes: [
    { name: "P1 · Exact", dateToleranceDays: 0, amountTolerance: "0.00", vendorThreshold: 0.9, confidence: 0.97 },
    { name: "P2 · Date ±3d", dateToleranceDays: 3, amountTolerance: "1.00", vendorThreshold: 0.85, confidence: 0.92 },
    { name: "P3 · Fuzzy vendor", dateToleranceDays: 3, amountTolerance: "1.00", vendorThreshold: 0.55, confidence: 0.8 },
    { name: "P4 · Group sum", dateToleranceDays: 2, amountTolerance: "0.00", vendorThreshold: 0.8, confidence: 0.9 },
  ],
  highValueThreshold: "500000.00",
  approvalLimit: "50000.00",
  detectors: Object.fromEntries(Object.keys(DETECTOR_LABELS).map((k) => [k, true])),
  maskAccountNumbers: true,
};

export const PRESETS: Record<Exclude<MatchingConfig["preset"], "custom">, { label: string; description: string; config: MatchingConfig }> = {
  strict: {
    label: "Strict",
    description: "Exact amount and date, near-identical vendor. Fewer matches, almost no false positives.",
    config: {
      ...DEFAULT_CONFIG,
      preset: "strict",
      dateToleranceDays: 0,
      amountMode: "exact",
      amountTolerance: "0.00",
      vendorThreshold: 0.95,
      multiPass: false,
      passes: [DEFAULT_CONFIG.passes[0]],
    },
  },
  balanced: {
    label: "Balanced",
    description: "Recommended. Exact pass first, then ±3 days and fuzzy vendor passes.",
    config: DEFAULT_CONFIG,
  },
  relaxed: {
    label: "Relaxed",
    description: "Wider date and amount windows. Good for messy months; review fuzzy matches.",
    config: {
      ...DEFAULT_CONFIG,
      preset: "relaxed",
      dateToleranceDays: 5,
      amountTolerance: "5.00",
      vendorThreshold: 0.7,
      passes: [
        ...DEFAULT_CONFIG.passes,
        { name: "P5 · Relaxed", dateToleranceDays: 7, amountTolerance: "50.00", vendorThreshold: 0.5, confidence: 0.7 },
      ],
    },
  },
};
