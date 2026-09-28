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
 * cannot be placed must be loud), bill-009 (every delivery leaves a record),
 * bill-012 (an ambiguous id must not be guessed at, on either column),
 * bill-018 (payment failures must notify someone).
 *
 * What a delivery DOES to a workspace - one write for two identical deliveries,
 * a rolled-back ledger row for a write that missed - is pinned behaviourally in
 * tests/lib/billing/webhook-ledger.test.ts, which drives POST against a fake
 * Prisma client. Source text can say the transaction is there; only that file
 * can say it works.
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
  it("no longer picks whichever row Postgres happens to return first, on EITHER id", () => {
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

    // The same defect lived on `billingSubscriptionId`, which has no unique
    // constraint either - and that is the column the whole resolution order
    // PREFERS, so a duplicated binding made "which paying customer does this
    // cancellation downgrade?" a coin flip. Both the identity lookup and the
    // payment path read it the same careful way now.
    expect(source()).not.toMatch(/findFirst\(\{\s*where:\s*\{\s*billingSubscriptionId/);
    const bySub = from(source(), "bySubscriptionId:");
    expect(bySub).toContain("findMany");
    expect(bySub).toContain("take: 2");
    expect(source(), "and ambiguity is refused rather than resolved").toContain(
      "subscription-ambiguous"
    );
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

describe("bill-013 - a downgrade actually takes something away", () => {
  it("burns the workspace's still-pending invites when the plan flips to free", () => {
    // One paid month used to buy permanent seats: subscribe, invite twenty
    // people, cancel. `plan` gated exactly one thing in the codebase
    // (inviteUserAction), so a token issued while paid still created a member
    // afterwards. acceptInviteAction now asks the cap as well; this is the other
    // half - the tokens that were handed out on Team do not survive the downgrade.
    const src = source();
    expect(src).toContain("inviteToken.deleteMany");
    const burn = from(src, "inviteToken.deleteMany");
    expect(burn, "unused tokens only - a used one is the record of a real join").toContain(
      "usedAt: null"
    );
  });

  it("reports a workspace left over the free cap, since nothing can suspend a seat yet", () => {
    // Suspending the surplus members needs a column on User that this change is
    // not allowed to add, so the minimum bar is that support can SEE the overage
    // instead of reading "Up to 2 members" on a workspace holding twenty.
    expect(source()).toContain("seatOverage");
  });
});

describe("bill-002 - a captured delivery is not a permanent licence", () => {
  it("bounds how old a delivery may be and still GRANT the paid plan", () => {
    // The signature never expires, so a body captured once (a proxy log, the
    // ngrok tunnel in .env.local.example, a mis-scoped Sentry breadcrumb, the
    // dashboard's own "resend" button) could be POSTed for ever. The airtight
    // fix is a delivered-event ledger keyed on (provider, eventId), which is a
    // new table; without it, the route can still refuse to let an OLD delivery
    // grant anything - which is the only direction a replay is worth capturing
    // for. Downgrades are deliberately never refused on age.
    const src = source();
    expect(src).toContain("MAX_GRANT_AGE_MS");
    expect(src).toContain("updated_at");
    expect(src, "and the refusal is reported, not silent").toContain("stale-grant");
  });

  it("closes the rest of the hole with a delivered-event ledger", () => {
    // THIS ASSERTION USED TO READ THE OTHER WAY. Until 2026-09-29 it was
    // "still says out loud that it has no delivered-event ledger", which was
    // honest while the table did not exist and became a test encoding the bug
    // the moment it did — the repo's most recurrent defect, and one a passing
    // suite would have hidden (the new header still contains the phrase the old
    // regex looked for). The age window narrows the hole for a FIRST delivery
    // that is simply too old; the key below is what stops a second one.
    const src = source();
    expect(src).toContain("billingEvent.create");
    expect(src, "and it still says what the ledger does NOT cover").toMatch(
      /WHAT THE LEDGER DOES NOT COVER/i
    );
  });
});

describe("bill-009 - the ledger is wired, not merely described", () => {
  /** Source with comments stripped: a "must not come back" guard on code only. */
  const codeOnly = () =>
    source()
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

  it("writes the ledger row inside the same transaction as the Company update", () => {
    // Same transaction is the whole mechanism: a rollback takes the ledger row
    // with it, so a delivery is recorded as applied if and only if its write
    // committed. A row written next to the update, rather than with it, is a log
    // - and a log cannot be an idempotency key.
    const src = source();
    expect(src).toContain("db.$transaction");
    const tx = from(src, "db.$transaction");
    expect(tx).toContain("company.updateMany");
    expect(tx).toContain("billingEvent.create");
  });

  it("no longer writes the plan outside a transaction", () => {
    expect(codeOnly()).not.toContain("await db.company.updateMany(");
  });

  it("treats a unique violation on the event id as an already-delivered replay", () => {
    const src = codeOnly();
    expect(src).toContain("P2002");
    expect(src, "and only the ledger's constraint - not any unique violation").toContain("eventId");
  });

  it("derives a deterministic key when LemonSqueezy sends no webhook id", () => {
    // A cuid/uuid/timestamp collides with nothing, so the unique index would
    // stop being a dedupe key and become a row counter.
    const src = codeOnly();
    expect(src).toContain("webhook_id");
    expect(src).toContain("sha256");
  });
});
