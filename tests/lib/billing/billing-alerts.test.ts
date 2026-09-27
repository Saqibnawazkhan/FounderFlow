/**
 * bill-018 - "a declined card tells nobody".
 *
 * THE BUG THIS ENCODES. `SUB_EVENTS` held the seven `subscription_*` lifecycle
 * events and nothing else, so `subscription_payment_failed`,
 * `_payment_success` and `_payment_recovered` fell straight through to
 * `return NextResponse.json({ received: true })`. The app has a full
 * notification fan-out with a per-event preferences matrix
 * (lib/notify/fan-out.ts) and billing used none of it. The admin's only warning
 * that their card had been declined was whatever email LemonSqueezy sent to the
 * CARD-HOLDER's address - which need not be the workspace admin at all, since
 * checkout lets the buyer type any email. Then the subscription expired and the
 * workspace silently dropped to free with nothing explaining why invites had
 * stopped working.
 *
 * Involuntary churn is the largest recoverable revenue loss in a subscription
 * business, and this made it invisible.
 *
 * The copy lives in its own pure module (lib/billing/billing-alerts.ts) rather
 * than inside the fan-out call, for the same reason
 * lib/billing/webhook-identity.ts is pure: the route handler cannot be
 * unit-tested without a Prisma client, so anything a test needs to reach has to
 * sit outside it. Same split as webhook-identity / billing-forgery.
 */

import { describe, expect, it } from "vitest";
import {
  BILLING_ALERT_KINDS,
  billingAlertCopy,
  type BillingAlertKind,
} from "@/lib/billing/billing-alerts";

const NOW = new Date("2026-09-26T12:00:00Z");
const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe("billingAlertCopy", () => {
  it("tells the admin the card failed and what to do about it", () => {
    const copy = billingAlertCopy("payment_failed", {
      workspaceName: "Nimbus",
      accessEndsAt: new Date("2026-10-10T00:00:00Z"),
      formatDate: fmt,
    });
    expect(copy.title).toMatch(/payment failed/i);
    // Naming the action is the whole point - "something went wrong" is the
    // version of this that still loses the customer.
    expect(copy.message).toMatch(/card/i);
    expect(copy.tone).toBe("danger");
    // Links inside the app, not off to LemonSqueezy: Notification.link is fed
    // to the in-app router and to web push, and /settings is where the
    // "Manage billing" button that opens the real portal lives.
    expect(copy.link.startsWith("/")).toBe(true);
  });

  it("includes the deadline when there is one, and reads correctly without one", () => {
    const withDate = billingAlertCopy("payment_failed", {
      accessEndsAt: new Date("2026-10-10T00:00:00Z"),
      formatDate: fmt,
    });
    expect(withDate.message).toContain("2026-10-10");

    const withoutDate = billingAlertCopy("payment_failed", { accessEndsAt: null, formatDate: fmt });
    expect(withoutDate.message).not.toMatch(/null|undefined|Invalid Date|NaN/);
  });

  it("says something reassuring when the payment recovers", () => {
    const copy = billingAlertCopy("payment_recovered", { formatDate: fmt });
    expect(copy.tone).toBe("success");
    expect(copy.title).not.toMatch(/failed/i);
  });

  it("explains a cancellation in terms of when access stops, never as a renewal", () => {
    const copy = billingAlertCopy("cancelled", {
      accessEndsAt: new Date("2026-10-10T00:00:00Z"),
      formatDate: fmt,
    });
    expect(copy.message).not.toMatch(/renew/i);
    expect(copy.message).toContain("2026-10-10");
  });

  it("says plainly that the workspace has dropped to free when it expires", () => {
    // bill-013's other half: the team page stops accepting invites and nothing
    // says why. This is the sentence that explains it.
    const copy = billingAlertCopy("expired", { formatDate: fmt });
    expect(copy.message).toMatch(/free/i);
  });

  it("covers every declared kind with non-empty copy", () => {
    // A kind with no copy is a notification that arrives reading "undefined".
    for (const kind of BILLING_ALERT_KINDS) {
      const copy = billingAlertCopy(kind, { formatDate: fmt, accessEndsAt: NOW });
      expect(copy.title.length, kind).toBeGreaterThan(0);
      expect(copy.message.length, kind).toBeGreaterThan(0);
      expect(copy.link.length, kind).toBeGreaterThan(0);
    }
  });

  it("names the workspace when it knows it, and stays grammatical when it does not", () => {
    // One admin can own several workspaces, and "your subscription" is useless
    // to them. But the webhook may not have the name, so it must read either way.
    const named = billingAlertCopy("expired", { workspaceName: "Nimbus", formatDate: fmt });
    const anon = billingAlertCopy("expired", { workspaceName: null, formatDate: fmt });
    expect(named.message).toContain("Nimbus");
    expect(anon.message).not.toMatch(/null|undefined/);
  });

  it("declares exactly the kinds the webhook can raise", () => {
    const kinds: BillingAlertKind[] = [
      "payment_failed",
      "payment_recovered",
      "cancelled",
      "expired",
    ];
    expect(BILLING_ALERT_KINDS.slice().sort()).toEqual(kinds.slice().sort());
  });
});
