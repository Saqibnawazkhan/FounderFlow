/**
 * The one month boundary, and the three places it used to be spelled
 * differently. money-003 / money-007 / rep-003.
 *
 * THE THREE BUGS THIS ENCODES.
 *
 *  1. money-007 (the timezone one). `Transaction.date` is a DATE-ONLY value:
 *     `<input type="date">` hands back "2026-10-01", transaction-form.tsx does
 *     `new Date("2026-10-01").toISOString()`, and the column is TIMESTAMP(3)
 *     — so the row lands at 2026-10-01T00:00:00.000Z. Every SERVER query
 *     buckets it in UTC (`new Date(Date.UTC(y, m, 1))` in lib/queries/budgets.ts,
 *     lib/budgets/check.ts, lib/queries/projects.ts). The CLIENT pages used
 *     date-fns `startOfMonth`/`endOfMonth`, which are LOCAL. In America/Bogota
 *     local start-of-October is 2026-10-01T05:00Z, so that row sat in SEPTEMBER
 *     for /dashboard and /reports and in OCTOBER for /budgets and the project
 *     page. Every negative-UTC-offset customer, every month end.
 *
 *  2. money-003 / rep-003 (the year-agnostic one). /expenses compared
 *     `new Date(t.date).getMonth() === new Date().getMonth()` — month index,
 *     no year — so its "This month" card also counted the same calendar month
 *     of every previous year, and disagreed with /dashboard's identically
 *     labelled card over the same ledger. The error grows every year the
 *     workspace stays alive.
 *
 *  3. The label. Fixing (1) by moving the bucket to UTC without fixing the
 *     LABEL would have produced a second off-by-one: `format(monthStart, "MMM")`
 *     renders a UTC-midnight Date in the viewer's timezone, so the October
 *     bucket prints "Sep" in Bogota. The last case below pins that.
 *
 * WHY THE TZ ASSERTION IS FIRST. Run under TZ=UTC every assertion below is
 * vacuous — local and UTC boundaries coincide and the file passes without
 * testing anything. This repo has already shipped date tests made vacuous
 * exactly that way, which is why `npm test` pins TZ=America/Bogota. So the
 * first test fails loudly rather than letting the rest go quiet:
 *
 *     npx cross-env TZ=America/Bogota vitest run tests/lib/queries/month-boundary.test.ts
 *
 * The source-text guards at the bottom are the same tool
 * tests/lib/db/script-safety.test.ts uses, and for the same reason: the
 * question "does this file still reach for the local-calendar helper" is a
 * question about the text. A value test cannot ask it, because the defect is
 * not a wrong number returned by a function under test — it is a client
 * component picking the wrong helper.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isInUtcMonth,
  startOfUtcMonth,
  utcMonthShortLabel,
  utcMonthWindow,
  utcMonthsAgo,
} from "@/lib/date-range";

/** Mid-October, so "this month" has a real inside and a real outside. */
const NOW = new Date("2026-10-14T12:00:00.000Z");
/** What the date picker stores for "October 1st" — UTC midnight, not local. */
const OCT_1 = new Date("2026-10-01T00:00:00.000Z");

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

/** Strip comments, so a comment that NAMES the banned helper isn't a hit.
 *  Lifted from tests/lib/db/script-safety.test.ts. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

const DASHBOARD = join("app", "(app)", "dashboard", "dashboard-client.tsx");
const EXPENSES = join("app", "(app)", "expenses", "expenses-client.tsx");

describe("the test's own timezone", () => {
  it("is west of UTC, or every case in this file is vacuous", () => {
    // 300 = UTC-5 = America/Bogota, which has no DST so the offset is constant.
    expect(new Date("2026-10-14T12:00:00.000Z").getTimezoneOffset()).toBe(300);
  });
});

describe("startOfUtcMonth / utcMonthWindow (money-007)", () => {
  it("puts a row dated the 1st inside the current month", () => {
    const window = utcMonthWindow(NOW);
    expect(window.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(window.endExclusive.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(OCT_1 >= window.start && OCT_1 < window.endExclusive).toBe(true);
  });

  it("reproduces the bug it replaces: the local boundary excludes that row", () => {
    // Exactly what date-fns `startOfMonth(new Date())` computes — the local
    // calendar's 1st, which in Bogota is 2026-10-01T05:00Z. This assertion is
    // the bug, written down: the row the product stored for "October 1" is
    // NOT >= the local start of October.
    const localStart = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
    expect(OCT_1 >= localStart).toBe(false);
  });

  it("is half-open, so the last instant of the month is in and the next month's 1st is out", () => {
    const window = utcMonthWindow(NOW);
    expect(isInUtcMonth("2026-10-31T23:59:59.999Z", NOW)).toBe(true);
    expect(isInUtcMonth(window.endExclusive, NOW)).toBe(false);
  });

  it("walks backwards across a year boundary", () => {
    expect(startOfUtcMonth(NOW, -5).toISOString()).toBe("2026-05-01T00:00:00.000Z");
    const jan = new Date("2026-01-15T03:00:00.000Z");
    expect(startOfUtcMonth(jan, -1).toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(startOfUtcMonth(jan, -13).toISOString()).toBe("2024-12-01T00:00:00.000Z");
  });

  it("buckets the 6-month series in UTC too, one bucket per row", () => {
    // The dashboard chart asks for [now-5 … now]. Consecutive windows must
    // abut exactly: a gap drops rows, an overlap double-counts them.
    for (let i = -5; i <= 0; i++) {
      const a = utcMonthWindow(NOW, i);
      const b = utcMonthWindow(NOW, i + 1);
      expect(a.endExclusive.toISOString()).toBe(b.start.toISOString());
    }
  });
});

describe("isInUtcMonth (money-003 / rep-003)", () => {
  it("does not count the same calendar month of a previous year", () => {
    const lastYear = "2025-10-05T00:00:00.000Z";
    expect(isInUtcMonth(lastYear, NOW)).toBe(false);
  });

  it("reproduces the bug it replaces: the month-index predicate counted it", () => {
    // Exactly what /expenses compared before: month index only, no year.
    const lastYear = new Date("2025-10-05T00:00:00.000Z");
    expect(lastYear.getMonth() === NOW.getMonth()).toBe(true);
  });

  it("accepts the ISO string the RSC boundary hands the client", () => {
    // Transactions cross the server/client boundary as ISO strings
    // (lib/queries/transactions.ts `toClient`), so the predicate takes both.
    expect(isInUtcMonth(OCT_1.toISOString(), NOW)).toBe(true);
    expect(isInUtcMonth(OCT_1, NOW)).toBe(true);
  });
});

describe("utcMonthShortLabel (the off-by-one a UTC bucket would otherwise print)", () => {
  it("labels the UTC month, not the viewer's", () => {
    expect(utcMonthShortLabel(startOfUtcMonth(NOW))).toBe("Oct");
    // What `format(monthStart, "MMM")` produced for the same instant: the
    // local rendering of 2026-10-01T00:00Z in Bogota is Sep 30.
    expect(new Intl.DateTimeFormat("en-US", { month: "short" }).format(startOfUtcMonth(NOW))).toBe(
      "Sep"
    );
  });
});

describe("utcMonthsAgo (the rolling burn window)", () => {
  it("lands on UTC midnight the same day-of-month, months back", () => {
    expect(utcMonthsAgo(NOW, 3).toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("crosses the year boundary", () => {
    expect(utcMonthsAgo(new Date("2026-01-10T18:00:00.000Z"), 3).toISOString()).toBe(
      "2025-10-10T00:00:00.000Z"
    );
  });

  it("clamps into a short month instead of rolling forward into the next one", () => {
    // Date.UTC(2026, 1, 31) normalises to March 3rd, which would silently move
    // a 3-month burn window three days. date-fns `subMonths` clamps; so do we.
    expect(utcMonthsAgo(new Date("2026-05-31T18:00:00.000Z"), 3).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    expect(utcMonthsAgo(new Date("2024-05-31T18:00:00.000Z"), 3).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z"
    );
  });
});

describe("the finance clients no longer carry their own month boundary", () => {
  it("/expenses does not compare month indexes (money-003 / rep-003)", () => {
    expect(codeOnly(source(EXPENSES))).not.toMatch(/getMonth\s*\(\s*\)\s*===/);
  });

  it("neither client reaches for date-fns month arithmetic (money-007)", () => {
    // `startOfUtcMonth` / `endExclusive` do not match these — the \b and the
    // trailing paren pin the date-fns spellings specifically.
    const banned = /\b(startOfMonth|endOfMonth|subMonths)\s*\(/;
    expect(codeOnly(source(DASHBOARD))).not.toMatch(banned);
    expect(codeOnly(source(EXPENSES))).not.toMatch(banned);
  });

  it("both clients import the shared boundary", () => {
    expect(source(DASHBOARD)).toContain('from "@/lib/date-range"');
    expect(source(EXPENSES)).toContain('from "@/lib/date-range"');
  });

  it("the dashboard does not label a month with the local formatter", () => {
    expect(codeOnly(source(DASHBOARD))).not.toMatch(/format\s*\(\s*monthStart/);
  });
});
