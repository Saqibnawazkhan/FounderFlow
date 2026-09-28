import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  cn,
  formatAmountForMessage,
  formatCurrency,
  formatDate,
  formatRelativeTime,
  formatUtcDate,
  formatUtcDay,
  formatUtcMonthYear,
  generateAvatar,
  getAvatarColor,
} from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("dedupes conflicting tailwind classes (last wins)", () => {
    // twMerge specialty: px-2 + px-4 → px-4
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("handles falsy values", () => {
    expect(cn("base", undefined, null, false, "extra")).toBe("base extra");
  });

  it("handles conditional object syntax", () => {
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });
});

// THESE ASSERTIONS USED TO ENCODE THE BUG. Until 2026-09-26 they required
// "PKR 12,345" — no decimals — because formatCurrency passed
// `maximumFractionDigits: 0`. That is not a formatting preference, it is a
// correctness fault: every row in a ledger was rounded independently, so the
// rows a customer reads add up to a different number than the total printed
// above them (audit money-001 / rep-001). A test that demands the rounding is
// a test that defends the fault, which is why these four were red after the
// fix rather than the fix being wrong.
//
// The contract now lives in lib/format.ts's currencyMinorUnits(): two decimals
// for PKR and the other supported currencies, 0 for JPY, 3 for KWD. The
// rows-sum-to-the-total invariant is asserted directly in
// tests/lib/format/currency.test.ts; what these keep covering is that
// lib/utils.ts's re-export still resolves to that implementation.
describe("formatCurrency", () => {
  it("formats PKR with two decimals and the PKR prefix", () => {
    expect(formatCurrency(12345)).toBe("PKR 12,345.00");
  });

  it("groups large PKR amounts and keeps the minor units", () => {
    expect(formatCurrency(1_500_000)).toBe("PKR 1,500,000.00");
  });

  it("handles zero", () => {
    expect(formatCurrency(0)).toBe("PKR 0.00");
  });

  it("handles negative balances", () => {
    expect(formatCurrency(-2500)).toBe("PKR -2,500.00");
  });

  it("falls through to Intl for non-PKR currencies", () => {
    const result = formatCurrency(1000, "USD");
    // en-US locale renders USD as "$1,000"
    expect(result).toMatch(/\$1,000/);
  });
});

// `formatDate` is LOCAL and stays local — see the argument on it in lib/utils.ts.
// Half its call sites are real timestamps (`User.createdAt`, an invite's
// `expiresAt`, a billing period end) where the viewer's clock is the right one.
//
// The `/Jan 1[45], 2026/` regex that used to sit in the second case below was
// this file's second accommodation of a defect: written to pass in EITHER
// timezone, it silently accepted the wrong day rather than stating which day was
// correct. `npm test` pins TZ=America/Bogota precisely so date behaviour is a
// fact and not a coin flip, so these assertions now name the day each function
// produces — and the pair of them is the whole point, because the UTC-midnight
// date-only case is exactly where the local formatter is wrong (money-007).
describe("formatDate (local, for wall-clock timestamps)", () => {
  it("runs west of UTC, or the split below is invisible", () => {
    // 300 = UTC-5 = America/Bogota, no DST.
    expect(new Date("2026-01-15T00:00:00Z").getTimezoneOffset()).toBe(300);
  });

  it("renders ISO date as MMM dd, yyyy", () => {
    expect(formatDate("2026-05-24T12:00:00Z")).toBe("May 24, 2026");
  });

  it("renders in the viewer's zone, which shifts a UTC-midnight value back a day", () => {
    // NOT a bug in `formatDate` — this is what a timestamp formatter must do.
    // It IS a bug at any call site whose value is a date-only one; those use
    // `formatUtcDate`, asserted next.
    expect(formatDate(new Date("2026-01-15T00:00:00Z"))).toBe("Jan 14, 2026");
  });
});

describe("formatUtcDate / formatUtcDay / formatUtcMonthYear (date-only values)", () => {
  it("renders the day the customer typed, not the viewer's", () => {
    // What `<input type="date">` stores for "2026-01-15": UTC midnight. Every
    // ledger row, every export row and the /reports range edges read this way.
    expect(formatUtcDate("2026-01-15T00:00:00Z")).toBe("Jan 15, 2026");
    expect(formatUtcDate(new Date("2026-01-15T00:00:00Z"))).toBe("Jan 15, 2026");
  });

  it("matches formatDate's shape exactly, so swapping a call site changes only the day", () => {
    // Midday UTC: both formatters agree on the calendar day, so this compares
    // the FORMAT and nothing else.
    expect(formatUtcDate("2026-05-24T12:00:00Z")).toBe(formatDate("2026-05-24T12:00:00Z"));
  });

  it("renders an ISO day for a spreadsheet cell", () => {
    expect(formatUtcDay("2026-01-15T00:00:00Z")).toBe("2026-01-15");
    expect(formatUtcDay("2026-12-01T00:00:00Z")).toBe("2026-12-01");
  });

  it("renders a chart bucket label in UTC", () => {
    expect(formatUtcMonthYear("2026-10-01T00:00:00Z")).toBe("Oct 26");
    // The off-by-one a UTC bucket with a local label would have printed.
    expect(
      new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date("2026-10-01T00:00:00Z"))
    ).toBe("Sep");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'Today at <time>' for today's timestamps", () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toMatch(/^Today at /);
  });

  it("returns 'Yesterday at <time>' for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatRelativeTime(yesterday)).toMatch(/^Yesterday at /);
  });

  it("returns 'X ago' for older dates", () => {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    // date-fns formatDistanceToNow with addSuffix → e.g. "10 days ago"
    expect(formatRelativeTime(tenDaysAgo)).toMatch(/ago$/);
  });
});

describe("generateAvatar", () => {
  it("uses first letter of each of the first two words", () => {
    expect(generateAvatar("Saqib Nawaz")).toBe("SN");
    expect(generateAvatar("Jane Doe Smith")).toBe("JD");
  });

  it("falls back to 'U' for empty input", () => {
    expect(generateAvatar("")).toBe("U");
  });

  it("handles single names", () => {
    expect(generateAvatar("Madonna")).toBe("M");
  });

  it("uppercases lowercase initials", () => {
    expect(generateAvatar("alice bob")).toBe("AB");
  });
});

describe("getAvatarColor", () => {
  it("returns the same color for the same name (stable hash)", () => {
    expect(getAvatarColor("Saqib")).toBe(getAvatarColor("Saqib"));
  });

  it("returns a tailwind gradient class string", () => {
    expect(getAvatarColor("any")).toMatch(/^from-\w+-500 to-\w+-500$/);
  });

  it("distributes different names across the palette", () => {
    const colors = new Set(
      ["Saqib", "Jane", "Alice", "Bob", "Charlie", "Dave", "Eve", "Frank"].map(getAvatarColor)
    );
    // Won't always hit all 8 with only 8 names, but should hit several.
    expect(colors.size).toBeGreaterThan(1);
  });
});

/* ───────────────────── money-001, the persisted-string half ──────────────── *
 *
 * The three money figures this app writes into a string that OUTLIVES the
 * render — the activity-log `message`, the in-app notification body, and the
 * delete entry — were interpolated with bare `amount.toLocaleString()`
 * (lib/actions/transactions.ts:192, :240, :457).
 *
 * That is money-001 one layer out from the formatter, and it is worse than the
 * on-screen version for two reasons:
 *
 *  1. **It is not deterministic.** `Number.prototype.toLocaleString()` with no
 *     locale argument resolves to the RUNTIME's default locale, which on a
 *     server is ambient environment (LANG / LC_ALL / the container image), not
 *     a product decision. In a de-DE container `1234.5` becomes `"1.234,5"` —
 *     a decimal comma and dot grouping — and that string is persisted forever
 *     and mailed out beside the literal code "PKR". lib/format.ts already says
 *     these strings must NOT be localised to a viewer, because a row written
 *     once is read by every member; they must therefore be pinned to the prose
 *     locale rather than left to the host.
 *
 *  2. **The scale floats.** `toLocaleString()` defaults to
 *     `maximumFractionDigits: 3` and no minimum, so the same ledger's history
 *     holds "1,234", "1,234.5" and "1,234.56" for values the columns all store
 *     at scale 2 — and "1,234.5" sits in the feed beside the same amount
 *     rendered "PKR 1,234.50" by `formatCurrency` two panels away. Cents that
 *     exist are shown or hidden depending on whether they happen to be zero.
 *
 * `formatAmountForMessage` is the fix: en-US grouping, always, and exactly the
 * minor units the currency stores. It deliberately does NOT emit the currency
 * code — every call site already appends it, and the code belongs next to the
 * figure in the sentence, not inside the number.
 */
describe("formatAmountForMessage (money-001, persisted + emailed strings)", () => {
  it("always shows the stored scale, so a half-rupee is not printed as a whole one", () => {
    expect(formatAmountForMessage(1234.5, "PKR")).toBe("1,234.50");
    expect(formatAmountForMessage(1234.56, "PKR")).toBe("1,234.56");
    expect(formatAmountForMessage(1234, "PKR")).toBe("1,234.00");
  });

  it("does not round a cent away", () => {
    // What the old `toLocaleString()` printed here was "0.5" — and the on-screen
    // formatter says "PKR 0.50" for the same row.
    expect(formatAmountForMessage(0.5, "PKR")).toBe("0.50");
    expect(formatAmountForMessage(0.05, "USD")).toBe("0.05");
  });

  it("groups in en-US regardless of the host's locale, because the row is persisted", () => {
    expect(formatAmountForMessage(2_500_000, "PKR")).toBe("2,500,000.00");
    // A decimal comma or a dot group would mean the server's environment had
    // leaked into a customer's audit trail.
    expect(formatAmountForMessage(1234.5, "USD")).not.toContain("1.234");
  });

  it("carries no currency code — the sentence supplies that", () => {
    expect(formatAmountForMessage(10, "USD")).toBe("10.00");
    expect(formatAmountForMessage(10, "AED")).toBe("10.00");
  });

  it("uses the currency's own minor units, not a hardcoded 2", () => {
    // Not in SUPPORTED_CURRENCIES, but the table in lib/format.ts decides and a
    // zero-decimal currency must not gain phantom cents.
    expect(formatAmountForMessage(1234, "JPY")).toBe("1,234");
  });

  it("emits no non-breaking space, so the stored string is byte-predictable", () => {
    const s = formatAmountForMessage(1_000_000.5, "PKR");
    expect(s).toBe("1,000,000.50");
    expect(/[\u00a0\u202f]/.test(s)).toBe(false);
  });
});

describe("lib/actions/transactions.ts money strings", () => {
  const code = readFileSync(join(process.cwd(), "lib", "actions", "transactions.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

  it("no longer interpolates a money figure with the host's default locale", () => {
    expect(code).not.toContain("toLocaleString()");
  });

  it("formats them through the shared helper instead", () => {
    expect(code).toContain("formatAmountForMessage");
  });
});
