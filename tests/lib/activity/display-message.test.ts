/**
 * money-006, the read half — a figure in the activity feed must come from the
 * row's structured metadata, not from the prose it was baked into.
 *
 * WHAT THIS IS FOR. `Activity.message` is written once and read forever. Until
 * 2026-09-28 it carried a `toLocaleString()` figure and no currency code at all,
 * so a USD or AED workspace's whole history was labelled in whatever the host
 * container's locale happened to be, with a floating 0-3 decimal places
 * (money-001 / money-006). `addTransactionAction` now also writes
 * `{ amount, currency }` into `Activity.metadata` — and nothing read it, which
 * is this project's signature defect: data written for a reader that was never
 * built.
 *
 * THE CONTRACT. Given a row that carries both, the feed renders the amount
 * through `formatCurrency` at READ time. Two things follow, and both are the
 * point:
 *
 *   • The scale and grouping are decided by today's `currencyMinorUnits` table,
 *     not by whatever the writer's runtime believed on the day. A history full
 *     of "1,234.5" and "1,234" for `Decimal(12,2)` columns becomes correct
 *     without a backfill anybody can perform.
 *   • The currency is the one the row was WRITTEN in. A workspace that switches
 *     from PKR to USD next year must not have its old rupee history silently
 *     relabelled as dollars — that is a 280x misreading, not a formatting
 *     preference. So the code comes from metadata, never from the live company.
 *
 * AND THE LIMIT, asserted as hard as the behaviour: when the row does not carry
 * a recoverable figure, or the prose does not contain the figure we would be
 * replacing, the message is returned BYTE-IDENTICAL. A half-matching rewrite of
 * a customer's audit trail is worse than the stale formatting it fixes.
 */

import { describe, it, expect } from "vitest";
import { activityDisplayMessage, activityMoney } from "@/lib/activity/message";
import type { ActivityMetadata } from "@/lib/types";

const meta = (over: Record<string, unknown>): ActivityMetadata =>
  ({ kind: "transaction", category: "Marketing", ...over }) as unknown as ActivityMetadata;

describe("activityMoney — what a row can prove about its own figure", () => {
  it("reads amount + currency off a transaction row", () => {
    expect(activityMoney(meta({ amount: 1234.5, currency: "PKR" }))).toEqual({
      amount: 1234.5,
      currency: "PKR",
    });
  });

  it("is null when the row predates the currency field", () => {
    expect(activityMoney(meta({ amount: 1234.5 }))).toBeNull();
  });

  it("is null for a row with no money in it at all", () => {
    expect(activityMoney({ kind: "task", taskId: "t1", title: "Ship it" })).toBeNull();
    expect(activityMoney(undefined)).toBeNull();
  });

  it("rejects a currency code that is not a three-letter ISO code", () => {
    // Metadata is JSON parsed out of a text column and cast — it is not
    // validated anywhere. A junk value must not reach a RegExp constructor.
    expect(activityMoney(meta({ amount: 10, currency: "P.*R" }))).toBeNull();
    expect(activityMoney(meta({ amount: 10, currency: "" }))).toBeNull();
  });

  it("rejects a non-finite amount", () => {
    expect(activityMoney(meta({ amount: Number.NaN, currency: "PKR" }))).toBeNull();
    expect(activityMoney(meta({ amount: "1234", currency: "PKR" }))).toBeNull();
  });
});

describe("activityDisplayMessage — the figure is re-rendered, the prose is not", () => {
  it("replaces the baked figure with today's formatting of the same amount", () => {
    const out = activityDisplayMessage(
      "Saqib added an expense of 1,234.50 PKR for Marketing",
      meta({ amount: 1234.5, currency: "PKR" })
    );
    expect(out).toBe("Saqib added an expense of PKR 1,234.50 for Marketing");
  });

  it("repairs a legacy row whose figure lost its cents to toLocaleString()", () => {
    // The exact shape money-001 describes: `Decimal(12,2)` written as "1,234.5".
    const out = activityDisplayMessage(
      "Saqib added an expense of 1,234.5 PKR for Marketing",
      meta({ amount: 1234.5, currency: "PKR" })
    );
    expect(out).toBe("Saqib added an expense of PKR 1,234.50 for Marketing");
  });

  it("keeps the currency the row was written in, never the workspace's current one", () => {
    const out = activityDisplayMessage(
      "Saqib added an expense of 1,234.50 PKR for Marketing",
      meta({ amount: 1234.5, currency: "PKR" })
    );
    // Formatted, but still rupees. A later switch to USD must not relabel this.
    expect(out).toContain("PKR");
    expect(out).not.toContain("USD");
  });

  it("formats an AED row at AED's scale", () => {
    const out = activityDisplayMessage(
      "Saqib added an expense of 900.00 AED for Travel",
      meta({ amount: 900, currency: "AED" })
    );
    expect(out).toBe("Saqib added an expense of AED 900.00 for Travel");
  });

  it("returns the message untouched when the row carries no currency", () => {
    const msg = "Saqib added an expense of 1,234.5 for Marketing";
    expect(activityDisplayMessage(msg, meta({ amount: 1234.5 }))).toBe(msg);
  });

  it("returns the message untouched when there is no metadata", () => {
    const msg = "Aisha completed “Wire the Falcon invoice”";
    expect(activityDisplayMessage(msg, undefined)).toBe(msg);
  });

  it("returns the message untouched when the prose holds no figure to replace", () => {
    const msg = "Saqib deleted a transaction";
    expect(activityDisplayMessage(msg, meta({ amount: 1234.5, currency: "PKR" }))).toBe(msg);
  });

  it("rewrites the exact recorded figure even when a second figure shares the sentence", () => {
    // Unambiguous: the token this writer bakes for 1000 PKR occurs once. The
    // cap beside it is a different number and stays as written.
    const msg = "Saqib moved 1,000.00 PKR of the 5,000.00 PKR cap";
    expect(activityDisplayMessage(msg, meta({ amount: 1000, currency: "PKR" }))).toBe(
      "Saqib moved PKR 1,000.00 of the 5,000.00 PKR cap"
    );
  });

  it("refuses to guess when a LEGACY row has two figures and matches neither exactly", () => {
    // Neither figure is the token today's writer would produce for 1000.5, so
    // the only way to pick one is to guess — and a wrong guess rewrites a
    // customer's audit trail. Leave it exactly as written.
    const msg = "Saqib moved 1,000.5 PKR of the 5,000 PKR cap";
    expect(activityDisplayMessage(msg, meta({ amount: 1000.5, currency: "PKR" }))).toBe(msg);
  });

  it("never rewrites a figure that is not adjacent to the currency code", () => {
    const msg = "Saqib set the day of month to 15 for Office Rent";
    expect(activityDisplayMessage(msg, meta({ amount: 15, currency: "PKR" }))).toBe(msg);
  });
});
