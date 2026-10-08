import Big from "big.js";
import type { Money } from "@/api/types";

/**
 * Money is always a decimal string. All arithmetic goes through big.js —
 * never parseFloat a Money value.
 */

export type MoneyLocale = "en-IN" | "en-US";
export type CurrencyCode = "INR" | "USD" | "EUR" | "GBP";

export const CURRENCY_SYMBOL: Record<CurrencyCode, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Typographic minus — aligns with tabular figures. */
export const MINUS = "−";

export function big(value: Money | number): Big {
  try {
    return new Big(value);
  } catch {
    return new Big(0);
  }
}

export function sumMoney(values: Money[]): Money {
  return values.reduce((acc, v) => acc.plus(big(v)), new Big(0)).toFixed(2);
}

export function subMoney(a: Money, b: Money): Money {
  return big(a).minus(big(b)).toFixed(2);
}

export function addMoney(a: Money, b: Money): Money {
  return big(a).plus(big(b)).toFixed(2);
}

export function absMoney(a: Money): Money {
  return big(a).abs().toFixed(2);
}

export function negMoney(a: Money): Money {
  return big(a).times(-1).toFixed(2);
}

export function isZero(a: Money): boolean {
  return big(a).eq(0);
}

export function isNegative(a: Money): boolean {
  return big(a).lt(0);
}

export function cmpMoney(a: Money, b: Money): number {
  return big(a).cmp(big(b));
}

/** Only for charts / ratios — never for amounts that will be displayed or summed. */
export function moneyToNumber(a: Money): number {
  return Number(big(a).toFixed(2));
}

/**
 * Groups an unsigned integer digit string.
 * en-IN: 12,34,56,789  (last three, then pairs)
 * en-US: 123,456,789
 */
export function groupDigits(intPart: string, locale: MoneyLocale): string {
  if (intPart.length <= 3) return intPart;
  if (locale === "en-US") {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

export interface FormatMoneyOptions {
  locale?: MoneyLocale;
  currency?: CurrencyCode;
  /** auto: minus for negatives only; always: +/−; never: absolute value */
  sign?: "auto" | "always" | "never";
  decimals?: number;
  compact?: boolean;
}

export function formatMoney(value: Money, opts: FormatMoneyOptions = {}): string {
  const { locale = "en-IN", currency = "INR", sign = "auto", decimals = 2, compact = false } = opts;
  const b = big(value);
  const negative = b.lt(0);
  const abs = b.abs();
  const symbol = CURRENCY_SYMBOL[currency];

  let body: string;
  if (compact) {
    body = compactBody(abs, locale);
  } else {
    const [intPart, frac] = abs.toFixed(decimals).split(".");
    body = groupDigits(intPart, locale) + (frac ? `.${frac}` : "");
  }

  const prefix = sign === "never" ? "" : negative ? MINUS : sign === "always" && !b.eq(0) ? "+" : "";
  return `${prefix}${symbol}${body}`;
}

function compactBody(abs: Big, locale: MoneyLocale): string {
  if (locale === "en-IN") {
    if (abs.gte(1e7)) return `${abs.div(1e7).toFixed(2)} Cr`;
    if (abs.gte(1e5)) return `${abs.div(1e5).toFixed(2)} L`;
    if (abs.gte(1e3)) return `${abs.div(1e3).toFixed(1)}K`;
    return abs.toFixed(0);
  }
  if (abs.gte(1e9)) return `${abs.div(1e9).toFixed(2)}B`;
  if (abs.gte(1e6)) return `${abs.div(1e6).toFixed(2)}M`;
  if (abs.gte(1e3)) return `${abs.div(1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}

/** Screen-reader friendly description, e.g. "debit of ₹1,24,500.00". */
export function describeMoney(value: Money, opts: FormatMoneyOptions = {}): string {
  const b = big(value);
  const abs = formatMoney(value, { ...opts, sign: "never" });
  if (b.eq(0)) return abs;
  return b.lt(0) ? `debit of ${abs}` : `credit of ${abs}`;
}
