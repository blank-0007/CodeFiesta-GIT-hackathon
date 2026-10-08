import { getDb, runView, unmatchedView, unexplained } from "@/api/mocks/db";

describe("mock seed data", () => {
  const d = getDb();
  const sep = d.index.get("run_2026_09")!;
  const run = runView(sep);
  const findings = sep.findings;

  it("has realistic September volumes and ~88% auto-match", () => {
    expect(run.stats.bankCount).toBeGreaterThanOrEqual(590);
    expect(run.stats.ledgerCount).toBeGreaterThanOrEqual(600);
    expect(run.stats.autoMatchRate).toBeGreaterThan(0.84);
    expect(run.stats.autoMatchRate).toBeLessThan(0.9);
    const um = unmatchedView(sep);
    expect(um.bank.length + um.ledger.length).toBeGreaterThanOrEqual(35);
  });

  it("contains every required scenario", () => {
    const count = (c: string) => findings.filter((f) => f.category === c).length;
    expect(count("duplicate")).toBeGreaterThanOrEqual(3);
    expect(count("potential_fraud")).toBe(2);
    expect(count("timing")).toBeGreaterThanOrEqual(6);
    expect(sep.relaxable.length).toBeGreaterThanOrEqual(2); // amount mismatches
    expect(sep.pairs.some((p) => p.ledgerTxnIds.length === 3)).toBe(true); // 1:N
    expect(sep.pairs.some((p) => p.bankTxnIds.length === 2)).toBe(true); // N:1
  });

  it("completed runs are fully explained; the open run is not", () => {
    for (const r of d.runs.filter((x) => x.run.status === "completed")) {
      expect(unexplained(runView(r)).toFixed(2)).toBe("0.00");
    }
    expect(unexplained(run).eq(0)).toBe(false);
  });
});
