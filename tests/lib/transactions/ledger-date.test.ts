/**
 * `lib/transactions/ledger-date.ts` — the decision the CSV importer used to make
 * with `new Date(rawDate)` (transactions-ledger-003).
 *
 * The user-visible contract lives in
 * `tests/components/import-modal-date-locale.test.tsx`: that file mounts the
 * modal, so it is the one that can see the preview and the payload agree. This
 * file covers what the parser must get right cell by cell, where a component
 * test would need one CSV per case.
 *
 * Two invariants run through all of it:
 *
 *   1. EVERY accepted value is UTC midnight. `Transaction.date` is a date-only
 *      value and every reader buckets in UTC (money-007); the old code's
 *      `new Date(cell)` was LOCAL, so at UTC+5 — Karachi — a row dated the 1st
 *      stored the previous month. Nothing here touches V8's string-date parser,
 *      so none of these assertions depend on the suite's TZ pin.
 *   2. A shape that is not read is REFUSED, never approximated. Same posture as
 *      `parseMoneyInput` (money-009).
 */

import { describe, it, expect } from "vitest";
import {
  readLedgerDate,
  detectLedgerDateOrder,
  resolveLedgerDate,
  type LedgerDateOrder,
  type LedgerDateReading,
} from "@/lib/transactions/ledger-date";

/** Read one cell the way the importer does, with a known column order. */
function read(raw: string, order: LedgerDateOrder | null = null) {
  return resolveLedgerDate(readLedgerDate(raw), order);
}

/** The ISO day of an accepted cell, asserting UTC midnight on the way past. */
function day(raw: string, order: LedgerDateOrder | null = null): string {
  const result = read(raw, order);
  if (!result.ok) throw new Error(`expected "${raw}" to be read, got ${result.reason}`);
  expect(result.iso, `"${raw}" was not stored at UTC midnight`).toMatch(/T00:00:00\.000Z$/);
  return result.iso.slice(0, 10);
}

function reason(raw: string, order: LedgerDateOrder | null = null): string {
  const result = read(raw, order);
  if (result.ok) throw new Error(`expected "${raw}" to be refused, got ${result.iso}`);
  return result.reason;
}

describe("readLedgerDate — year-first cells need no help from the column", () => {
  const accepted: [string, string][] = [
    ["2026-06-01", "2026-06-01"],
    ["2026/06/01", "2026-06-01"],
    ["2026.06.01", "2026-06-01"],
    ["2026-6-1", "2026-06-01"], // unpadded, as Sheets exports
    ["  2026-06-01  ", "2026-06-01"], // a padded cell
  ];
  it.each(accepted)("reads %s as %s", (raw, iso) => {
    expect(day(raw)).toBe(iso);
  });

  it.each([
    ["2026-06-01 00:00:00", "2026-06-01"],
    ["2026-06-01T14:30:00", "2026-06-01"],
  ])("keeps the calendar day of %s and drops the clock", (raw, iso) => {
    // The ledger column is date-only. The old code read these as LOCAL midnight,
    // which is how the stored UTC day drifted off the day on screen.
    expect(day(raw)).toBe(iso);
  });
});

describe("readLedgerDate — a named month cannot be transposed", () => {
  it.each([
    ["2 June 2026", "2026-06-02"],
    ["June 2, 2026", "2026-06-02"],
    ["02-Jun-2026", "2026-06-02"],
    ["2 JUNE 2026", "2026-06-02"],
    ["3 Sept 2026", "2026-09-03"],
  ])("reads %s as %s without asking the column", (raw, iso) => {
    // These stay readable because dropping them would be a regression: today's
    // `new Date` handles them, just one day early east of UTC.
    expect(day(raw)).toBe(iso);
  });

  it("refuses a word that is not a month rather than reaching for new Date", () => {
    expect(reason("2 Junk 2026")).toBe("unreadable");
  });

  it("refuses a named month with an impossible day", () => {
    expect(reason("31 February 2026")).toBe("impossible");
  });
});

describe("readLedgerDate — numeric day/month is a property of the COLUMN", () => {
  it("takes the only real reading when the cell settles itself", () => {
    // There is no month 25, so this cell is day-first no matter what is passed
    // as the column order — it is the evidence, not a follower of it.
    expect(day("25/06/2026")).toBe("2026-06-25");
    expect(day("25/06/2026", "monthFirst")).toBe("2026-06-25");
    // And the mirror image.
    expect(day("06/25/2026")).toBe("2026-06-25");
    expect(day("06/25/2026", "dayFirst")).toBe("2026-06-25");
  });

  it("refuses an ambiguous cell when the column never said, naming both dates", () => {
    const result = read("02/06/2026", null);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.dayFirst.slice(0, 10)).toBe("2026-06-02");
    expect(result.monthFirst.slice(0, 10)).toBe("2026-02-06");
  });

  it("resolves an ambiguous cell once the column has said", () => {
    expect(day("02/06/2026", "dayFirst")).toBe("2026-06-02");
    expect(day("02/06/2026", "monthFirst")).toBe("2026-02-06");
  });

  it("reads dot and dash separators the same way as slashes", () => {
    expect(day("01.06.2026", "dayFirst")).toBe("2026-06-01");
    expect(day("01-06-2026", "dayFirst")).toBe("2026-06-01");
    expect(day("25.06.2026")).toBe("2026-06-25");
  });

  it("refuses a cell whose separators disagree", () => {
    expect(reason("2026-06.01")).toBe("unreadable");
    expect(reason("01/06-2026")).toBe("unreadable");
  });

  it("refuses a cell that is no date under either reading", () => {
    expect(reason("31/02/2026", "dayFirst")).toBe("impossible");
    expect(reason("13/13/2026")).toBe("impossible");
  });
});

describe("readLedgerDate — shapes that are refused rather than guessed", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    // Two guesses stacked: the century AND the day/month order.
    ["01/06/26", "unreadable"],
    // A ledger row needs a day; `new Date("2026-06")` invented the 1st.
    ["2026-06", "unreadable"],
    ["20260601", "unreadable"],
    ["last Tuesday", "unreadable"],
    ["2026-06-01-02", "unreadable"],
  ])("refuses %s as %s", (raw, expected) => {
    expect(reason(raw)).toBe(expected);
  });
});

describe("detectLedgerDateOrder — what the whole column proves", () => {
  function orderOf(cells: string[]): LedgerDateOrder | null {
    const readings: LedgerDateReading[] = cells.map(readLedgerDate);
    return detectLedgerDateOrder(readings);
  }

  it("is day-first when one cell has a day above 12", () => {
    // The real case: an Excel export from a DD/MM locale. One such cell is
    // enough, and it is why the other rows no longer have to be guessed.
    expect(orderOf(["02/06/2026", "25/06/2026", "03/07/2026"])).toBe("dayFirst");
  });

  it("is month-first when one cell has a second component above 12", () => {
    expect(orderOf(["02/06/2026", "06/25/2026"])).toBe("monthFirst");
  });

  it("says nothing when every day is 12 or less", () => {
    // Nothing in the file rules out either reading, so the cells are refused.
    expect(orderOf(["02/06/2026", "03/07/2026", "01/12/2026"])).toBeNull();
  });

  it("says nothing when the file contradicts itself", () => {
    // Both orders present. No spreadsheet writes this, and resolving it by
    // majority vote would silently transpose whichever side lost.
    expect(orderOf(["25/06/2026", "06/25/2026"])).toBeNull();
  });

  it("ignores year-first and named-month cells, which carry no order evidence", () => {
    expect(orderOf(["2026-06-25", "2 June 2026", "", "nonsense"])).toBeNull();
  });
});
