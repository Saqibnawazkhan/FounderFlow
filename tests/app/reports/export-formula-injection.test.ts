/**
 * transactions-ledger-009 — a description a vendor controls must not become
 * executable content in a report a colleague downloads.
 *
 * WHAT WENT WRONG. `parseCSV` (lib/transactions/csv.ts) does no content
 * inspection, and nothing downstream of it does either: the importer validates
 * amount, date and category, and `ImportTransactionRowSchema` bounds the
 * description to 500 characters with no character policy. So `=cmd|' /c calc'!A1`
 * is stored verbatim in `Transaction.description` and handed verbatim to
 * `XLSX.utils.aoa_to_sheet` for the Transactions sheet of the .xlsx that
 * /reports hands an admin to circulate as a financial report.
 *
 * It was never only the imported description. `Transaction.addedByName`,
 * `Company.name` and a contributor's name and email all land in the same
 * workbook, and all four are free text with no character policy at all
 * (lib/schemas/profile.ts, lib/schemas/company.ts) — so the Team and Summary
 * sheets carry the same payload class as the Transactions sheet. The guard is
 * therefore stated against the SHEET boundary rather than against one field.
 *
 * WHY IT IS AN OUTPUT RULE, NOT AN INPUT RULE. The ledger's job is to say what
 * the vendor's file said. Prefixing on the way in would store a character the
 * customer never typed and show it on /expenses forever, so the last case below
 * pins that the import schema still ACCEPTS a formula-looking description
 * untouched. Neutralising happens where the text becomes spreadsheet content.
 *
 * WHAT THE GUARD COSTS, STATED PLAINLY. The protection it buys is LATENT, not
 * present: an .xlsx carries this text as an inline/shared string, which Excel
 * displays and never evaluates, so against today's writer the guard changes no
 * outcome an attacker cares about. What it defends is the next edit — a `.csv`
 * extension handed to `XLSX.writeFile` (SheetJS picks the format from the name),
 * a different export library, or a cell-typing option.
 *
 * The cost, by contrast, is paid TODAY and by innocent rows. `-` and `+` lead
 * ordinary accounting prose, not just payloads: "-50% vendor credit" and
 * "+1 seat add-on" are routine descriptions, and they now appear in the
 * spreadsheet with a literal leading apostrophe while the PDF prints them clean.
 * The apostrophe really is visible — it goes into the cell VALUE, and this
 * SheetJS build only ever PARSES Excel's `quotePrefix` style flag
 * (node_modules/xlsx/xlsx.js:10398, `parse_cellXfs`), with no write path for it,
 * so there is no way to mark a cell "this is text" without spending a character.
 * The "ordinary prose pays this too" block below pins that cost deliberately,
 * so it is a named fact here rather than a surprise in a customer's download.
 *
 * WHY THE PDF IS DELIBERATELY NOT GUARDED, and what that does to rep-006.
 * jsPDF draws glyphs; a PDF has no evaluator, so a marker there would alter the
 * customer's text in the artefact this product sells as investor-ready for no
 * benefit at all.
 *
 * That does leave the two download buttons disagreeing by one character for
 * formula-leading AND prose-leading values, which narrows rep-006's invariant.
 * rep-006's own strict-equality case in reports-export-fidelity.test.ts still
 * passes untouched, because an ordinary `=`-free, `-`-free description comes back
 * byte for byte — and that file now carries a pointer here so a reader of it
 * knows the carve-out exists. For the class of value where the two files differ,
 * the relationship is pinned below instead: the spreadsheet cell must still END
 * WITH the PDF cell, and may be at most one character longer — so a truncation
 * cannot return on either side under cover of this guard.
 *
 * Run as: npx cross-env TZ=America/Bogota npx vitest run tests/app/reports/export-formula-injection.test.ts
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TXN_DESCRIPTION_COL,
  excelTransactionRows,
  pdfTransactionRows,
} from "@/app/(app)/reports/reports-client";
import { ImportTransactionRowSchema } from "@/lib/schemas/transaction";
import type { Transaction } from "@/lib/types";

const money = (amount: number) => `PKR ${amount.toFixed(2)}`;

/**
 * The contract's own copy of the dangerous set, written out here rather than
 * imported from the code under test: a test that borrows the implementation's
 * regex agrees with it by construction and proves nothing.
 *
 * `=` is a formula in every spreadsheet; `+`, `-` and `@` are the Lotus-compat
 * prefixes Excel still honours; TAB and CR are the two characters that let a
 * payload start a new cell or row in a delimited context. Those last two cannot
 * lead a STORED description today — every write path runs `z.string().trim()`
 * first — so their cases below guard the output boundary rather than a reachable
 * payload, which is the point: the boundary should not depend on an input rule
 * enforced three modules away.
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

describe("the Transactions sheet neutralises formula-leading text", () => {
  PAYLOADS.forEach((payload) => {
    it(`does not start the description cell with the lead of ${JSON.stringify(payload)}`, () => {
      const [row] = excelTransactionRows([txn({ description: payload })]);
      expect(typeof row[TXN_DESCRIPTION_COL]).toBe("string");
      expect(row[TXN_DESCRIPTION_COL] as string).not.toMatch(FORMULA_LEAD);
    });
  });

  it("neutralises the denormalised author name too, which has no character policy", () => {
    // lib/schemas/profile.ts bounds `name` to 80 characters and nothing else, so
    // a member can name themselves a formula and appear in every export.
    const [row] = excelTransactionRows([txn({ addedByName: "=1+1" })]);
    expect(row[4] as string).not.toMatch(FORMULA_LEAD);
  });

  it("keeps the whole text — the guard is a prefix, never a truncation", () => {
    const payload = "=1+1";
    const [row] = excelTransactionRows([txn({ description: payload })]);
    expect(row[TXN_DESCRIPTION_COL] as string).toContain(payload);
  });

  it("leaves an ordinary description byte-for-byte alone", () => {
    const plain = "Cloud hosting renewal for the analytics stack";
    const [row] = excelTransactionRows([txn({ description: plain })]);
    expect(row[TXN_DESCRIPTION_COL]).toBe(plain);
  });

  it("leaves the amount a signed NUMBER, so the guard cannot break the sum", () => {
    const rows = excelTransactionRows([
      txn({ type: "expense", amount: 40, description: "=1+1" }),
      txn({ type: "income", amount: 40, description: "-1" }),
    ]);
    expect(rows[0][5]).toBe(-40);
    expect(rows[1][5]).toBe(40);
  });
});

/**
 * ORDINARY PROSE PAYS THIS TOO — the part the first report of this fix did not
 * put on the table, and the reason its summary ("no behaviour visible to a
 * customer changes today") was wrong.
 *
 * A leading `-` or `+` is normal in expense wording. Every one of these
 * descriptions is something a finance team actually types, and every one of them
 * now reaches the spreadsheet one character longer than the customer wrote it.
 * None of them is dangerous in any format.
 *
 * These cases are a deliberate, pinned record of the trade rather than an
 * endorsement of it. THIS IS THE BLOCK THAT FLIPS if the owner decides the two
 * downloads must stay byte-identical: route `pdfTransactionRows` through
 * `spreadsheetSafeRows` as well and both expectations below become the same
 * string, or narrow `FORMULA_LEAD` to `=`/`@`/TAB/CR and the marker stops
 * appearing on prose at all.
 */
describe("ordinary accounting prose pays for the guard as well", () => {
  const PROSE = ["-50% vendor credit", "+1 seat add-on", "-200 PKR goodwill adjustment"];

  PROSE.forEach((prose) => {
    it(`spends a visible apostrophe on ${JSON.stringify(prose)} in the spreadsheet`, () => {
      const [row] = excelTransactionRows([txn({ description: prose })]);
      // Asserted as the exact string, not merely "is marked": the apostrophe is
      // part of the cell's value and therefore renders in Excel. If a future
      // SheetJS build grows a `quotePrefix` write path, this is the assertion
      // that should be rewritten to check the style flag instead.
      expect(row[TXN_DESCRIPTION_COL]).toBe(`'${prose}`);
    });

    it(`prints ${JSON.stringify(prose)} clean in the PDF, so the two files differ`, () => {
      const [row] = pdfTransactionRows([txn({ description: prose })], money);
      expect(row[TXN_DESCRIPTION_COL]).toBe(prose);
    });
  });
});

describe("the PDF still prints what the customer typed (rep-006 held exactly)", () => {
  it("does not add a marker character to the inert artefact", () => {
    const payload = "=1+1";
    const [row] = pdfTransactionRows([txn({ description: payload })], money);
    expect(row[TXN_DESCRIPTION_COL]).toBe(payload);
  });

  it("differs from the spreadsheet by at most the one guard character", () => {
    const txns = PAYLOADS.map((d, i) => txn({ id: `t${i}`, description: d })).concat([
      txn({ id: "plain", description: "Office rent" }),
      txn({ id: "long", description: "x".repeat(500) }),
    ]);
    const pdf = pdfTransactionRows(txns, money);
    const xls = excelTransactionRows(txns);
    expect(pdf.length).toBe(xls.length);
    pdf.forEach((row, i) => {
      const pdfCell = row[TXN_DESCRIPTION_COL];
      const xlsCell = xls[i][TXN_DESCRIPTION_COL] as string;
      // Ends with, not equals: this is what stops a truncation returning on
      // either side while the formula guard is used as the excuse. It is also
      // the assertion that returns to strict equality if the owner chooses
      // byte-identical artefacts — see the prose block above.
      expect(xlsCell.endsWith(pdfCell)).toBe(true);
      expect(xlsCell.length - pdfCell.length).toBeLessThanOrEqual(1);
    });
  });
});

describe("no sheet in the workbook is built from unguarded rows", () => {
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
   * `const XLSX = await import("xlsx")` (reports-client.tsx:819). There is no
   * top-level or destructured import, so a real call site CANNOT spell a builder
   * without the namespace, while prose always does.
   */
  const BUILDER = (name: string) => new RegExp(`XLSX\\.utils\\.${name}\\(\\s*`, "g");

  it("routes every aoa_to_sheet argument through the guard", () => {
    // The Summary, Team and Monthly sheets are built inline inside `exportExcel`
    // from `company.name`, a contributor's name and their email, none of which
    // is reachable from a unit test without extracting three more functions — so
    // this is asserted statically. Counting rather than matching one shape,
    // because two of the four call sites pass an array literal and two pass a
    // named variable; a fifth sheet added later in either style, without the
    // guard, moves the two numbers apart.
    const calls = CODE.match(BUILDER("aoa_to_sheet")) ?? [];
    const guarded = CODE.match(/XLSX\.utils\.aoa_to_sheet\(\s*spreadsheetSafeRows\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(guarded.length).toBe(calls.length);
  });

  /**
   * The other door. `aoa_to_sheet` is one of five SheetJS entry points that can
   * put app text into a worksheet, and guarding only the spelling this file
   * happens to use today left the rest wide open: a sheet added with
   * `json_to_sheet` reaches the same workbook completely unguarded and the case
   * above cannot see it.
   *
   * Stated as "none of these appears at all" rather than "each is guarded"
   * because `spreadsheetSafeRows` takes rows and does not fit the object and
   * in-place forms — so if one of these is genuinely wanted later, the guard
   * needs a matching variant, and the author should be made to write it rather
   * than inherit a pass from this file. The failure names the helper.
   */
  it.each(["json_to_sheet", "sheet_add_aoa", "sheet_add_json", "table_to_sheet"])(
    "builds no sheet with XLSX.utils.%s, which the guard cannot cover",
    (name) => {
      expect(CODE.match(BUILDER(name)) ?? []).toEqual([]);
    }
  );
});

describe("the ledger still stores what the vendor's file said", () => {
  it("accepts a formula-looking description on import, unchanged", () => {
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
