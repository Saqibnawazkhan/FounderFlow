import { describe, it, expect } from "vitest";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";
import { NUMBERING_SYSTEMS, numberingLocale, type NumberingSystem } from "@/lib/i18n/numbering";
import { SUPPORTED_LOCALES } from "@/lib/i18n/strings";

/**
 * The ten glyphs of each numbering system we allow, in order. The tests below
 * drive off this rather than off a hardcoded ["en","ur"], so a locale added to
 * SUPPORTED_LOCALES is covered the day it lands.
 *
 * Spelled out as strings rather than a `/\p{Nd}/u` regex on purpose: tsconfig
 * sets no `target`, so tsc defaults to ES5 and the Unicode-property flag is
 * TS1501 — the same class of constraint as the repo's no-`downlevelIteration`
 * rule. Explicit glyphs are also a stricter assertion than "is some digit".
 */
const DIGITS: Record<NumberingSystem, string> = {
  latn: "0123456789",
  arabext: "۰۱۲۳۴۵۶۷۸۹",
};

/** Every glyph that is a digit in SOME system we allow — used to find them. */
const ANY_DIGIT = Object.keys(DIGITS)
  .map((system) => DIGITS[system as NumberingSystem])
  .join("");

/** The digit glyphs of `out`, in order of appearance. */
function digitsOf(out: string): string[] {
  return out.split("").filter((c) => ANY_DIGIT.indexOf(c) !== -1);
}

/**
 * Every character ICU might emit that is invisible and rides along on copy:
 * LRM, RLM, ARABIC LETTER MARK, NO-BREAK SPACE, NARROW NO-BREAK SPACE.
 * Built from code points so this file contains no invisible characters of its
 * own — a test for invisible characters is the last place you want one hiding.
 */
const INVISIBLE_CODES = [0x200e, 0x200f, 0x061c, 0x00a0, 0x202f];
const INVISIBLE = new RegExp(
  "[" + INVISIBLE_CODES.map((c) => String.fromCharCode(c)).join("") + "]"
);

/** LEFT-TO-RIGHT MARK — the one ICU prepends to negatives in RTL locales. */
const LRM = String.fromCharCode(0x200e);

/** A value that exercises all ten digit glyphs plus grouping. */
const ALL_TEN_DIGITS = 1234567890;

describe("NUMBERING_SYSTEMS (the locale → digit-family decision)", () => {
  it("covers exactly the supported locales, with no stale or missing entry", () => {
    // `Record<Locale, …>` already makes a MISSING key a type error. This
    // catches the other half — an entry left behind for a locale that was
    // removed, and the case where someone widens `Locale` to `string` to make
    // a new locale compile instead of deciding its digits.
    const declared = Object.keys(NUMBERING_SYSTEMS).sort();
    const supported = SUPPORTED_LOCALES.map((l) => l.code).sort();
    expect(declared).toEqual(supported);
  });

  it("declares a numbering system ICU actually honours", () => {
    // ICU does not reject an unknown `-u-nu-` subtag — it silently ignores it
    // and falls back to the locale's CLDR default. So this catches the case
    // where a locale asks for a system ICU will not give it, and renders a
    // digit family nobody chose. (A malformed tag whose fallback happens to
    // equal the declared system is invisible here by definition — the
    // exact-tag assertion below is what catches that one.)
    for (const { code } of SUPPORTED_LOCALES) {
      const resolved = new Intl.NumberFormat(numberingLocale(code)).resolvedOptions()
        .numberingSystem;
      expect(
        resolved,
        `${code} declares ${NUMBERING_SYSTEMS[code]} but ICU resolved ${resolved}`
      ).toBe(NUMBERING_SYSTEMS[code]);
    }
  });

  it("keeps Urdu on Latin digits", () => {
    // This encodes a PRODUCT DECISION, not an oversight. Urdu-as-spoken-in-
    // Pakistan (`ur` resolves to `ur-PK`) already defaults to Latin digits in
    // CLDR, and this codebase pins it there on purpose: these numbers get
    // pasted into bank portals and WhatsApp. Every other assertion in this file
    // reads NUMBERING_SYSTEMS as the source of truth, so flipping this one
    // entry to "arabext" would otherwise sail through a green suite.
    //
    // If this fails, someone re-decided it. Go read the argument in
    // lib/i18n/numbering.ts and do the prose-vs-copyable call-site split it
    // describes, rather than editing this line to match.
    expect(NUMBERING_SYSTEMS.ur).toBe("latn");
  });

  it("pins the system in the tag instead of inheriting the CLDR default", () => {
    for (const { code } of SUPPORTED_LOCALES) {
      expect(numberingLocale(code)).toBe(`${code}-u-nu-${NUMBERING_SYSTEMS[code]}`);
    }
  });
});

describe("formatNumber (grouped counts)", () => {
  it("renders each locale in the digit family that locale declares", () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const expected = DIGITS[NUMBERING_SYSTEMS[code]];
      const out = formatNumber(ALL_TEN_DIGITS, code);
      const digitChars = digitsOf(out);
      expect(digitChars.length, `${code} produced no digits at all: ${out}`).toBeGreaterThan(0);
      for (const char of digitChars) {
        expect(
          expected.indexOf(char) !== -1,
          `${code} emitted ${JSON.stringify(char)} in ${out}`
        ).toBe(true);
      }
    }
  });

  it("groups thousands", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
  });

  it("keeps a number copyable for a viewer who will paste it into a bank portal", () => {
    // The point of pinning Latin digits (see lib/i18n/numbering.ts) is that a
    // founder can select an amount and paste it into Meezan's transfer form or
    // a spreadsheet cell. Two things break that, and neither is visible on
    // screen: a non-Latin digit family, and the invisible LEFT-TO-RIGHT MARK
    // ICU prepends to negatives in RTL locales. So the invariant is not "looks
    // right" — it is "parses back to the number we started with".
    const latinLocales = SUPPORTED_LOCALES.filter((l) => NUMBERING_SYSTEMS[l.code] === "latn");
    expect(
      latinLocales.length,
      "no locale renders Latin digits — this assertion would pass vacuously"
    ).toBeGreaterThan(0);

    for (const { code } of latinLocales) {
      for (const value of [1234567, -1234.5, 0, 999]) {
        const out = formatNumber(value, code, { maximumFractionDigits: 1 });
        expect(
          INVISIBLE.test(out),
          `${code} left an invisible char in ${JSON.stringify(out)}`
        ).toBe(false);
        expect(Number(out.replace(/,/g, "")), `${code} mangled ${value} into ${out}`).toBe(value);
      }
    }
  });

  it("strips the bidi mark ICU adds to negative numbers in Urdu", () => {
    // Documents the platform behaviour this module exists to correct, and the
    // reason `sanitize()` is not dead code. Raw ICU:
    //   new Intl.NumberFormat("ur").format(-1234.5) === "<U+200E>-1,234.5"
    // If this first assertion ever fails, CLDR changed and the strip step can
    // be revisited — do not just delete the test.
    expect(new Intl.NumberFormat("ur").format(-1234.5)).toContain(LRM);
    expect(formatNumber(-1234.5, "ur", { maximumFractionDigits: 1 })).toBe("-1,234.5");
  });
});

describe("formatPercent (ratios, not percentages)", () => {
  it("takes a 0–1 ratio", () => {
    expect(formatPercent(0.423, "en")).toBe("42.3%");
  });

  it("turns a 0–100 argument into an obviously wrong number rather than a plausible one", () => {
    // Every current call site computes 0–100 and appends a literal "%".
    // Adopting this helper means dividing by 100, and this is what forgetting
    // looks like — loud enough to catch in review, which is the whole reason
    // the signature matches Intl instead of the call sites.
    expect(formatPercent(42.3, "en")).toBe("4,230%");
  });

  it("renders each locale in the digit family that locale declares", () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const expected = DIGITS[NUMBERING_SYSTEMS[code]];
      for (const char of digitsOf(formatPercent(0.423, code))) {
        expect(expected.indexOf(char) !== -1, `${code} emitted ${JSON.stringify(char)}`).toBe(true);
      }
    }
  });
});

describe("formatCompact (chart ticks)", () => {
  it("abbreviates on each locale's own scale rather than translating K", () => {
    // The real S19 finding. Urdu does not group by thousand/million/billion:
    // 1,234,567 is "12.3 لاکھ" (12.3 lakh), not "1.2 million" with different
    // glyphs. A tick formatter that hardcodes `(v / 1000).toFixed(0) + "K"` —
    // as all five chart files currently do — cannot be fixed by swapping
    // digits, which is why the audit row's prescription would have missed it.
    expect(formatCompact(1234567, "en")).toBe("1.2M");
    expect(formatCompact(1234567, "ur")).toContain("لاکھ");
    expect(formatCompact(12345, "ur")).toContain("ہزار");
  });

  it("actually shortens the number it is given", () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const plain = formatNumber(ALL_TEN_DIGITS, code);
      const compact = formatCompact(ALL_TEN_DIGITS, code);
      expect(compact.length, `${code}: ${compact} is no shorter than ${plain}`).toBeLessThan(
        plain.length
      );
    }
  });

  it("renders each locale in the digit family that locale declares", () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const expected = DIGITS[NUMBERING_SYSTEMS[code]];
      for (const char of digitsOf(formatCompact(1234567, code))) {
        expect(expected.indexOf(char) !== -1, `${code} emitted ${JSON.stringify(char)}`).toBe(true);
      }
    }
  });
});
