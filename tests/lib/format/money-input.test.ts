import { describe, it, expect } from "vitest";
import { parseMoneyInput } from "@/lib/format";

/**
 * money-009: the CSV importer's amount "parser" was
 *
 *     Number(rawAmount.replace(/[^0-9.-]/g, ""))
 *
 * which deletes rather than parses — it keeps every digit, dot and minus it can
 * find and trusts whatever number falls out. Five real spreadsheet formats came
 * through it wrong AND were reported to the user as valid rows.
 *
 * The block below runs that exact expression so the bug stays executable: if
 * anyone reverts to a strip-and-trust parser, `parseMoneyInput` must not agree
 * with it. Then the rest of the file pins the new behaviour, which is "refuse
 * what you cannot read, and say which cell".
 */
const legacyStrip = (raw: string): number => Number(raw.trim().replace(/[^0-9.-]/g, ""));

/** The cell, and what the whole pipeline was supposed to store for it. */
const REAL_WORLD: Array<{ cell: string; intended: number }> = [
  { cell: "Rs. 1,000", intended: 1000 }, // home-market format
  { cell: "1.234,56", intended: 1234.56 }, // European decimal comma
  { cell: "1 234,56", intended: 1234.56 }, // French group space
  { cell: "1,00", intended: 1 }, // decimal comma, no grouping
];

describe("the parser this replaces (money-009, kept executable)", () => {
  it("really did produce a wrong number for every one of these cells", () => {
    for (let i = 0; i < REAL_WORLD.length; i++) {
      const row = REAL_WORLD[i];
      expect(legacyStrip(row.cell)).not.toBe(row.intended);
    }
    // The headline example: "Rs. 1,000" imported as ten paisa, because the dot
    // of the abbreviation survived the strip and became a decimal point.
    expect(legacyStrip("Rs. 1,000")).toBe(0.1);
    // And an accounting negative silently changed sign.
    expect(legacyStrip("(1,234.00)")).toBe(1234);
  });

  it("no longer agrees with parseMoneyInput on any of them", () => {
    for (let i = 0; i < REAL_WORLD.length; i++) {
      const result = parseMoneyInput(REAL_WORLD[i].cell);
      if (result.ok) {
        // The only cell we still read is the one we can read correctly.
        expect(result.amount).toBe(REAL_WORLD[i].intended);
      } else {
        expect(result.reason).toBeTruthy();
      }
    }
  });
});

describe("parseMoneyInput — cells it reads", () => {
  const readable: Array<[string, number]> = [
    ["1000", 1000],
    ["1,000", 1000],
    ["1,234.56", 1234.56],
    ["1,234,567.89", 1234567.89],
    ["0.01", 0.01],
    ["0", 0],
    [".50", 0.5], // a bare leading decimal point is NOT decoration
    ["1000.5", 1000.5],
    // Currency decoration, stripped as decoration — including the abbreviation
    // dot that used to turn this cell into 0.1.
    ["Rs. 1,000", 1000],
    ["Rs.1000", 1000],
    ["PKR 5,000.25", 5000.25],
    ["5,000.25 PKR", 5000.25],
    ["$1,234.56", 1234.56],
    ["£99.99", 99.99],
    ["  42  ", 42],
    // Indian lakh grouping: INR is a supported currency and en-IN exports write
    // this. The old parser got it right by accident; refusing it now would be a
    // regression for the market that files it.
    ["12,34,567", 1234567],
    ["1,23,456.78", 123456.78],
  ];

  it("reads each one as exactly the intended amount", () => {
    for (let i = 0; i < readable.length; i++) {
      const cell = readable[i][0];
      const expected = readable[i][1];
      const result = parseMoneyInput(cell);
      expect(result.ok, `expected to read ${JSON.stringify(cell)}`).toBe(true);
      if (result.ok) expect(result.amount).toBe(expected);
    }
  });
});

describe("parseMoneyInput — cells it refuses", () => {
  const refused: Array<[string, string]> = [
    // Ambiguous separators: we will not guess which locale wrote the cell,
    // because the same file would then import differently in two workspaces.
    ["1.234,56", "ambiguous"],
    ["1 234,56", "ambiguous"],
    ["1,00", "ambiguous"],
    ["1.234.567", "ambiguous"],
    ["1,2345", "ambiguous"],
    ["12,345,6", "ambiguous"],
    ["1 234", "ambiguous"], // plain space as a group separator
    ["$.50", "ambiguous"], // symbol + dot: decimal point or decoration?
    ["12a34", "ambiguous"],
    // Precision the Decimal(12,2) column cannot hold — it would have been
    // rounded, silently (money-002 via the import path).
    ["1234.567", "scale"],
    ["0.004", "scale"],
    // Magnitudes are what the importer stores; a sign means we misunderstood
    // the file, so say so instead of importing the absolute value.
    ["(1,234.00)", "negative"],
    ["-500", "negative"],
    ["500-", "negative"],
    ["-Rs. 5", "negative"],
    // Nothing numeric at all.
    ["", "empty"],
    ["   ", "empty"],
    ["n/a", "empty"],
    ["-", "empty"],
    ["()", "empty"],
  ];

  it("refuses with the reason that explains which cell is wrong", () => {
    for (let i = 0; i < refused.length; i++) {
      const cell = refused[i][0];
      const reason = refused[i][1];
      const result = parseMoneyInput(cell);
      expect(result.ok, `expected to refuse ${JSON.stringify(cell)}`).toBe(false);
      if (!result.ok) expect(result.reason, `for ${JSON.stringify(cell)}`).toBe(reason);
    }
  });

  it("reads a unicode minus as a sign, not as decoration", () => {
    // U+2212 MINUS SIGN is indistinguishable from "-" on screen. Stripped as
    // decoration it would turn a refund line into a positive expense.
    const codes = [0x2212, 0x2012, 0x2013, 0x2014];
    for (let i = 0; i < codes.length; i++) {
      const result = parseMoneyInput(String.fromCharCode(codes[i]) + "500");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("negative");
    }
  });

  it("refuses accounting parentheses even when something follows them", () => {
    // "(1,234.00)" is caught by the wrapper check; "(1,234.00) USD" is not, and
    // the decoration stripping would have dropped both brackets and imported
    // +1234 — the same sign flip, one trailing token later.
    const result = parseMoneyInput("(1,234.00) USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("negative");
    const lone = parseMoneyInput("1,234.00)");
    expect(lone.ok).toBe(false);
  });

  it("refuses a date accidentally left in the amount column", () => {
    // The column detector matches a header containing "total" or "value", so a
    // mis-mapped column is reachable. "2026-06-01" must not import as a number.
    const result = parseMoneyInput("2026-06-01");
    expect(result.ok).toBe(false);
  });

  it("refuses a cell whose group separator is a non-breaking space", () => {
    // Spreadsheets emit NBSP (U+00A0) as a thousands separator. Built from the
    // code point so this file holds no invisible characters of its own.
    const nbsp = String.fromCharCode(0x00a0);
    const result = parseMoneyInput("1" + nbsp + "234,56");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
  });

  it("never returns a number it had to invent", () => {
    // The property behind all of the above: for any cell, either we return the
    // amount a human would read, or we return no amount at all. Checked against
    // the legacy parser's output — where they differ, we must be the one that
    // refused, never the one that quietly disagreed.
    const cells = ["Rs. 1,000", "1.234,56", "1 234,56", "(1,234.00)", "1,00", "1234.567", ".50"];
    for (let i = 0; i < cells.length; i++) {
      const result = parseMoneyInput(cells[i]);
      if (result.ok && result.amount !== legacyStrip(cells[i])) {
        // Disagreement is allowed only where we are demonstrably right.
        expect(["Rs. 1,000", ".50"]).toContain(cells[i]);
      }
    }
  });
});
