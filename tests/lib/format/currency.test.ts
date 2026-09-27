import { describe, it, expect } from "vitest";
import { formatCurrency } from "@/lib/utils";
import {
  MONEY_MINOR_UNITS,
  STORED_MONEY_SCALE,
  currencyMinorUnits,
  moneyDecimalPlaces,
  isStorableMoneyScale,
} from "@/lib/format";
import { SUPPORTED_CURRENCIES } from "@/lib/schemas/company";

/**
 * money-001 / rep-001: `formatCurrency` passed `maximumFractionDigits: 0`, so no
 * amount anywhere in the product showed cents. The headline damage is not
 * cosmetic — it is that a screen's rows stop summing to the same screen's total.
 *
 * These tests are written against the INVARIANT, not against literal strings
 * where they can help it: `rowsSumToTotal` reads the numbers back out of the
 * rendered strings, so it fails for any rounding the formatter does, in any
 * currency, whatever the symbol placement.
 */

/**
 * Parse a number back out of a rendered money string. Deliberately strict about
 * what it strips: symbols, ISO codes and grouping commas go, the decimal point
 * stays. If the formatter ever emits a locale that groups with dots this helper
 * breaks loudly, which is the correct outcome — the en-US pin would have moved.
 */
function readBack(formatted: string): number {
  const digits = formatted.replace(/[^0-9.-]/g, "");
  const parsed = Number(digits);
  expect(Number.isFinite(parsed)).toBe(true);
  return parsed;
}

/**
 * The invariant money-001 is really about: whatever we print for each row, and
 * whatever we print for the total, a customer adding up what they can SEE must
 * arrive at the total we printed.
 */
function rowsSumToTotal(rows: number[], currency: string): void {
  let visibleSum = 0;
  for (let i = 0; i < rows.length; i++) {
    visibleSum += readBack(formatCurrency(rows[i], currency));
  }
  const trueTotal = rows.reduce((a, b) => a + b, 0);
  const visibleTotal = readBack(formatCurrency(trueTotal, currency));
  expect(visibleSum).toBeCloseTo(visibleTotal, 2);
  expect(visibleTotal).toBeCloseTo(trueTotal, 2);
}

/**
 * Characters ICU can emit that are invisible or unpasteable: LRM, RLM, ARABIC
 * LETTER MARK, NO-BREAK SPACE, NARROW NO-BREAK SPACE. Built from code points so
 * this file contains none of its own — the same reasoning as
 * `lib/format.ts`'s `charClass`, and the reason `formatCurrency` no longer
 * carries a regex with a pasted NBSP inside it.
 */
const INVISIBLE_CODES = [0x200e, 0x200f, 0x061c, 0x00a0, 0x202f];
const INVISIBLE = new RegExp(
  "[" + INVISIBLE_CODES.map((c) => String.fromCharCode(c)).join("") + "]"
);

describe("formatCurrency — cents (money-001, rep-001)", () => {
  it("shows both decimal places for every supported currency", () => {
    for (let i = 0; i < SUPPORTED_CURRENCIES.length; i++) {
      const currency = SUPPORTED_CURRENCIES[i];
      // 1,234.56 is the audit's own example: the PDF/report figure that printed
      // "$1,235" while the Excel export of the same click said 1234.56.
      expect(formatCurrency(1234.56, currency)).toContain("1,234.56");
    }
  });

  it("keeps a trailing zero so a ledger column lines up", () => {
    // Not `"0.5"`. `minimumFractionDigits` matters as much as the maximum:
    // "PKR 1,234.5" in a tabular-nums column is a misaligned ledger.
    expect(formatCurrency(1234.5, "PKR")).toBe("PKR 1,234.50");
    expect(formatCurrency(0, "PKR")).toBe("PKR 0.00");
  });

  it("renders three half-unit rows that add up to their own total", () => {
    // The exact scenario from the finding: three 0.50 expenses used to render
    // "PKR 1" three times beside a total of "PKR 2".
    for (let i = 0; i < SUPPORTED_CURRENCIES.length; i++) {
      rowsSumToTotal([0.5, 0.5, 0.5], SUPPORTED_CURRENCIES[i]);
    }
  });

  it("keeps rows and total in agreement for a realistic ledger", () => {
    rowsSumToTotal([1234.56, 99.99, 0.01, 45000.45, 7.5], "USD");
    rowsSumToTotal([25000.33, 4500.67, 120.5], "PKR");
  });

  it("puts the sign in front of the code for code-prefixed currencies", () => {
    // The reorder in formatCurrency only fires for currencies CLDR renders with
    // an ISO code (PKR, AED); symbol currencies keep ICU's own "-$1,234.56".
    expect(formatCurrency(-2500, "PKR")).toBe("PKR -2,500.00");
    expect(formatCurrency(-1234.56, "USD")).toBe("-$1,234.56");
  });

  it("emits no invisible or unpasteable characters", () => {
    for (let i = 0; i < SUPPORTED_CURRENCIES.length; i++) {
      const out = formatCurrency(1234.56, SUPPORTED_CURRENCIES[i]);
      expect(INVISIBLE.test(out)).toBe(false);
    }
  });

  it("still pins en-US grouping (the rep-001 locale decision, kept)", () => {
    // Documented in lib/format.ts: en-US grouping for every currency, so a
    // figure pasted into a bank portal or spreadsheet parses. en-IN would group
    // INR as ₹12,34,567.89 — deliberately not what we do.
    expect(formatCurrency(1234567.89, "INR")).toContain("1,234,567.89");
    expect(formatCurrency(1234567.89, "INR")).not.toContain("12,34,567");
  });

  it("shows cents for an unknown currency code rather than rounding it away", () => {
    // Company.currency is a plain DB column; a stale seed value must not cost
    // cents. Two paths: a real ISO code the table doesn't list, and a code
    // Intl rejects outright (which takes formatCurrency's own catch).
    expect(formatCurrency(1234.56, "CHF")).toContain("1,234.56");
    expect(formatCurrency(1234.56, "NOTACODE")).toContain("1,234.56");
  });
});

describe("the money-scale decision table", () => {
  it("has an entry for every supported currency", () => {
    // The compile-time guarantee is `Record<SupportedCurrency, number>`; this is
    // the runtime half, so a currency added with a `// @ts-expect-error` or via
    // a DB value still trips something.
    for (let i = 0; i < SUPPORTED_CURRENCIES.length; i++) {
      expect(MONEY_MINOR_UNITS[SUPPORTED_CURRENCIES[i]]).toBe(STORED_MONEY_SCALE);
    }
  });

  it("falls back to ICU's minor units for a currency it does not list", () => {
    expect(currencyMinorUnits("JPY")).toBe(0); // genuinely zero-decimal
    expect(currencyMinorUnits("KWD")).toBe(3); // three minor digits
  });

  it("falls back to the stored scale for a code ICU rejects", () => {
    expect(currencyMinorUnits("NOTACODE")).toBe(STORED_MONEY_SCALE);
    expect(currencyMinorUnits("")).toBe(STORED_MONEY_SCALE);
  });
});

describe("moneyDecimalPlaces / isStorableMoneyScale (money-002)", () => {
  it("counts the places the number actually carries", () => {
    expect(moneyDecimalPlaces(1000)).toBe(0);
    expect(moneyDecimalPlaces(0.3)).toBe(1);
    expect(moneyDecimalPlaces(1234.56)).toBe(2);
    expect(moneyDecimalPlaces(1234.567)).toBe(3);
    expect(moneyDecimalPlaces(0.004)).toBe(3);
    expect(moneyDecimalPlaces(-1234.567)).toBe(3);
  });

  it("counts exponent-form numbers, which is where the *100 test broke", () => {
    // String(1e-7) === "1e-7": no dot to count, and 7 places of precision.
    expect(moneyDecimalPlaces(1e-7)).toBe(7);
    expect(moneyDecimalPlaces(1.5e-7)).toBe(8);
    expect(moneyDecimalPlaces(1e21)).toBe(0);
  });

  it("does not reject a legitimate 2-place amount near the 1B cap", () => {
    // 999999999.99 * 100 === 99999999998.99999, so the arithmetic test the
    // audit suggested would have refused this real, storable amount.
    expect(isStorableMoneyScale(999999999.99)).toBe(true);
    expect(isStorableMoneyScale(1234.57)).toBe(true);
  });

  it("rejects anything the Decimal(12,2) column would silently change", () => {
    expect(isStorableMoneyScale(1234.567)).toBe(false);
    expect(isStorableMoneyScale(0.004)).toBe(false);
    expect(isStorableMoneyScale(0.1 + 0.2)).toBe(false);
  });

  it("treats non-finite input as 0 places (the schema's type check owns it)", () => {
    expect(moneyDecimalPlaces(NaN)).toBe(0);
    expect(moneyDecimalPlaces(Infinity)).toBe(0);
  });
});
