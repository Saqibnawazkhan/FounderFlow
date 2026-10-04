/**
 * transactions-ledger-009, CORRECTED by A59 — the .xlsx needs no formula
 * marker, and adding one mangled ordinary accounting prose for every customer.
 *
 * THE HISTORY, because it is the lesson. transactions-ledger-009 observed that a
 * `Transaction.description` can arrive from a vendor's CSV (`parseCSV` in
 * lib/transactions/csv.ts reads fields, it does not judge them), is bounded only
 * to 500 characters by `ImportTransactionRowSchema`, and reaches the .xlsx that
 * /reports hands an admin to circulate as a financial report. All true, and
 * worth closing. The fix apostrophe-prefixed every string cell leading with `=`,
 * `+`, `-`, `@`, TAB or CR. Its independent tester raised the cost as a major;
 * the remediation documented the carve-out rather than removing it.
 *
 * All three reasoned about SheetJS's cell typing from the finding's prose about
 * it. None of the three executed it.
 *
 * THE MEASUREMENT, which inverts the conclusion, and which this file now pins.
 * `XLSX.utils.aoa_to_sheet([["=1+1"]])` produces `{ t: "s", v: "=1+1" }` — a
 * string cell with NO `f` attribute — and that survives a real `XLSX.write` to
 * `XLSX.read` round trip unchanged. The bytes SheetJS emits for it are
 * `<c r="A1" t="str"><v>=1+1</v></c>`, with no `<f>` element anywhere in the
 * sheet, and an OOXML cell without an `<f>` child is not a formula: Excel has
 * nothing to evaluate and displays the text. So the .xlsx was ALREADY inert, the
 * marker prevented nothing, and it was paid for with a visible character on
 * every "-50% vendor credit" and "+1 seat add-on" in every customer's ledger —
 * while re-opening rep-006, which exists because two files from two adjacent
 * buttons disagreeing about the same row is what an auditor notices.
 *
 * WHAT THIS FILE IS NOW. The marker is gone from the .xlsx path, and these three
 * properties replace it:
 *
 *   1. The MEASURED safety property, pinned through a real write/read round trip
 *      AND against the bytes SheetJS emits — so the suite goes red if an upgrade
 *      ever starts typing these cells as formulas.
 *   2. The FORMAT that measurement covers. SheetJS picks its writer from the
 *      filename, and a `.csv` written from the same workbook IS evaluated by
 *      Excel — so the export must keep writing `.xlsx`, and must keep building
 *      sheets with the one entry point case 1 measures.
 *   3. rep-006 restored exactly: the .xlsx and the PDF print the same
 *      description for every row, prose and payload alike.
 *
 * If 1 or 2 ever goes red, the guard to wire in already exists and is already
 * tested — `spreadsheetSafeRows` in lib/reports/spreadsheet-safe.ts, with
 * tests/lib/reports/spreadsheet-safe.test.ts. That is why it was kept rather
 * than deleted: it is correct, and it is what a genuine CSV export will need on
 * the day one is built. It has no caller today, deliberately.
 *
 * Run as: npx cross-env TZ=America/Bogota npx vitest run tests/app/reports/export-formula-injection.test.ts
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import {
  TXN_DESCRIPTION_COL,
  excelTransactionRows,
  pdfTransactionRows,
} from "@/app/(app)/reports/reports-client";
import { ImportTransactionRowSchema } from "@/lib/schemas/transaction";
import type { Transaction } from "@/lib/types";

const money = (amount: number) => `PKR ${amount.toFixed(2)}`;

/**
 * Text a spreadsheet COULD treat as the start of an expression, if it were
 * written into a format that evaluates one. `=` is a formula everywhere; `+`,
 * `-` and `@` are the Lotus-compatibility prefixes Excel still honours; TAB and
 * CR are the two characters that start a new cell or row in a delimited format.
 *
 * These are the inputs case 1 measures. They are not a threat to the .xlsx — the
 * measurement is that SheetJS writes them inert — they are the inputs whose
 * INERTNESS is the property being pinned.
 */
const PAYLOADS = [
  "=cmd|' /c calc'!A1",
  "=1+1",
  "+1+1",
  "-1+1",
  "@SUM(A1:A9)",
  '\t=HYPERLINK("http://evil.example","Invoice")',
  "\r=1+1",
];

/**
 * Ordinary accounting wording that the removed guard mangled. Every one of these
 * is something a finance team types, none is dangerous in any format, and each
 * reached the spreadsheet one character longer than the customer wrote it until
 * A59. This is the list whose cleanliness is the regression pin.
 */
const PROSE = ["-50% vendor credit", "+1 seat add-on", "-200 PKR goodwill adjustment"];

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    companyId: "c1",
    type: "expense",
    amount: 1200,
    category: "Software",
    description: "Cloud hosting renewal",
    date: "2026-09-12T00:00:00.000Z",
    addedBy: "u1",
    addedByName: "Ayesha",
    createdAt: "2026-09-12T00:00:00.000Z",
    ...over,
  } as Transaction;
}

/**
 * One sheet of text, written to real .xlsx bytes by the same library and the
 * same entry point the app uses, then read back. Nothing is stubbed: if a
 * SheetJS upgrade changes how it types these cells, this changes with it.
 *
 * `type: "array"` rather than `"buffer"` so the round trip needs no Node
 * `Buffer` and runs under this suite's jsdom environment unchanged.
 */
function roundTrip(rows: (string | number)[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Transactions");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return {
    bytes,
    sheet: XLSX.read(bytes, { type: "array" }).Sheets.Transactions,
  };
}

/** The sheet XML SheetJS actually emitted, straight out of the written bytes. */
function sheetXml(bytes: Uint8Array): string {
  const cfb = XLSX.CFB.read(bytes, { type: "array" });
  const index = cfb.FullPaths.findIndex((p: string) => p.endsWith("xl/worksheets/sheet1.xml"));
  expect(index).toBeGreaterThanOrEqual(0);
  const content = cfb.FileIndex[index].content as Uint8Array;
  return new TextDecoder().decode(new Uint8Array(content));
}

describe("1. SheetJS writes app text inert, which is why the .xlsx needs no marker", () => {
  PAYLOADS.forEach((payload) => {
    it(`types ${JSON.stringify(payload)} as a string with no formula, through a real write/read`, () => {
      // Before the write: the in-memory cell the app hands the writer.
      const authored = XLSX.utils.aoa_to_sheet([[payload]]).A1;
      expect(authored.t).toBe("s");
      expect(authored.f).toBeUndefined();
      expect(authored.v).toBe(payload);

      // After a real round trip: the cell a spreadsheet would open.
      const cell = roundTrip([[payload]]).sheet.A1;
      expect(cell.t).toBe("s");
      expect(cell.f).toBeUndefined();
      expect(cell.v).toBe(payload);
    });
  });

  it("emits no <f> element anywhere in the sheet, which is what makes a cell a formula", () => {
    // The parsed-cell assertions above go through SheetJS's own reader. This one
    // reads the bytes, because the question is what EXCEL will do with them: an
    // OOXML cell with no `<f>` child has no expression to evaluate, whatever its
    // `t` attribute says.
    const { bytes } = roundTrip(PAYLOADS.map((p) => [p]));
    const xml = sheetXml(bytes);
    expect(xml).toContain("<sheetData>");
    expect(xml).not.toMatch(/<f[ >/]/);
    // And the payload really is in there — otherwise the assertion above would
    // pass just as happily against an empty sheet.
    expect(xml).toContain("=1+1");
  });

  it("keeps a number a number, so the Amount column stays summable", () => {
    const cell = roundTrip([[-40]]).sheet.A1;
    expect(cell.t).toBe("n");
    expect(cell.v).toBe(-40);
  });
});

describe("2. the export stays inside the format and entry point that measurement covers", () => {
  const SOURCE = readFileSync(
    join(process.cwd(), "app", "(app)", "reports", "reports-client.tsx"),
    "utf8"
  );

  /**
   * The source with its comments removed, so the assertions below read code
   * rather than prose. The previous version of this test counted raw text and
   * went red the moment anyone wrote `aoa_to_sheet(` in a sentence — the
   * surrounding comments discuss these helpers by name constantly, so that was a
   * live trap rather than a theoretical one.
   *
   * Approximate by design, and biased: the `[^:/]` lookbehind stand-in keeps a
   * `://` inside a string from swallowing the rest of its line (which could HIDE
   * a real call), while a builder name left inside a string literal is still
   * counted (which can only cause a loud failure, never a silent pass). For a
   * safety assertion that is the right direction to be wrong in.
   */
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/gm, "$1");

  /**
   * Keyed on the `XLSX.utils.` namespace rather than the bare function name, and
   * that is load-bearing: this file binds the library once, locally, as
   * `const XLSX = await import("xlsx")`. There is no top-level or destructured
   * import, so a real call site CANNOT spell a builder without the namespace,
   * while prose always does.
   */
  const BUILDER = (name: string) => new RegExp(`XLSX\\.utils\\.${name}\\(\\s*`, "g");

  it("writes a .xlsx, never a delimited format Excel would evaluate", () => {
    // THE hazard, and the one transactions-ledger-009 should have been narrowed
    // to. SheetJS picks its writer from the filename, so changing this template
    // to a `.csv` turns every payload above into live formula execution on a
    // finance team's machines, with no other edit anywhere. If that is ever
    // wanted, `spreadsheetSafeRows` (lib/reports/spreadsheet-safe.ts) is the
    // guard to wire in at that point.
    const writes = CODE.match(/XLSX\.writeFile\(/g) ?? [];
    expect(writes.length).toBe(1);
    expect(CODE).toMatch(/XLSX\.writeFile\([\s\S]{0,400}?\.xlsx`/);
    expect(CODE).not.toMatch(/\.(csv|txt|prn|slk|dif|eth|html)`/);
    // `bookType` overrides the extension, so its absence is part of the claim
    // that the extension decides the format.
    expect(CODE).not.toContain("bookType");
  });

  it("builds every sheet with aoa_to_sheet, the entry point case 1 measures", () => {
    const calls = CODE.match(BUILDER("aoa_to_sheet")) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * The other doors. `aoa_to_sheet` is one of five SheetJS entry points that can
   * put app text into a worksheet, and case 1 measures only that one. Stated as
   * "none of these appears at all" so that if one is genuinely wanted later, its
   * author has to extend the measurement to cover it rather than inherit a pass
   * from this file. The failure names the helper.
   */
  it.each(["json_to_sheet", "sheet_add_aoa", "sheet_add_json", "table_to_sheet"])(
    "builds no sheet with XLSX.utils.%s, which case 1 does not measure",
    (name) => {
      expect(CODE.match(BUILDER(name)) ?? []).toEqual([]);
    }
  );
});

describe("3. the .xlsx and the PDF print the same description (rep-006, restored)", () => {
  PROSE.forEach((prose) => {
    it(`writes ${JSON.stringify(prose)} into the spreadsheet exactly as typed`, () => {
      // THE A59 REGRESSION PIN. Each of these read `'${prose}` until the marker
      // was taken off the .xlsx path.
      const [row] = excelTransactionRows([txn({ description: prose })]);
      expect(row[TXN_DESCRIPTION_COL]).toBe(prose);
    });

    it(`prints ${JSON.stringify(prose)} identically in both files`, () => {
      const [pdfRow] = pdfTransactionRows([txn({ description: prose })], money);
      const [xlsRow] = excelTransactionRows([txn({ description: prose })]);
      expect(xlsRow[TXN_DESCRIPTION_COL]).toBe(pdfRow[TXN_DESCRIPTION_COL]);
    });
  });

  it("adds no character to a payload either — the cell is inert, not rewritten", () => {
    PAYLOADS.forEach((payload) => {
      const [row] = excelTransactionRows([txn({ description: payload })]);
      expect(row[TXN_DESCRIPTION_COL]).toBe(payload);
    });
  });

  it("leaves the denormalised author name as the member chose it", () => {
    // lib/schemas/profile.ts bounds `name` to 80 characters and nothing else, so
    // a member really can name themselves "=1+1" and appear in every export.
    // That is inert in the .xlsx per case 1, so it is printed, not marked.
    const [row] = excelTransactionRows([txn({ addedByName: "=1+1" })]);
    expect(row[4]).toBe("=1+1");
  });

  it("agrees cell for cell across prose, payloads and the length bound", () => {
    // Strict equality, restored. The carve-out this case used to carry — "the
    // spreadsheet cell ends with the PDF cell and is at most one character
    // longer" — existed only to accommodate the marker, and a loosened equality
    // is exactly where a truncation can return unnoticed.
    const txns = [...PAYLOADS, ...PROSE, "Office rent", "x".repeat(500)].map((d, i) =>
      txn({ id: `t${i}`, description: d })
    );
    const pdf = pdfTransactionRows(txns, money);
    const xls = excelTransactionRows(txns);
    expect(pdf.length).toBe(xls.length);
    pdf.forEach((row, i) => {
      expect(xls[i][TXN_DESCRIPTION_COL]).toBe(row[TXN_DESCRIPTION_COL]);
    });
  });

  it("keeps the Excel amount a signed NUMBER", () => {
    const rows = excelTransactionRows([
      txn({ type: "expense", amount: 40, description: "=1+1" }),
      txn({ type: "income", amount: 40, description: "-1" }),
    ]);
    expect(rows[0][5]).toBe(-40);
    expect(rows[1][5]).toBe(40);
  });
});

describe("the ledger still stores what the vendor's file said", () => {
  it("accepts a formula-looking description on import, unchanged", () => {
    // Unaffected by A59 and still the right behaviour: the ledger's job is to
    // say what the vendor's file said, and /expenses has to keep showing it.
    const parsed = ImportTransactionRowSchema.safeParse({
      amount: 1200,
      category: "Software",
      description: "=1+1",
      date: "2026-09-12",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.description).toBe("=1+1");
  });
});
