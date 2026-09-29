/**
 * i18n-004 — dates and relative times follow the active locale.
 *
 * THE BUG. `formatDate` was `format(new Date(date), "MMM dd, yyyy")` with no
 * date-fns `locale` option, and `formatRelativeTime` returned the literal
 * English templates `Today at …` / `Yesterday at …` and otherwise
 * `formatDistanceToNow(d, { addSuffix: true })`. Neither took a locale at all,
 * so the six routes that ARE translated still rendered "Sep 26, 2026" and
 * "about 2 hours ago" — the translation looked unfinished on precisely the
 * screens (settings, notifications, team) that were finished.
 *
 * WHY THESE ASSERTIONS ARE SHAPED THE WAY THEY ARE.
 *
 *  • `Intl` output varies by Node version and ICU build. A test that pasted
 *    "۲۶ ستمبر" or "24 مئی، 2026" would be green on one machine, red on the
 *    next, and the next person would delete it. So every Urdu expectation here
 *    is computed from `Intl` itself, with the same locale tag the
 *    implementation is contracted to use (`numberingLocale`, so the digit
 *    family stays the pinned `latn` — see lib/i18n/numbering.ts). What is
 *    asserted is the ROUTING: that the helper hands the job to ICU for the
 *    requested locale, rather than to an English table.
 *
 *  • `npm test` pins `TZ=America/Bogota` (UTC-5). The calendar case below is
 *    written to be MEANINGFUL under that pin rather than vacuous: a UTC-midnight
 *    value must render as the 14th in both locales, and the assertion that it
 *    does NOT say 15 is what would fail if the suite ever ran in UTC. This repo
 *    has already shipped one calendar assertion that was true in every zone and
 *    therefore checked nothing (see tests/lib/utils.test.ts's note on the old
 *    `/Jan 1[45], 2026/`).
 *
 *  • The English expectations are exact and unchanged on purpose. 17 call sites
 *    across 9 files pass no locale at all, and `lib/billing/billing-notify.ts`
 *    passes `formatDate` into a string that is PERSISTED and mailed — a row
 *    written once and read by everybody, which lib/utils.ts argues at length
 *    must stay in the prose locale. Localising by default would have silently
 *    changed those. The default must remain English, byte for byte.
 */

import { describe, it, expect } from "vitest";
import { formatDate, formatRelativeTime } from "@/lib/utils";
import { numberingLocale } from "@/lib/i18n/numbering";

const UR = numberingLocale("ur");
const EN = numberingLocale("en");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midday UTC: the same calendar day in Bogota, so this case tests FORMAT only. */
const MIDDAY = "2026-05-24T12:00:00Z";
/** UTC midnight: the 14th in Bogota. This case tests the TIMEZONE pin. */
const UTC_MIDNIGHT = new Date("2026-01-15T00:00:00Z");

describe("the suite runs west of UTC, or half of this file is vacuous", () => {
  it("is pinned to America/Bogota (UTC-5, no DST)", () => {
    expect(UTC_MIDNIGHT.getTimezoneOffset()).toBe(300);
  });
});

describe("formatDate follows the active locale (i18n-004)", () => {
  it("renders the month in Urdu, with no English left in the string", () => {
    const out = formatDate(MIDDAY, "ur");

    // The whole defect in one assertion: an Urdu screen rendering "May".
    expect(out, `formatDate(…, "ur") still contains Latin letters: ${out}`).not.toMatch(/[A-Za-z]/);

    // Computed, never pasted — this is ICU's own short month name for `ur`,
    // resolved in the same zone formatDate renders in (local, no timeZone
    // option), so it moves with the machine exactly as the subject does.
    const urMonth = new Intl.DateTimeFormat(UR, { month: "short" }).format(new Date(MIDDAY));
    expect(out).toContain(urMonth);
    expect(out).toContain("2026");
  });

  it("names the viewer's calendar day in Urdu, not UTC's", () => {
    // MEANINGFUL UNDER TZ=America/Bogota AND ONLY THERE. `formatDate` is the
    // wall-clock formatter, so a UTC-midnight instant is the 14th for this
    // viewer. Both locales must agree on WHICH day; only the words differ.
    const urdu = formatDate(UTC_MIDNIGHT, "ur");
    expect(urdu).not.toMatch(/[A-Za-z]/);
    expect(urdu).toContain("14");
    expect(
      urdu,
      "rendered UTC's day instead of the viewer's — the suite is not in Bogota"
    ).not.toContain("15");
    expect(formatDate(UTC_MIDNIGHT, "en")).toBe("Jan 14, 2026");
  });

  it("keeps English output byte-identical, defaulted and explicit alike", () => {
    // 17 call sites pass no locale; one of them persists the result. If this
    // moves, they all moved.
    expect(formatDate(MIDDAY)).toBe("May 24, 2026");
    expect(formatDate(MIDDAY, "en")).toBe("May 24, 2026");
    expect(formatDate(MIDDAY, "en")).toBe(
      new Intl.DateTimeFormat(EN, { month: "short", day: "2-digit", year: "numeric" }).format(
        new Date(MIDDAY)
      )
    );
  });
});

describe("formatRelativeTime follows the active locale (i18n-004)", () => {
  it("says 'today' in Urdu, from CLDR, with an Urdu-formatted clock time", () => {
    const now = new Date();
    const out = formatRelativeTime(now, "ur");

    // CLDR's own word, not mine. `numeric: "auto"` is what turns an offset of 0
    // into a word rather than "in 0 days".
    const cldrToday = new Intl.RelativeTimeFormat(UR, { numeric: "auto" }).format(0, "day");
    expect(out, `formatRelativeTime(…, "ur") = ${out}`).toContain(cldrToday);
    expect(out).toContain(
      new Intl.DateTimeFormat(UR, { hour: "numeric", minute: "2-digit" }).format(now)
    );

    // The literal English templates that were the bug.
    expect(out).not.toContain("Today");
    expect(out).not.toContain(" at ");
  });

  it("says 'yesterday' in Urdu", () => {
    const yesterday = new Date(Date.now() - DAY_MS);
    const out = formatRelativeTime(yesterday, "ur");

    expect(out).toContain(new Intl.RelativeTimeFormat(UR, { numeric: "auto" }).format(-1, "day"));
    expect(out).not.toContain("Yesterday");
  });

  it("delegates the older-than-yesterday case to Intl for the requested locale", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);

    // Asserting against Intl rather than against "10 دنوں پہلے": the contract
    // is "ICU decides the phrasing", and ICU's phrasing is allowed to change.
    expect(formatRelativeTime(tenDaysAgo, "ur")).toBe(
      new Intl.RelativeTimeFormat(UR, { numeric: "always" }).format(-10, "day")
    );
    expect(formatRelativeTime(tenDaysAgo, "ur")).not.toMatch(/[A-Za-z]/);
  });

  it("keeps the English wording every untranslated call site already ships", () => {
    const now = new Date();
    const yesterday = new Date(Date.now() - DAY_MS);
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);

    expect(formatRelativeTime(now)).toMatch(/^Today at \d/);
    expect(formatRelativeTime(yesterday)).toMatch(/^Yesterday at \d/);
    expect(formatRelativeTime(tenDaysAgo)).toMatch(/ago$/);
    // Defaulted and explicit-"en" must not drift apart.
    expect(formatRelativeTime(tenDaysAgo)).toBe(formatRelativeTime(tenDaysAgo, "en"));
  });
});
