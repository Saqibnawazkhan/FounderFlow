/**
 * Spotting an imported row the ledger already holds (transactions-ledger-008).
 *
 * ## What was wrong
 *
 * `bulkImportTransactionsAction` handed its rows straight to `createMany`, and
 * nothing anywhere said "you already have these". Postgres could not catch it
 * either: `Transaction`'s only unique key is `@@unique([ruleId, date])`
 * (prisma/schema.prisma:435), and a composite unique treats rows as distinct
 * whenever any column is NULL — every imported row has `ruleId IS NULL`, so all
 * of them sit outside it. There is no unique index on the money fields and no
 * import-batch column.
 *
 * So importing the same CSV twice doubled the ledger in silence: doubled burn,
 * doubled revenue, doubled budget spend, doubled runway denominator, with
 * nothing on screen marking the copies and no remedy but deleting rows by hand
 * one at a time. The natural trigger is not carelessness — it is a retry after
 * an import that looked like it failed.
 *
 * ## What counts as "the same row"
 *
 * The MONEY IDENTITY of a ledger line: its type, its UTC day, its amount at the
 * stored scale, its category and its description. Deliberately NOT part of the
 * key:
 *
 *   • `projectId`. A re-import tagged to a different project is still the same
 *     spend, and including the tag would let the same file land twice simply
 *     because the picker moved. The cost is that genuinely splitting one charge
 *     across two projects gets flagged — which is recoverable, because flagging
 *     is not refusing (see below).
 *   • `ruleId`. A rent charge the recurring materializer already minted and the
 *     same charge in a bank export ARE the same money, so that pair must be
 *     caught, not excused.
 *   • `addedBy`, `createdAt`, the row id. Properties of the writing, not of the
 *     transaction.
 *
 * ## Why the UTC day, and why one day either side of it
 *
 * `Transaction.date` is a date-only value that readers bucket by UTC day
 * (money-007, `formatUtcDay` — the same reducer every ledger reader buckets
 * with), but it is not always STORED at UTC midnight. Rows written before
 * `lib/transactions/ledger-date.ts` landed kept whatever `new Date(cell)`
 * produced, which is LOCAL midnight for a non-ISO cell — and for an ISO cell
 * carrying a clock time, which is what bank exports emit. Where that lands
 * depends on the SIGN of the writer's UTC offset, and the two signs are not the
 * same problem:
 *
 *   • west of UTC (UTC-5, this suite's own TZ pin): local midnight is 05:00Z on
 *     the SAME UTC day. Reducing to the UTC day catches it where comparing
 *     instants would not.
 *   • east of UTC (UTC+5 — Karachi, this product's home market): local midnight
 *     is 19:00Z on the day BEFORE. The stored row's UTC day is not the day the
 *     customer meant, so the day reduction does NOT catch it on its own. This
 *     file asserted that it did until a tester did the arithmetic; the claim
 *     was false for the entire population most likely to hit the finding.
 *
 * So a STORED row is compared under every day it could have been written for:
 * its own UTC day always, plus the following day when its time-of-day is what an
 * east-of-UTC local midnight looks like — see `storedRowCandidateDays`, and
 * `importDateWindow` for the matching reach in the lookup. A row stored at
 * exactly UTC midnight gets one day and one only, so the widening touches
 * legacy rows and never post-fix ones: a real second charge on the next day
 * with the same amount, category and memo still imports.
 *
 * ## What this still does not catch
 *
 * Stated plainly, because the overstatement it replaces was itself the defect.
 * A pre-003 row whose cell was numeric and day-first ("02/06/2026") was stored
 * with its month and day TRANSPOSED — 5 February, not 2 June — and no reduction
 * of a date can match a date that is four months away. Re-importing that file
 * still doubles those rows. Catching it would need a date-free comparison,
 * which flags every recurring charge of the same amount and memo, so it is a
 * decision for the owner rather than a line of code here.
 *
 * ## Nothing is deleted or refused here
 *
 * This module only PARTITIONS. The caller withholds the duplicates, reports
 * them, and offers "import anyway" — because two identical rows in one bank
 * export can be two real identical charges, and silently dropping a real
 * transaction is the same class of defect as silently doubling one.
 */

import { formatUtcDay } from "@/lib/utils";

/**
 * NUL. Postgres `text` cannot hold it, so no cell value can contain the
 * separator and no two different rows can collide by field boundary — which a
 * `"|"` join genuinely can, because a description may contain one.
 */
const FIELD_SEP = "\u0000";

/** The fields that decide whether two ledger lines are the same money. */
export type LedgerRowIdentity = {
  type: string;
  date: string | Date;
  /**
   * The amount as a fixed-2 decimal STRING — `25000` and `25000.00` and
   * `Prisma.Decimal("25000")` all have to reduce to one key, so the caller
   * passes `amount.toFixed(2)` whether it holds a JS number or a Decimal. 2 is
   * the column's own scale (`@db.Decimal(12, 2)`), and the import schema
   * already refuses anything finer, so nothing is lost in the reduction.
   */
  amount: string;
  category: string;
  description: string;
};

/**
 * One comparable key for a ledger line, under the UTC day of the date it is
 * given. Case and runs of whitespace are normalised out of the free-text
 * fields: a spreadsheet round-trip that re-cased a category or collapsed a
 * double space has not produced a second transaction.
 *
 * For a row already IN the table, call `storedLedgerRowKeys` instead — a stored
 * instant does not always name the day it was written for.
 */
export function ledgerRowKey(row: LedgerRowIdentity): string {
  return [
    row.type.trim().toLowerCase(),
    formatUtcDay(row.date),
    row.amount,
    row.category.trim().toLowerCase(),
    row.description.trim().replace(/\s+/g, " ").toLowerCase(),
  ].join(FIELD_SEP);
}

/** One row as the importer submits it, before it becomes a `Transaction`. */
export type ImportCandidateRow = {
  amount: number;
  category: string;
  description: string;
  date: string;
};

/**
 * Split a batch into the rows that are new and the rows that are not.
 *
 * `existingKeys` are the keys of the live ledger rows that could collide — the
 * caller reads them for the batch's own date window (see `importDateWindow`).
 *
 * A row also counts as a duplicate of an EARLIER ROW IN THE SAME BATCH, which
 * is the one case no database lookup can see: two byte-identical lines in one
 * file both inserted, and after that first import each of them makes the other
 * look legitimate. The first occurrence is kept; only the repeat is withheld.
 *
 * Order is preserved in both halves, so the caller can report the withheld rows
 * back to the customer in the order they appear in their file.
 */
export function splitDuplicateImportRows<T extends ImportCandidateRow>(
  type: string,
  rows: T[],
  existingKeys: string[]
): { fresh: T[]; duplicates: T[] } {
  // A copy, never the caller's own set: the in-batch pass below adds to it.
  const seen = new Set<string>(existingKeys);
  const fresh: T[] = [];
  const duplicates: T[] = [];

  for (const row of rows) {
    const key = ledgerRowKey({
      type,
      date: row.date,
      amount: row.amount.toFixed(2),
      category: row.category,
      description: row.description,
    });
    if (seen.has(key)) {
      duplicates.push(row);
      continue;
    }
    seen.add(key);
    fresh.push(row);
  }

  return { fresh, duplicates };
}

/** `YYYY-MM-DD` at UTC midnight, built without V8's string-date parser's help. */
function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Every zone offset in current use is a whole number of 15 minutes, and the
 * furthest east is UTC+14 (Kiritimati). Together they say which stored instants
 * could be a LOCAL MIDNIGHT written east of UTC: offset +o puts midnight at
 * 24:00−o, so the band is 10:00Z to 23:45Z on a 15-minute mark. A row at
 * 14:32:07Z is some other kind of timestamp and gets no second day.
 */
const MAX_EAST_OFFSET_MINUTES = 14 * 60;
const ZONE_OFFSET_STEP_MINUTES = 15;

/**
 * The UTC days a row ALREADY IN THE TABLE could have been written for: one, or
 * two when its stored instant is indistinguishable from a local midnight east
 * of UTC (`2026-05-31T19:00:00.000Z` is both 31 May and the way UTC+5 stored
 * 1 June). Both are offered because nothing in the row records which, and
 * `Transaction` carries no writer timezone to ask.
 *
 * Exactly-midnight rows — everything written since `ledger-date.ts` landed, and
 * every manually added row — get their own day and nothing else, which is what
 * keeps the second day from becoming a false duplicate on live data.
 */
export function storedRowCandidateDays(date: string | Date): string[] {
  const at = new Date(date);
  const day = formatUtcDay(at);
  const minutesIntoDay = (at.getTime() - utcDayStart(day).getTime()) / 60_000;
  if (
    minutesIntoDay <= 0 ||
    !Number.isInteger(minutesIntoDay) ||
    minutesIntoDay % ZONE_OFFSET_STEP_MINUTES !== 0 ||
    MINUTES_PER_DAY - minutesIntoDay > MAX_EAST_OFFSET_MINUTES
  ) {
    return [day];
  }
  return [day, formatUtcDay(new Date(at.getTime() + ONE_DAY_MS))];
}

/**
 * The keys a stored ledger row has to be compared under — one per candidate
 * day. This, not `ledgerRowKey`, is what the caller builds `existingKeys` from.
 */
export function storedLedgerRowKeys(row: LedgerRowIdentity): string[] {
  return storedRowCandidateDays(row.date).map((day) => ledgerRowKey({ ...row, date: day }));
}

/**
 * The half-open `[gte, lt)` instant range covering every instant at which a row
 * for one of the batch's UTC days could be stored.
 *
 * This is what bounds the duplicate lookup: a 12-row import must not read the
 * whole ledger. It reaches one day either side of the batch's own UTC midnights,
 * because a pre-003 row for day D does not sit at D's midnight (see the module
 * header): west of UTC it is later the SAME day, so a `lte maxDay` bound would
 * miss a 05:00Z row on the batch's last day — and east of UTC it is on D−1, so
 * a `gte minDay` bound excluded it outright and the duplicate could not be seen
 * at all.
 *
 * `null` for an empty batch, so the caller skips the query rather than
 * constructing a range from `Infinity`.
 */
export function importDateWindow(rows: ImportCandidateRow[]): { gte: Date; lt: Date } | null {
  if (rows.length === 0) return null;
  // ISO day strings sort lexicographically, which is why min/max needs no Date.
  let min = formatUtcDay(rows[0].date);
  let max = min;
  for (const row of rows) {
    const day = formatUtcDay(row.date);
    if (day < min) min = day;
    if (day > max) max = day;
  }
  return {
    gte: new Date(utcDayStart(min).getTime() - ONE_DAY_MS),
    lt: new Date(utcDayStart(max).getTime() + ONE_DAY_MS),
  };
}
