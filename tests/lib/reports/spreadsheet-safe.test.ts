/**
 * `spreadsheetSafeRows` — the formula-injection guard, kept and tested while it
 * has no caller.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The guard used to be reachable only through
 * /reports' .xlsx export, and its tests therefore asserted it through
 * `excelTransactionRows`. A59 took it off that path — measured, not reasoned:
 * `XLSX.utils.aoa_to_sheet` writes a formula-leading string as `t: "s"` with no
 * `f` and emits no `<f>` element, so the .xlsx was already inert and the marker
 * only cost a visible apostrophe on ordinary prose like "-50% vendor credit".
 * The reasoning, and the list of changes that would make the guard necessary
 * again, are in lib/reports/spreadsheet-safe.ts.
 *
 * The module was KEPT because it is correct, and because the format it was
 * really written for — a genuine `.csv` or `.tsv` download, which Excel does
 * evaluate — is a plausible next feature. An untested module waiting for a
 * caller is worse than no module, so the behaviour is pinned here directly
 * rather than through an exporter that no longer calls it.
 *
 * The companion pin is tests/app/reports/export-formula-injection.test.ts: it
 * measures the property that makes the guard unnecessary TODAY. If that file
 * goes red, this one says the fix still works.
 *
 * Run as: npx cross-env TZ=America/Bogota npx vitest run tests/lib/reports/spreadsheet-safe.test.ts
 */

import { describe, expect, it } from "vitest";
import { spreadsheetSafeRows } from "@/lib/reports/spreadsheet-safe";

/**
 * This file's own copy of the dangerous set, written out here rather than
 * imported from the module under test: a test that borrows the implementation's
 * regex agrees with it by construction and proves nothing.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const PAYLOADS = [
  "=cmd|' /c calc'!A1",
  "=1+1",
  "+1+1",
  "-1+1",
  "@SUM(A1:A9)",
  '\t=HYPERLINK("http://evil.example","Invoice")',
  "\r=1+1",
];

describe("spreadsheetSafeRows neutralises every expression lead", () => {
  it.each(PAYLOADS)("marks %j so it can no longer lead a cell", (payload) => {
    const [[cell]] = spreadsheetSafeRows([[payload]]);
    expect(typeof cell).toBe("string");
    expect(cell as string).not.toMatch(FORMULA_LEAD);
  });

  it("marks with an apostrophe, the convention spreadsheets use for text", () => {
    expect(spreadsheetSafeRows([["=1+1"]])[0][0]).toBe("'=1+1");
  });

  it("prefixes rather than truncates — the whole value survives", () => {
    const payload = "=cmd|' /c calc'!A1";
    const [[cell]] = spreadsheetSafeRows([[payload]]);
    expect(cell as string).toContain(payload);
    expect((cell as string).length).toBe(payload.length + 1);
  });

  it("guards every cell of every row, not just the first", () => {
    const guarded = spreadsheetSafeRows([
      ["Description", "Added By"],
      ["=1+1", "@SUM(A1:A9)"],
      ["-1+1", "\r=1+1"],
    ]);
    guarded.slice(1).forEach((row) =>
      row.forEach((cell) => {
        expect(cell as string).not.toMatch(FORMULA_LEAD);
      })
    );
  });
});

describe("it spends a character only where there is a lead to neutralise", () => {
  it("leaves ordinary text byte-for-byte alone", () => {
    const plain = "Cloud hosting renewal for the analytics stack";
    expect(spreadsheetSafeRows([[plain]])[0][0]).toBe(plain);
  });

  it("leaves an interior =, + or @ alone — only the LEAD can start a formula", () => {
    // Over-marking is its own defect: this is the mistake that would mangle
    // "Q3 budget = 400k" or "a@b.example" for no benefit in any format.
    const interior = ["Q3 budget = 400k", "ayesha@nimbus.example", "rent + utilities"];
    interior.forEach((value) => {
      expect(spreadsheetSafeRows([[value]])[0][0]).toBe(value);
    });
  });

  it("leaves numbers as NUMBERS, so an amount column stays summable", () => {
    // The reason the guard takes rows rather than strings: a negative amount is
    // a number whose string form leads with `-`, and marking it would turn the
    // Amount column into text and break every SUM in the sheet.
    const [[date, label, amount]] = spreadsheetSafeRows([["2026-09-12", "Rent", -40]]);
    expect(date).toBe("2026-09-12");
    expect(label).toBe("Rent");
    expect(amount).toBe(-40);
    expect(typeof amount).toBe("number");
  });

  it("returns an empty cell unchanged", () => {
    expect(spreadsheetSafeRows([[""]])[0][0]).toBe("");
  });
});

describe("it is idempotent, so it can be applied uniformly", () => {
  it("does not stack markers when a guarded value is guarded again", () => {
    // Load-bearing if the guard is ever wired in at two levels, as the .xlsx
    // export did before A59: the marker is not itself a formula lead, so a
    // second pass must be a no-op.
    const once = spreadsheetSafeRows([["=1+1"]]);
    const twice = spreadsheetSafeRows(once);
    expect(twice[0][0]).toBe("'=1+1");
    expect(twice).toEqual(once);
  });
});

describe("it does not mutate what it is given", () => {
  it("returns new rows and leaves the caller's array untouched", () => {
    // The exporters build their rows once and (before A59) passed the same array
    // through the guard on its way to the sheet. Mutating in place would mean the
    // PDF and the spreadsheet could not share a row builder at all.
    const rows: (string | number)[][] = [["=1+1", 40]];
    const guarded = spreadsheetSafeRows(rows);
    expect(rows[0][0]).toBe("=1+1");
    expect(guarded[0][0]).toBe("'=1+1");
    expect(guarded).not.toBe(rows);
    expect(guarded[0]).not.toBe(rows[0]);
  });
});
