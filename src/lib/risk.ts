export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Thresholds are inclusive lower bounds on a 0–1 risk score. */
export const RISK_THRESHOLDS = { medium: 0.4, high: 0.7, critical: 0.85 } as const;

export function getRiskLevel(score: number): RiskLevel {
  const s = Math.max(0, Math.min(1, score));
  if (s >= RISK_THRESHOLDS.critical) return "critical";
  if (s >= RISK_THRESHOLDS.high) return "high";
  if (s >= RISK_THRESHOLDS.medium) return "medium";
  return "low";
}

export const RISK_META: Record<RiskLevel, { label: string; text: string; bg: string; segments: number }> = {
  low: { label: "Low", text: "text-sys", bg: "bg-sys", segments: 1 },
  medium: { label: "Medium", text: "text-warn", bg: "bg-warn", segments: 2 },
  high: { label: "High", text: "text-attn", bg: "bg-attn", segments: 3 },
  critical: { label: "Critical", text: "text-crit", bg: "bg-crit", segments: 4 },
};

export type ConfidenceLevel = "high" | "medium" | "low";

export function getConfidenceLevel(c: number): ConfidenceLevel {
  if (c >= 0.9) return "high";
  if (c >= 0.7) return "medium";
  return "low";
}

/**
 * Noisy-OR combination: P(risk) = 1 − Π(1 − sᵢ).
 * Returns each signal's marginal contribution in the given order so the
 * contributions sum exactly to the combined score.
 */
export function noisyOr(scores: number[]): { combined: number; contributions: number[] } {
  let remaining = 1;
  const contributions: number[] = [];
  for (const s of scores) {
    const c = remaining * Math.max(0, Math.min(1, s));
    contributions.push(c);
    remaining -= c;
  }
  return { combined: 1 - remaining, contributions };
}

/** Priority for the review queue: risk × log-scaled amount. */
export function priorityScore(risk: number, absAmount: number): number {
  return risk * Math.log10(Math.max(10, absAmount));
}
