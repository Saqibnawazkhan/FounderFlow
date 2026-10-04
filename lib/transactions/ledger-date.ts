/**
 * Reading a ledger DATE out of a spreadsheet cell (transactions-ledger-003).
 *
 * The CSV importer used to hand the raw cell to `new Date(rawDate)`. V8's
 * fallback parser is not a date format, it is a guess, and it guesses
 * month-first. Verified readings, all of which the importer reported as VALID:
 *
 *     "02/06/2026"          → 6 February     a DD/MM export loses 10 months
 *     "01.06.2026"          → 6 January      the European dot form, same way
 *     "25/06/2026"          → Invalid Date   refused, because there is no month 25
 *     "2026-06-01 00:00:00" → local midnight so the stored UTC day can shift
 *
 * The first and third together are the expensive part. In a DD/MM/YYYY export —
 * what Excel produces in this product's home market — roughly 61% of rows have a
 * day of 12 or less, and those are precisely the rows that imported with month
 * and day transposed. The other 39% were refused. The customer is shown
 * "61 valid, 39 skipped", repairs the 39, and keeps the 61 wrong ones.
 *
 * The last one is money-007 on this path: `Transaction.date` is a date-only
 * value stored at UTC midnight and every reader buckets in UTC, but V8 reads a
 * cell carrying a clock time as LOCAL, so `toISOString()` moves the instant off
 * midnight and, east of UTC, off the day as well. At UTC+5 — Karachi, this
 * product's primary market — EVERY non-ISO cell stored the previous calendar
 * day, so a row dated the 1st booked into the month before.
 *
 * ## The rule here
 *
 * Same posture as `parseMoneyInput` (lib/format.ts, money-009): a reader that
 * cannot read must refuse, never invent. But a date differs from an amount in
 * one way that matters, and the difference is why this module has three
 * functions instead of one:
 *
 *   an amount cell is ambiguous ON ITS OWN and stays ambiguous — "1.234,56"
 *   says nothing about which locale wrote it, and the rest of the file cannot
 *   help, because each cell might be either.
 *
 *   a date COLUMN resolves itself. A spreadsheet writes one format down the
 *   whole column, so a single "25/06/2026" anywhere in it proves the file is
 *   day-first, and every "02/06/2026" beside it is then 2 June and not a guess.
 *
 * So reading happens in two passes: `readLedgerDate` per cell, which resolves
 * everything it can without the file, then `detectLedgerDateOrder` over the
 * column, then `resolveLedgerDate` to finish the cells that needed the column.
 * When the column never settles the order — every day 12 or less, or the file
 * mixes both orders — the ambiguous cells are REFUSED, with both candidate
 * dates named so the customer can see what the choice was.
 *
 * Everything returned is UTC midnight, built with `Date.UTC`. No value in this
 * module passes through V8's string-date parser.
 */

/** Why a cell could not be read. The wording lives at the call site. */
export type LedgerDateFailure =
  | "empty" // nothing in the cell
  | "unreadable" // not a shape we read at all (a 2-digit year, prose, "2026-06")
  | "ambiguous" // numeric day/month and the column never said which order
  | "impossible"; // the right shape, but not a real date (31/02/2026)

/** Which component a numeric `A/B/YYYY` column puts first. */
export type LedgerDateOrder = "dayFirst" | "monthFirst";

/**
 * What one cell says on its own.
 *
 * `numeric` is the only kind that needs the column: `dayFirst` and `monthFirst`
 * are the two candidate ISO instants, and either is `null` when that reading is
 * not a real date — which is exactly what makes "25/06/2026" EVIDENCE rather
 * than a coin toss.
 */
export type LedgerDateReading =
  | { kind: "fixed"; iso: string }
  | { kind: "numeric"; dayFirst: string | null; monthFirst: string | null }
  | { kind: "bad"; reason: "empty" | "unreadable" | "impossible" };

export type LedgerDateResult =
  | { ok: true; iso: string }
  /** Both candidates are carried so the refusal can name them. */
  | { ok: false; reason: "ambiguous"; dayFirst: string; monthFirst: string }
  | { ok: false; reason: "empty" | "unreadable" | "impossible" };

/**
 * Year first, so the order is stated rather than inferred: 2026-06-01,
 * 2026/6/1, 2026.06.01. A trailing clock time is allowed and IGNORED — the
 * column is date-only, and the calendar day the cell shows in the spreadsheet
 * is the day the customer means. `\2` pins both separators to the same
 * character so "2026-06.01" is not read as a date.
 */
const YEAR_FIRST = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ].*)?$/;

/**
 * Year last: 02/06/2026, 01.06.2026, 25-06-2026, again with an optional clock
 * time. A FOUR-digit year is required on purpose — "01/06/26" would need a
 * guess about the century on top of the guess about the order, and two guesses
 * stacked is how this finding reads now.
 */
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(?:[T ].*)?$/;

/**
 * English month names and the abbreviations spreadsheets emit. A NAMED month
 * cannot be transposed with a day, which is why these need no column evidence.
 * A `Map` rather than an object literal: `.get` returns `number | undefined`,
 * so an unknown token cannot read as a month by accident.
 */
const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

/**
 * `y-m-d` as a UTC-midnight ISO string, or `null` when those numbers are not a
 * real date. The round-trip check is what rejects 31 February: `Date.UTC`
 * happily rolls it forward to 3 March, and a silently rolled date is the shape
 * of defect this whole module exists to stop.
 */
function utcMidnight(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    return null;
  }
  return at.toISOString();
}

/** A cell whose month is spelled out: "2 June 2026", "June 2, 2026", "02-Jun-2026". */
function readNamedMonth(body: string): LedgerDateReading | null {
  // Separators out, so all three word orders reduce to the same three tokens.
  const tokens = body
    .replace(/[,./-]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length !== 3) return null;

  let month: number | undefined;
  let year: number | undefined;
  let day: number | undefined;
  for (const token of tokens) {
    if (/^[A-Za-z]+$/.test(token)) {
      if (month !== undefined) return null; // two month words is not a date
      month = MONTHS.get(token.toLowerCase());
      if (month === undefined) return null; // an unknown word, not a month
    } else if (/^\d{4}$/.test(token)) {
      if (year !== undefined) return null;
      year = Number(token);
    } else if (/^\d{1,2}$/.test(token)) {
      if (day !== undefined) return null;
      day = Number(token);
    } else {
      return null;
    }
  }
  if (month === undefined || year === undefined || day === undefined) return null;

  const iso = utcMidnight(year, month, day);
  return iso === null ? { kind: "bad", reason: "impossible" } : { kind: "fixed", iso };
}

/**
 * Read one date cell as far as it can be read without the rest of the column.
 *
 * Deliberately does NOT return a final answer for a numeric `A/B/YYYY` cell:
 * see the module header for why that is a property of the column and not of the
 * cell. Pair it with `detectLedgerDateOrder` + `resolveLedgerDate`.
 */
export function readLedgerDate(raw: string): LedgerDateReading {
  const body = raw.trim();
  if (body === "") return { kind: "bad", reason: "empty" };

  const yearFirst = YEAR_FIRST.exec(body);
  if (yearFirst) {
    const iso = utcMidnight(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
    return iso === null ? { kind: "bad", reason: "impossible" } : { kind: "fixed", iso };
  }

  const yearLast = YEAR_LAST.exec(body);
  if (yearLast) {
    const a = Number(yearLast[1]);
    const b = Number(yearLast[3]);
    const year = Number(yearLast[4]);
    const dayFirst = utcMidnight(year, b, a);
    const monthFirst = utcMidnight(year, a, b);
    // Neither reading is a real date — "31/02/2026", "13/13/2026". Nothing the
    // column can say would rescue it, so answer now.
    if (dayFirst === null && monthFirst === null) return { kind: "bad", reason: "impossible" };
    return { kind: "numeric", dayFirst, monthFirst };
  }

  const named = readNamedMonth(body);
  if (named) return named;

  return { kind: "bad", reason: "unreadable" };
}

/**
 * Which order a whole date column is written in, or `null` when it does not say.
 *
 * A cell is evidence only when ONE of its two readings is a real date: in
 * "25/06/2026" there is no month 25, so the file is day-first. `null` covers
 * both ways that can fail to settle — no evidence at all (every day 12 or less),
 * and contradictory evidence (a file carrying both orders, which no spreadsheet
 * produces and which must not be resolved by majority vote). Callers refuse the
 * ambiguous cells either way; the distinction would change no outcome.
 */
export function detectLedgerDateOrder(readings: LedgerDateReading[]): LedgerDateOrder | null {
  let sawDayFirst = false;
  let sawMonthFirst = false;
  for (const reading of readings) {
    if (reading.kind !== "numeric") continue;
    if (reading.dayFirst !== null && reading.monthFirst === null) sawDayFirst = true;
    else if (reading.monthFirst !== null && reading.dayFirst === null) sawMonthFirst = true;
  }
  if (sawDayFirst === sawMonthFirst) return null; // none, or both
  return sawDayFirst ? "dayFirst" : "monthFirst";
}

/**
 * Finish one cell, given what the column turned out to say.
 *
 * A numeric cell with exactly one real reading takes it regardless of `order` —
 * that cell IS the evidence, and refusing it because a sibling row disagreed
 * would throw away the only unambiguous rows in a mixed file.
 */
export function resolveLedgerDate(
  reading: LedgerDateReading,
  order: LedgerDateOrder | null
): LedgerDateResult {
  if (reading.kind === "fixed") return { ok: true, iso: reading.iso };
  if (reading.kind === "bad") return { ok: false, reason: reading.reason };

  const { dayFirst, monthFirst } = reading;
  if (dayFirst !== null && monthFirst === null) return { ok: true, iso: dayFirst };
  if (monthFirst !== null && dayFirst === null) return { ok: true, iso: monthFirst };
  // Both readings are real dates, so only the column can choose.
  if (dayFirst === null || monthFirst === null) return { ok: false, reason: "impossible" };
  if (order === "dayFirst") return { ok: true, iso: dayFirst };
  if (order === "monthFirst") return { ok: true, iso: monthFirst };
  return { ok: false, reason: "ambiguous", dayFirst, monthFirst };
}
