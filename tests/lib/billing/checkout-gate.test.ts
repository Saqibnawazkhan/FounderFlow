/**
 * The trap that bill-004's fix sets for itself, and which nothing in the audit
 * caught because the audit was looking at the leak rather than the repair.
 *
 * `createCheckoutSessionAction` refuses to start a checkout for a workspace
 * that is already on Team:
 *
 *   if (company.plan === "team") return { error: "You're already on the Team plan." }
 *
 * That test reads the RAW column. The whole point of bill-004 is that the column
 * can say "team" long after the customer stopped paying — a lost
 * `subscription_expired`, a card that failed permanently, an event that could not
 * be placed (bill-008). With entitlement now time-aware, such a workspace sees
 * the free member cap, reads "Subscription ended … upgrade to restore Team
 * features" on the billing screen, clicks Upgrade — and is told it is already on
 * Team. It cannot pay us. `plan` has no in-app writer, so there is no way out of
 * that state except hand-written SQL.
 *
 * So the gate has to ask the same question the entitlement does. This is a source
 * assertion for the usual reason (the action imports `auth` and `db`, so reaching
 * it from a test means a Prisma client); `effectivePlan` itself is unit-tested in
 * tests/lib/billing/subscription-access.test.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTION = join(process.cwd(), "lib", "actions", "billing.ts");
const source = () => readFileSync(ACTION, "utf8");

/**
 * Source with comments removed.
 *
 * A "this line must not come back" guard that also matches COMMENTS is a guard
 * that punishes writing down what the bug was — and the comment naming the old
 * shape is the most useful line in the fix. So the guard reads code only.
 */
function codeOnly(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("createCheckoutSessionAction - a lapsed workspace must be able to pay again", () => {
  it("is the file this suite thinks it is", () => {
    const src = source();
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain("createCheckoutSessionAction");
  });

  it("no longer gates on the raw plan column", () => {
    expect(codeOnly()).not.toContain('company.plan === "team"');
  });

  it("asks the time-aware entitlement instead", () => {
    const src = source();
    expect(src).toContain("effectivePlan");
    // And it must actually select the columns that decision needs, or
    // effectivePlan silently sees `undefined` for both and answers "team"
    // forever — a check that compiles, runs, and means nothing.
    expect(src).toContain("subscriptionStatus: true");
    expect(src).toContain("currentPeriodEnd: true");
  });
});
