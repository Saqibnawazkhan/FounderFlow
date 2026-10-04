/**
 * Cutting a CSV import into server calls, and the ceilings the dialog states
 * before a file is picked (transactions-ledger-010).
 *
 * ## What was wrong
 *
 * `ImportTransactionsSchema` caps a call at `IMPORT_MAX_ROWS_PER_BATCH` rows and
 * the modal sent every valid row in one call. So a 3,000-row accounting export —
 * the file a new paying customer onboards with — produced ONE zod failure,
 * "Import at most 1000 rows at a time", and zero inserts, after the customer had
 * already picked the file, waited for a preview that rendered one `<tr>` per row
 * with no bound, and pressed Import. The cap was stated nowhere before that
 * moment: not in the dialog, not on the template link, not in the file input's
 * hint.
 *
 * The per-call cap itself is not the defect. `createMany`, the duplicate
 * lookup's `IN` list of the batch's distinct amounts, and the one activity row
 * each call writes all want a bounded batch. The defect was that the only thing
 * in the product that knew about the bound was the server's rejection message.
 *
 * ## Why the chunk size IS the schema's constant
 *
 * A client that chunks at 1,000 while the server caps at 500 is this finding
 * again with the error moved one step earlier — and nothing on screen would say
 * which of the two numbers is wrong. So the default chunk size here is
 * `IMPORT_MAX_ROWS_PER_BATCH` itself, imported, and
 * tests/lib/transactions/import-batches.test.ts runs a full-size batch, and a
 * batch one row larger, through the real `ImportTransactionsSchema`.
 *
 * ## Why there is still a ceiling on the whole file
 *
 * Chunking turns one call into `ceil(rows / size)` calls, and every server
 * action in this app passes through `limiters.write` — 60 writes per minute per
 * user (lib/rate-limit.ts:361). An unbounded file therefore would not fail with
 * a clear message; it would import part of itself and then start answering "Too
 * many requests" somewhere in the middle, which is strictly worse than being
 * refused up front. `IMPORT_MAX_TOTAL_ROWS` is 10 calls, leaving the rest of
 * that minute's budget for the ordinary writes a person makes while an import
 * runs. Raising it is a decision about that limiter, not about this number.
 *
 * `IMPORT_MAX_FILE_BYTES` is the guard in front of the `FileReader`: the row
 * ceiling can only be checked after the text has been read and parsed, and
 * reading a multi-megabyte file into a string is itself the thing that locks the
 * tab up while the customer waits to be told no. At the shape a transaction CSV
 * actually has — four short columns, well under 100 bytes a row — 5 MB is many
 * times the row ceiling, so the row count is the limit that normally bites and
 * the byte count only catches a file that was never a transaction export.
 *
 * `IMPORT_PREVIEW_ROWS` bounds the preview TABLE only. Every row is still
 * parsed, validated and counted — the "N valid / N skipped" badges and the
 * import itself cover the whole file — because a preview that silently stopped
 * checking at row 200 would be a far worse bug than a slow one. What it does
 * NOT do is show a skipped row that lies below the cut; the notice says how many
 * those are, and locating them needs a row-number column the preview has never
 * had.
 */

import { IMPORT_MAX_ROWS_PER_BATCH } from "@/lib/schemas/transaction";

export { IMPORT_MAX_ROWS_PER_BATCH };

/**
 * The most rows one FILE may carry, across all its batches. See the header: this
 * is a statement about `limiters.write`, not about the importer.
 */
export const IMPORT_MAX_TOTAL_ROWS = 10_000;

/** The most bytes the importer will read into memory. A whole number of MB,
 *  because the dialog quotes it in MB. */
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** How many rows the preview table renders. Validation is never truncated. */
export const IMPORT_PREVIEW_ROWS = 200;

/**
 * Split a payload into calls of at most `size` rows, preserving order.
 *
 * Returns no batches at all for an empty payload, so a caller looping over the
 * result never makes an empty call — `ImportTransactionsSchema` refuses one
 * ("Nothing to import") and the modal already handles "no valid rows" before it
 * gets here.
 */
export function chunkImportRows<T>(
  rows: readonly T[],
  size: number = IMPORT_MAX_ROWS_PER_BATCH
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    // A zero or fractional size would loop forever rather than fail, and the
    // only caller passes the schema's own constant — so this can only be a
    // programming mistake, and it should look like one.
    throw new Error(`chunkImportRows: size must be a positive integer, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}
