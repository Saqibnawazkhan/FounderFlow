/**
 * Neutralising customer text on its way into a spreadsheet
 * (transactions-ledger-009).
 *
 * WHY THIS EXISTS. /reports builds a .xlsx out of values this app accepts as
 * free text and never inspects: a transaction's `description` (bounded to 500
 * characters by lib/schemas/transaction.ts and nothing else), the denormalised
 * `addedByName`, `Company.name`, and a contributor's name and email. The
 * description in particular can arrive from a CSV a VENDOR wrote — `parseCSV`
 * in lib/transactions/csv.ts reads fields, it does not judge them — so
 * `=cmd|' /c calc'!A1` is stored verbatim and shipped verbatim into the
 * workbook an admin then circulates inside their own company as a financial
 * report.
 *
 * Today SheetJS writes a JS string as an inline string, so Excel displays such
 * a cell rather than evaluating it. That is the whole of the containment, and
 * it belongs to a library's default cell typing rather than to anything this
 * codebase does — one change of export format (`XLSX.writeFile` to a `.csv`
 * name), library, or cell-typing option and the same stored row becomes live
 * formula execution on a finance team's machines. This module is that
 * containment written down where it can be tested.
 *
 * WHY A PREFIX RATHER THAN REJECTION OR STRIPPING. The ledger's job is to say
 * what the vendor's file said, and /expenses has to keep showing it. Refusing
 * the row would lose a real expense over a punctuation mark; rewriting the
 * stored value would put a character on screen that the customer never typed,
 * forever. So nothing is done on the way IN — `ImportTransactionRowSchema`
 * still accepts the value unchanged — and the marker is added only at the
 * moment the text becomes spreadsheet content.
 *
 * WHY THE PDF IS NOT ROUTED THROUGH THIS. jsPDF draws glyphs; a PDF has no
 * evaluator. A marker there would alter the customer's own words in the
 * artefact this product sells as investor-ready, with nothing gained.
 *
 * WHAT THIS COSTS, AND WHO PAYS IT. Read this before deciding the guard is
 * free, because the first write-up of it claimed "no behaviour visible to a
 * customer changes today" and that was simply wrong.
 *
 * The benefit is LATENT. Per the paragraph above, Excel does not evaluate an
 * inline string, so against today's writer this module prevents nothing an
 * attacker could currently achieve; what it defends is the next edit to the
 * format, library or cell typing.
 *
 * The cost is PAID NOW, and by innocent rows. `-` and `+` lead ordinary
 * accounting prose: "-50% vendor credit" and "+1 seat add-on" are routine
 * descriptions, and they reach the spreadsheet as "'-50% vendor credit" and
 * "'+1 seat add-on". The apostrophe is genuinely visible, because it goes into
 * the cell VALUE — this SheetJS build (xlsx 0.18.5) only PARSES Excel's
 * `quotePrefix` style flag (node_modules/xlsx/xlsx.js:10398, `parse_cellXfs`)
 * and has no write path for it, so a cell cannot be marked "this is text"
 * without spending a character the customer never typed.
 *
 * That is the standard OWASP mitigation and a defensible trade, but it IS a
 * trade and it is the owner's to confirm. The two reversals are each one line:
 * narrow `FORMULA_LEAD` to `=`/`@`/TAB/CR so prose stops being marked, or drop
 * this module and accept format-change risk.
 *
 * WHAT IT DOES TO rep-006 — the rule that the two download buttons must not
 * describe different ledgers. It NARROWS it, rather than leaving it untouched
 * as this comment previously claimed. Any description leading with `=`, `+`,
 * `-`, `@`, TAB or CR — malicious or not — now differs by one character between
 * the .xlsx and the PDF. rep-006's strict-equality case in
 * tests/app/reports/reports-export-fidelity.test.ts still passes because none
 * of its three fixtures leads with one of those characters, and that file now
 * carries a pointer here so a reader is not misled by its silence. For the
 * values where the two files do differ, the relationship is pinned by
 * tests/app/reports/export-formula-injection.test.ts as "the spreadsheet cell
 * ENDS WITH the PDF cell and is at most one character longer" — so a truncation
 * cannot return on either side under cover of this guard — and the ordinary
 * prose cost has named cases of its own there.
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
 * One cell's text, safe to write into a spreadsheet. Deliberately NOT exported:
 * `spreadsheetSafeRows` is the only boundary this app has, and an exported
 * per-cell variant with no caller is the "shipped, tested, unreachable" shape
 * this repo keeps producing.
 *
 * Idempotent: the marker is not itself a formula lead, so re-guarding an
 * already-guarded value is a no-op, which is what lets the rule be applied
 * uniformly at every sheet without tracking which rows have been through it.
 */
function spreadsheetSafeText(value: string): string {
  return FORMULA_LEAD.test(value) ? TEXT_MARKER + value : value;
}

/** A cell as `XLSX.utils.aoa_to_sheet` receives it from this app. */
type SheetCell = string | number;

/**
 * Every STRING cell in a sheet's rows, guarded; numbers pass through
 * untouched so the Amount and Net Flow columns stay summable in Excel.
 *
 * Applied to a whole sheet's rows rather than to a chosen list of fields,
 * because the fields that carry the hazard are spread over three of the four
 * sheets — the finding named only `description`, and `addedByName`,
 * `Company.name` and a contributor's name and email sit beside it under the same
 * absence of any character policy. A per-field guard is a judgement that would
 * have to be repeated correctly for every column a later edit adds.
 */
export function spreadsheetSafeRows(rows: readonly SheetCell[][]): SheetCell[][] {
  return rows.map((row) =>
    row.map((cell) => (typeof cell === "string" ? spreadsheetSafeText(cell) : cell))
  );
}
