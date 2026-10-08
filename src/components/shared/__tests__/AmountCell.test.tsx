import { render, screen } from "@testing-library/react";
import { AmountCell } from "../AmountCell";
import { formatMoney, groupDigits, MINUS, sumMoney, subMoney } from "@/lib/money";
import { useUiStore } from "@/lib/store";

describe("money formatting", () => {
  it("groups digits the Indian way (lakhs/crores)", () => {
    expect(groupDigits("124500", "en-IN")).toBe("1,24,500");
    expect(groupDigits("12345678", "en-IN")).toBe("1,23,45,678");
    expect(groupDigits("999", "en-IN")).toBe("999");
    expect(groupDigits("1000", "en-IN")).toBe("1,000");
  });

  it("groups digits the international way", () => {
    expect(groupDigits("12345678", "en-US")).toBe("12,345,678");
  });

  it("formats with symbol, two decimals and a typographic minus for debits", () => {
    expect(formatMoney("124500")).toBe("₹1,24,500.00");
    expect(formatMoney("-124500.5")).toBe(`${MINUS}₹1,24,500.50`);
    expect(formatMoney("0")).toBe("₹0.00");
    expect(formatMoney("98765432.1", { locale: "en-US", currency: "USD" })).toBe("$98,765,432.10");
  });

  it("supports explicit sign display and compact (lakh/crore) output", () => {
    expect(formatMoney("590", { sign: "always" })).toBe("+₹590.00");
    expect(formatMoney("-590", { sign: "never" })).toBe("₹590.00");
    expect(formatMoney("12500000", { compact: true })).toBe("₹1.25 Cr");
    expect(formatMoney("437111", { compact: true })).toBe("₹4.37 L");
  });

  it("never uses floating point for money math", () => {
    expect(sumMoney(["0.1", "0.2"])).toBe("0.30"); // 0.1 + 0.2 !== 0.3 in floats
    expect(subMoney("150000.00", "147000.00")).toBe("3000.00");
    expect(sumMoney(["9999999999999.99", "0.01"])).toBe("10000000000000.00");
  });
});

describe("<AmountCell />", () => {
  it("renders a debit in red-tinted monospace with a minus and an accessible label", () => {
    render(<AmountCell value="-49900.00" />);
    const el = screen.getByTestId("amount");
    expect(el).toHaveTextContent(`${MINUS}₹49,900.00`);
    expect(el).toHaveClass("num", "text-crit/90");
    expect(el).toHaveAccessibleName("debit of ₹49,900.00");
  });

  it("renders a credit in green without a sign", () => {
    render(<AmountCell value="680000" />);
    const el = screen.getByTestId("amount");
    expect(el).toHaveTextContent("₹6,80,000.00");
    expect(el).toHaveClass("text-ok");
    expect(el).toHaveAccessibleName("credit of ₹6,80,000.00");
  });

  it("can render neutral (uncoloured) and follows the locale setting", () => {
    useUiStore.setState({ locale: "en-US", currency: "USD" });
    render(<AmountCell value="1240880.5" colorize={false} />);
    const el = screen.getByTestId("amount");
    expect(el).toHaveTextContent("$1,240,880.50");
    expect(el).not.toHaveClass("text-ok");
  });

  it("shows the full value as a tooltip when compact", () => {
    render(<AmountCell value="43711100" compact />);
    const el = screen.getByTestId("amount");
    expect(el).toHaveTextContent("₹4.37 Cr");
    expect(el).toHaveAttribute("title", "₹4,37,11,100.00");
  });
});
