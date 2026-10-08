import { render, screen } from "@testing-library/react";
import { RiskMeter } from "../RiskMeter";
import { getRiskLevel, noisyOr, RISK_THRESHOLDS } from "@/lib/risk";

describe("risk thresholds", () => {
  it.each([
    [0, "low"],
    [0.39, "low"],
    [RISK_THRESHOLDS.medium, "medium"],
    [0.69, "medium"],
    [RISK_THRESHOLDS.high, "high"],
    [0.849, "high"],
    [RISK_THRESHOLDS.critical, "critical"],
    [1, "critical"],
  ] as const)("score %s → %s", (score, level) => {
    expect(getRiskLevel(score)).toBe(level);
  });

  it("clamps out-of-range scores", () => {
    expect(getRiskLevel(-0.2)).toBe("low");
    expect(getRiskLevel(1.7)).toBe("critical");
  });

  it("combines signals with noisy-OR and attributes contributions exactly", () => {
    const { combined, contributions } = noisyOr([0.78, 0.7, 0.5, 0.3]);
    expect(combined).toBeCloseTo(1 - 0.22 * 0.3 * 0.5 * 0.7, 10);
    expect(contributions.reduce((a, b) => a + b, 0)).toBeCloseTo(combined, 10);
    expect(contributions[0]).toBeCloseTo(0.78, 10);
  });
});

describe("<RiskMeter />", () => {
  it.each([
    [0.12, "Low", 1],
    [0.55, "Medium", 2],
    [0.74, "High", 3],
    [0.977, "Critical", 4],
  ])("score %s shows %s with %i filled segments and a text label", (score, label, filled) => {
    const { container } = render(<RiskMeter score={score} />);
    const meter = screen.getByRole("meter", { name: "Risk score" });
    expect(meter).toHaveAttribute("aria-valuetext", `${label} risk, ${Math.round(score * 100)} out of 100`);
    expect(meter).toHaveAttribute("data-level", label.toLowerCase());
    expect(screen.getByText(label)).toBeInTheDocument(); // colour is never the only signal
    expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(filled);
  });

  it("can hide the label and score for compact rows", () => {
    render(<RiskMeter score={0.9} showLabel={false} showScore={false} />);
    expect(screen.queryByText("Critical")).not.toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "90");
  });
});
