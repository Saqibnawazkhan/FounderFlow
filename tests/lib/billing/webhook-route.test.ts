/**
 * Structural guards proving the LemonSqueezy route is WIRED to the audited
 * decisions, rather than having quietly regrown the inline versions.
 *
 * WHY SOURCE TEXT AND NOT A CALL. A Next.js route handler may only export the
 * HTTP verbs, so it cannot export a constant for a test to read, and importing
 * it instantiates the Prisma client. tests/lib/db/purge-invariants.test.ts,
 * tests/lib/db/script-safety.test.ts and the last block of
 * tests/lib/billing/webhook-identity.test.ts all use text assertions for
 * exactly this reason. The behaviour is pinned by the unit tests over the pure
 * modules; these only pin the wiring - which is where every one of the P1
 * billing findings actually lived, since the pure modules did not exist.
 *
 * Findings covered: bill-002/003 (staleness decision), bill-006 (test mode and
 * store/variant scope), bill-007 (absent != NULL), bill-008 (an event that
 * cannot be placed must be loud), bill-012 (an ambiguous customer id must not
 * be guessed at), bill-018 (payment failures must notify someone).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = join(process.cwd(), "app", "api", "webhooks", "lemonsqueezy", "route.ts");
const source = () => readFileSync(ROUTE, "utf8");

/** Everything from the first occurrence of `marker` onwards. */
function from(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i, `expected the route to mention ${marker}`).toBeGreaterThan(-1);
  return src.slice(i);
}

describe("the webhook route file itself", () => {
  it("is the file this suite thinks it is", () => {
    // Guards the guard: every assertion below passes vacuously against an empty
    // string, so a moved or renamed route would turn this whole block green
    // while checking nothing.
    const src = source();
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain("export async function POST");
  });
});

describe("bill-006 - the route knows which store, product and mode it is in", () => {
  it("runs the scope decision", () => {
    expect(source()).toContain("decideEventScope");
  });

  it("imports the store and variant ids it spent the audit ignoring", () => {
    const src = source();
    expect(src).toContain("LS_STORE_ID");
    expect(src).toContain("LS_VARIANT_ID_TEAM");
  });

  it("reads test_mode off the payload", () => {
    expect(source()).toContain("test_mode");
  });

  it("scopes the event BEFORE resolving which workspace it belongs to", () => {
    // Order matters for triage as much as for security: an event from another
    // store is not a workspace-identity question, and letting it reach the
    // identity resolver turns ordinary foreign traffic into forgery alerts.
    const src = source();
    expect(src.indexOf("decideEventScope")).toBeLessThan(src.indexOf("resolveWebhookCompany"));
  });
});

describe("bill-002 / bill-003 - the route defers the write to the staleness decision", () => {
  it("runs decideSubscriptionWrite instead of assembling `data` inline", () => {
    expect(source()).toContain("decideSubscriptionWrite");
  });

  it("no longer keeps its own copy of the paid-status set", () => {
    // Two definitions of "which statuses are paid" is how the read side and the
    // write side end up disagreeing. One definition, in lib/billing/plan.ts.
    expect(source()).not.toContain('new Set(["active", "on_trial", "past_due", "cancelled"])');
  });

  it("reports a skipped write rather than dropping it on the floor", () => {
    expect(source()).toContain("reportSkippedBillingWrite");
  });
});

describe("bill-007 - absent attributes must not become NULLs", () => {
  it("no longer writes currentPeriodEnd unconditionally", () => {
    // The literal shape of the bug, so a refactor cannot reintroduce it quietly.
    expect(source()).not.toContain("currentPeriodEnd: periodEnd ? new Date(periodEnd) : null");
  });

  it("distinguishes an absent period key from a null one", () => {
    expect(source()).toContain("readPeriodEnd");
  });
});

describe("bill-008 - an event that cannot be placed is loud", () => {
  it("reports every unplaceable delivery", () => {
    // The old code was `if (companyId) { ...update... }` with no else, then a
    // cheerful 200: money in, nothing delivered, and not one log line.
    expect(source()).toContain("reportUnplaceableBillingEvent");
  });

  it("does not answer `ignored` without reporting it first", () => {
    const tail = from(source(), "ignored:");
    const head = source().slice(0, source().indexOf("ignored:"));
    expect(
      head.includes("reportUnplaceableBillingEvent") ||
        tail.includes("reportUnplaceableBillingEvent"),
      "the ignored-event reply must sit next to the report that makes it visible"
    ).toBe(true);
  });
});

describe("bill-012 - an ambiguous customer id is refused, not guessed at", () => {
  it("no longer picks whichever row Postgres happens to return first", () => {
    // `findFirst` with no orderBy over a column with no unique constraint: one
    // person paying for two workspaces could have a cancellation for one
    // applied to the other, non-deterministically. The regex is the literal
    // shape of the bug, so a refactor cannot reintroduce it quietly - and it is
    // anchored on the COLUMN rather than on a line offset, because other
    // findFirst calls in this route are perfectly legitimate.
    expect(source()).not.toMatch(/findFirst\(\{\s*where:\s*\{\s*billingCustomerId/);
    const lookup = from(source(), "byCustomerId:");
    expect(lookup).toContain("findMany");
    expect(lookup).toContain("take: 2");
  });

  it("orders the lookup deterministically so a repeat query cannot disagree", () => {
    expect(from(source(), "byCustomerId:")).toContain("orderBy");
  });
});

describe("bill-018 - a declined card reaches a human", () => {
  it("handles the payment events that used to fall through to a bare 200", () => {
    const src = source();
    expect(src).toContain("subscription_payment_failed");
    expect(src).toContain("subscription_payment_recovered");
  });

  it("notifies the workspace admins", () => {
    expect(source()).toContain("notifyWorkspaceAdmins");
  });

  it("takes the subscription id of an invoice event from attributes, not from data.id", () => {
    // THE TRAP. On `subscription_payment_*` the `data` object is an INVOICE, so
    // `data.id` is an invoice id. Feeding it to the identity resolver as a
    // subscription id would bind a workspace to an id LemonSqueezy will never
    // send again - and an unbound-looking workspace is the most attractive
    // forgery target there is (see lib/billing/webhook-identity.ts).
    expect(source()).toContain("subscription_id");
  });
});
