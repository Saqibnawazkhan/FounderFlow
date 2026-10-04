/**
 * Neutralising customer text on its way into a DELIMITED spreadsheet format.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS MODULE HAS NO CALLER, DELIBERATELY. Do not wire it back into the   │
 * │ .xlsx export — that was transactions-ledger-009, and A59 removed it.    │
 * │ The one place it belongs is a genuine CSV/TSV export, which this app    │
 * │ does not have yet. See "WHEN TO WIRE THIS IN" at the bottom.            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT THE HAZARD ACTUALLY IS. /reports builds a workbook out of values this
 * app accepts as free text and never inspects: a transaction's `description`
 * (bounded to 500 characters by lib/schemas/transaction.ts and nothing else),
 * the denormalised `addedByName`, `Company.name`, and a contributor's name and
 * email. The description in particular can arrive from a CSV a VENDOR wrote —
 * `parseCSV` in lib/transactions/csv.ts reads fields, it does not judge them —
 * so `=cmd|' /c calc'!A1` is stored verbatim and shipped verbatim into the file
 * an admin then circulates inside their own company as a financial report. In a
 * format that evaluates expressions, that is code execution on a finance team's
 * machines.
 *
 * WHY THE .xlsx IS NOT THAT FORMAT. Measured, not reasoned — this is the whole
 * of A59. `XLSX.utils.aoa_to_sheet([["=1+1"]])` yields `{ t: "s", v: "=1+1" }`:
 * a string cell with no `f` attribute. Written and read back through a real
 * `XLSX.write` / `XLSX.read` round trip it is unchanged, and the bytes SheetJS
 * emits are `<c r="A1" t="str"><v>=1+1</v></c>` with no `<f>` element anywhere
 * in the sheet. An OOXML cell with no `<f>` child has no expression to
 * evaluate, so Excel displays the text. The .xlsx was already inert, and
 * applying this module to it prevented nothing.
 *
 * WHAT APPLYING IT TO THE .xlsx DID COST. `-` and `+` lead ordinary accounting
 * prose: "-50% vendor credit" and "+1 seat add-on" are routine descriptions,
 * and they reached the spreadsheet as "'-50% vendor credit" and
 * "'+1 seat add-on". The apostrophe is genuinely visible, because it goes into
 * the cell VALUE — this SheetJS build (xlsx 0.18.5) only PARSES Excel's
 * `quotePrefix` style flag (node_modules/xlsx/xlsx.js:10398, `parse_cellXfs`)
 * and has no write path for it, so a cell cannot be marked "this is text"
 * without spending a character the customer never typed. It also broke rep-006,
 * which exists because two files from two adjacent download buttons disagreeing
 * about the same row is what an auditor notices: the .xlsx said
 * "'-50% vendor credit" where the PDF said "-50% vendor credit".
 *
 * WHY A PREFIX RATHER THAN REJECTION OR STRIPPING, for the format where it does
 * belong. The ledger's job is to say what the vendor's file said, and /expenses
 * has to keep showing it. Refusing the row would lose a real expense over a
 * punctuation mark; rewriting the stored value would put a character on screen
 * that the customer never typed, forever. So nothing is done on the way IN —
 * `ImportTransactionRowSchema` still accepts the value unchanged — and the
 * marker belongs only at the moment the text becomes delimited content.
 *
 * WHY A PDF WOULD NEVER BE ROUTED THROUGH THIS EITHER. jsPDF draws glyphs; a
 * PDF has no evaluator. A marker there would alter the customer's own words in
 * the artefact this product sells as investor-ready, with nothing gained.
 *
 * WHEN TO WIRE THIS IN. Any of these, and only these:
 *
 *   - A real `.csv` or `.tsv` download is added anywhere. Excel evaluates a
 *     leading `=`, `+`, `-` or `@` in a CSV cell, and TAB/CR can start a new
 *     cell or row. This is the case the module was really written for.
 *   - `XLSX.writeFile` on /reports is given a non-`.xlsx` filename. SheetJS
 *     picks its writer from the extension, so that single edit turns the stored
 *     rows live with no other change.
 *   - A SheetJS upgrade, a different export library, or a cell-typing option
 *     starts emitting these cells as formulas.
 *
 * The first two are a deliberate act by whoever adds them. The third is not, so
 * it is pinned: tests/app/reports/export-formula-injection.test.ts measures the
 * round trip and the emitted XML, and asserts the export keeps writing `.xlsx`
 * through `aoa_to_sheet`. If that file goes red, this module is the fix, and
 * tests/lib/reports/spreadsheet-safe.test.ts says it still works.
 */

/**
 * The leads a spreadsheet may treat as the start of an expression.
 *
 * `=` is a formula everywhere. `+`, `-` and `@` are the Lotus-compatibility
 * prefixes Excel still honours (`+1+1` evaluates; `@SUM(...)` resolves). TAB and
 * CR are here for the delimited case rather than for a stored value — every
 * write path runs `z.string().trim()` first, so neither can lead a stored
 * description today — because this is an output boundary and it should not
 * depend on an input rule enforced three modules away.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * The marker. A leading apostrophe is the convention spreadsheets themselves
 * use for "this is text", so a reader who sees it in a cell knows what it means
 * without being told.
 */
const TEXT_MARKER = "'";

/**
 * One cell's text, safe to write into a delimited spreadsheet. Deliberately NOT
 * exported: `spreadsheetSafeRows` is the single entry point, and a second
 * exported variant would be one more thing to find a caller for.
 *
 * Idempotent: the marker is not itself a formula lead, so re-guarding an
 * already-guarded value is a no-op. That is what would let the rule be applied
 * uniformly at every sheet without tracking which rows have been through it.
 */
function spreadsheetSafeText(value: string): string {
  return FORMULA_LEAD.test(value) ? TEXT_MARKER + value : value;
}

/** A cell as this app's exporters build one: text, or a figure to be summed. */
type SheetCell = string | number;

/**
 * Every STRING cell in a sheet's rows, guarded; numbers pass through untouched
 * so the Amount and Net Flow columns stay summable.
 *
 * Takes a whole sheet's rows rather than a chosen list of fields, because the
 * fields that carry the hazard are spread over three of /reports' four sheets —
 * transactions-ledger-009 named only `description`, and `addedByName`,
 * `Company.name` and a contributor's name and email sit beside it under the same
 * absence of any character policy. A per-field guard is a judgement that would
 * have to be repeated correctly for every column a later edit adds.
 */
export function spreadsheetSafeRows(rows: readonly SheetCell[][]): SheetCell[][] {
  return rows.map((row) =>
    row.map((cell) => (typeof cell === "string" ? spreadsheetSafeText(cell) : cell))
  );
}
