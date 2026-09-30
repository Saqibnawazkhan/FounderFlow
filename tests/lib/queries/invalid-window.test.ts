/**
 * `lib/date-range.ts` computes the windows every money figure is filtered by.
 * It must never hand a caller an Invalid Date, because an Invalid Date is not a
 * loud failure at the point of the mistake — it travels.
 *
 * ── WHY THIS EXISTS (the /dashboard crash) ─────────────────────────────────
 *
 * `app/(app)/dashboard/page.tsx` called
 * `utcMonthsAgo(now, BURN_WINDOW_MONTHS)` with a value that was `{}` at
 * runtime rather than `3` (it was imported across the RSC boundary from a
 * `"use client"` module — see tests/app/dashboard/client-boundary.test.ts).
 * `utcMonthsAgo` did the arithmetic, got NaN, and returned an Invalid Date
 * without complaint. Three layers later Prisma refused it:
 *
 *   Invalid `prisma.transaction.groupBy()` invocation:
 *     where: { date: { gte: new Date("Invalid Date") } }
 *   Invalid value for argument `gte`: Provided Date object is invalid.
 *
 * — which is an opaque message a long way from the one-line cause, and which
 * took the product's home screen down to the error boundary.
 *
 * Prisma at least refuses. The dangerous version of the same input is a caller
 * that does NOT refuse: `utcMonthWindow` feeds `{ gte, lt }` pairs, and a
 * silently-wrong window on a finance product is worse than a crash, because
 * nobody sees it. So the contract is: bad input in, thrown error out, naming the
 * function and the argument. Never an Invalid Date out.
 */

import { describe, expect, it } from "vitest";
import { isInUtcMonth, startOfUtcMonth, utcMonthWindow, utcMonthsAgo } from "@/lib/date-range";

const NOW = new Date("2026-09-15T12:00:00.000Z");

describe("date-range refuses invalid input instead of returning an Invalid Date", () => {
  it("utcMonthsAgo throws when the month count is not a finite number", () => {
    // This is exactly what the RSC boundary produced: typeof "object", NaN in
    // arithmetic. TypeScript cannot catch it, because to tsc the binding is a
    // `const 3`.
    const proxyShaped = {} as unknown as number;
    expect(() => utcMonthsAgo(NOW, proxyShaped)).toThrow(/utcMonthsAgo/);
    expect(() => utcMonthsAgo(NOW, NaN)).toThrow(/months/);
    expect(() => utcMonthsAgo(NOW, Infinity)).toThrow(/months/);
  });

  it("utcMonthsAgo throws when the reference date is invalid", () => {
    expect(() => utcMonthsAgo(new Date("nope"), 3)).toThrow(/utcMonthsAgo/);
  });

  it("utcMonthWindow throws rather than yielding an invalid half-open range", () => {
    expect(() => utcMonthWindow(new Date("nope"))).toThrow(/utcMonthWindow/);
    expect(() => utcMonthWindow(NOW, {} as unknown as number)).toThrow(/monthOffset/);
  });

  it("startOfUtcMonth throws rather than yielding an invalid boundary", () => {
    expect(() => startOfUtcMonth(new Date("nope"))).toThrow(/startOfUtcMonth/);
    expect(() => startOfUtcMonth(NOW, NaN)).toThrow(/monthOffset/);
  });

  it("isInUtcMonth throws on an invalid reference rather than answering false", () => {
    // Answering `false` would drop a real row out of a real month silently.
    // It delegates to utcMonthWindow, so that is the name in the message — the
    // point of the assertion is that the argument is named, not which frame
    // raised it.
    expect(() => isInUtcMonth("2026-09-15T00:00:00.000Z", new Date("nope"))).toThrow(
      /`ref` must be a valid Date/
    );
    expect(() => isInUtcMonth("2026-09-15T00:00:00.000Z", NOW, NaN)).toThrow(/`monthOffset`/);
  });

  it("still computes the ordinary windows exactly as before", () => {
    // The guard must not change a single valid answer.
    expect(utcMonthsAgo(NOW, 3).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(utcMonthsAgo(NOW, 0).toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(startOfUtcMonth(NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    const w = utcMonthWindow(NOW, -1);
    expect(w.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(w.endExclusive.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(isInUtcMonth("2026-09-01T00:00:00.000Z", NOW)).toBe(true);
    expect(isInUtcMonth("2026-08-31T23:59:59.999Z", NOW)).toBe(false);
  });

  it("isInUtcMonth still answers false for an unparseable VALUE", () => {
    // A row whose own date cannot be parsed is data, not a programming error:
    // it must not take a page down. Only the caller-supplied reference and
    // offset are programmer input, and only those throw.
    expect(isInUtcMonth("not-a-date", NOW)).toBe(false);
  });
});
