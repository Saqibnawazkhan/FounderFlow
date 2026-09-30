/**
 * bill-016, the half a customer can see: Settings → Plan & billing never said
 * what the workspace was being charged, or in what currency.
 *
 * THE SITUATION THIS IS ABOUT. `Company.currency` defaults to PKR and is printed
 * on this very page, two sections above, in the Company card. LemonSqueezy is a
 * merchant of record and charges the card in its store currency (USD). The
 * billing card rendered a plan name, a status token and a date — so there was
 * nothing anywhere in the product that a founder could hold next to a USD line
 * on a bank statement and recognise.
 *
 * WHY THIS FILE RENDERS INSTEAD OF READING THE SOURCE AS TEXT. The sibling
 * copy tests (tests/lib/i18n/settings-copy.test.ts,
 * tests/app/settings/danger-zone-export-pointer.test.ts) read
 * settings-client.tsx as a string, which is the right shape for "this sentence
 * must not claim X". It is the wrong shape here, because this repo's other
 * signature defect is a value that is computed, typed and tested and then
 * rendered nowhere: a source-text assertion would pass on a
 * `billing.lastCharge` that is read into a variable and never placed in the
 * tree. So every assertion below is `screen.getByText` against a real render.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: an exact sentence. The amount, the currency
 * and the merchant's name are the facts; the prose around them is free to be
 * reworded. The one place a literal IS pinned is the pointer to invoices, which
 * must keep quoting a label that really exists as a button in this same card —
 * the discipline danger-zone-export-pointer.test.ts established after a hint
 * sent the reader looking for a button that had been renamed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatDate } from "@/lib/utils";
import type { BillingSummary } from "@/lib/queries/billing";

const actions = vi.hoisted(() => ({
  createCheckoutSessionAction: vi.fn(),
  createBillingPortalSessionAction: vi.fn(),
}));
vi.mock("@/lib/actions/billing", () => ({
  createCheckoutSessionAction: () => actions.createCheckoutSessionAction(),
  createBillingPortalSessionAction: () => actions.createBillingPortalSessionAction(),
}));

// Keep Prisma and next-auth out of the module graph: settings-client imports
// every settings action transitively through its modals.
vi.mock("@/lib/actions/auth", () => ({ logoutAction: vi.fn() }));
vi.mock("@/lib/actions/appearance", () => ({ updateAppearanceAction: vi.fn() }));
vi.mock("@/lib/actions/profile", () => ({
  getMyHandleAction: vi.fn(),
  updateHandleAction: vi.fn(),
  updateProfileAction: vi.fn(),
  changePasswordAction: vi.fn(),
}));
vi.mock("@/lib/actions/account", () => ({
  describeAccountDeletionAction: vi.fn(),
  deleteAccountAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
}));
vi.mock("@/lib/actions/company", () => ({ updateCompanyAction: vi.fn() }));
vi.mock("@/lib/actions/email-change", () => ({ requestEmailChangeAction: vi.fn() }));
vi.mock("@/lib/actions/push", () => ({
  savePushSubscriptionAction: vi.fn(),
  removePushSubscriptionAction: vi.fn(),
}));
vi.mock("@/lib/actions/notification-preferences", () => ({
  updateNotificationPreferenceAction: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", theme: "dark" }),
  useStoreHasHydrated: () => true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

import { BillingSection } from "@/app/(app)/settings/settings-client";

const CHARGED_AT = "2026-09-12T10:00:00.000Z";

function summary(over: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: "team",
    status: "active",
    currentPeriodEnd: "2026-10-12T10:00:00.000Z",
    hasCustomer: true,
    configured: true,
    lastCharge: {
      currency: "USD",
      amountMinor: 1000,
      formatted: "$10.00",
      chargedAt: CHARGED_AT,
    },
    billingCurrency: "USD",
    ...over,
  };
}

/** Everything the card renders, as one whitespace-collapsed string. */
function cardText(): string {
  const root = document.body.textContent ?? "";
  return root.replace(/\s+/g, " ");
}

beforeEach(() => {
  actions.createCheckoutSessionAction.mockReset();
  actions.createBillingPortalSessionAction.mockReset();
});

describe("the billing card says what the workspace is charged (bill-016)", () => {
  it("shows the amount, the currency code and the date of the last charge", () => {
    render(<BillingSection billing={summary()} workspaceCurrency="PKR" />);
    // WHAT BREAKS WITHOUT THIS: the card's only money-shaped content is the word
    // "Team". The customer cannot tell a $10 LemonSqueezy line on a card
    // statement from any other foreign charge.
    const text = cardText();
    expect(text).toContain("$10.00");
    // The bare symbol is not enough — "$" is ambiguous across a dozen
    // currencies, and the whole point of the finding is the ISO code.
    expect(text).toContain("USD");
    expect(text).toContain(formatDate(new Date(CHARGED_AT)));
  });

  it("reconciles the billing currency against the workspace's reporting currency", () => {
    render(<BillingSection billing={summary()} workspaceCurrency="PKR" />);
    const text = cardText();
    // The merchant of record is named because it is what appears on the
    // statement — not "FounderFlow".
    expect(text).toMatch(/lemonsqueezy/i);
    expect(text).toMatch(/merchant of record/i);
    // Both currencies, in one sentence, so the mismatch is explained rather
    // than left for the customer to discover on their bank statement.
    expect(text).toContain("PKR");
  });

  it("does not manufacture a mismatch for a workspace that reports in the billing currency", () => {
    render(<BillingSection billing={summary()} workspaceCurrency="USD" />);
    const text = cardText();
    // A USD-reporting workspace has nothing to reconcile; telling it that its
    // reporting currency differs would be the same class of untrue copy the
    // finding is about, pointed the other way.
    expect(text).not.toMatch(/reports in USD/i);
    expect(text).not.toMatch(/differs/i);
    // The merchant is still worth naming — it is whose name is on the charge.
    expect(text).toMatch(/lemonsqueezy/i);
  });

  it("states the billing currency before the first charge exists", () => {
    render(
      <BillingSection
        billing={summary({ lastCharge: null, billingCurrency: "USD" })}
        workspaceCurrency="PKR"
      />
    );
    const text = cardText();
    expect(text).toContain("USD");
    expect(text).toContain("PKR");
    // And invents no amount. A workspace that has upgraded but whose first
    // payment webhook has not landed yet must show no figure at all.
    expect(text).not.toContain("$10.00");
    expect(text).not.toMatch(/\$\d/);
  });

  it("tells a free workspace which currency it would be charged in", () => {
    render(
      <BillingSection
        billing={summary({
          plan: "free",
          status: null,
          currentPeriodEnd: null,
          hasCustomer: false,
          lastCharge: null,
        })}
        workspaceCurrency="PKR"
      />
    );
    const text = cardText();
    // This is the moment the information is worth most: before paying. The card
    // shows an "Upgrade to Team" button, and a PKR-reporting founder should not
    // discover the currency on the checkout page.
    expect(text).toContain("USD");
    expect(text).toMatch(/lemonsqueezy/i);
  });

  it("claims nothing about currency on a deployment with no billing configured", () => {
    render(
      <BillingSection
        billing={summary({ configured: false, lastCharge: null })}
        workspaceCurrency="PKR"
      />
    );
    const text = cardText();
    expect(text).toMatch(/isn.t set up/i);
    // There is no merchant and no charge on a deployment with no LemonSqueezy
    // keys, so promising a USD charge would be inventing a billing relationship.
    expect(text).not.toMatch(/merchant of record/i);
  });

  it("follows the invoice's own currency rather than a constant", () => {
    render(
      <BillingSection
        billing={summary({
          lastCharge: {
            currency: "EUR",
            amountMinor: 950,
            formatted: "€9.50",
            chargedAt: CHARGED_AT,
          },
          billingCurrency: "EUR",
        })}
        workspaceCurrency="PKR"
      />
    );
    const text = cardText();
    expect(text).toContain("€9.50");
    expect(text).toContain("EUR");
    // If "USD" survives here, the sentence is a hardcoded string and not a
    // reading of what the customer was actually charged.
    expect(text).not.toContain("USD");
  });

  it("formats an amount the provider did not format, without assuming cents", () => {
    render(
      <BillingSection
        billing={summary({
          lastCharge: {
            currency: "JPY",
            amountMinor: 1500,
            formatted: null,
            chargedAt: CHARGED_AT,
          },
          billingCurrency: "JPY",
        })}
        workspaceCurrency="PKR"
      />
    );
    // JPY has no minor unit, so a blind /100 would report ¥15 for a ¥1,500
    // charge — a tenfold understatement presented as fact.
    const text = cardText();
    expect(text).toContain("1,500");
    expect(text).not.toContain("15.00");
  });

  it("points at invoices using a label that exists in this card", () => {
    render(<BillingSection billing={summary()} workspaceCurrency="PKR" />);
    const text = cardText();
    // The durable route to receipts is the customer portal, not the invoice URL
    // in the stored payload (LemonSqueezy's hosted links are short-lived). So
    // the copy has to send the reader to the button that opens the portal, by
    // its real name.
    const button = screen.getByRole("button", { name: /manage billing/i });
    expect(button).toBeInTheDocument();
    // One regex, not two assertions: `toContain("Manage billing")` on its own is
    // satisfied by the button's own text, so it would pass on copy that never
    // mentions invoices at all. The label has to appear INSIDE the sentence
    // about receipts.
    expect(text).toMatch(/(invoices?|receipts?)[^.]*.Manage billing./i);
  });

  it("does not send a comped workspace to a portal it has no account in", () => {
    render(
      <BillingSection
        billing={summary({ hasCustomer: false, lastCharge: null })}
        workspaceCurrency="PKR"
      />
    );
    // A hand-granted Team workspace (the demo workspace, anyone the operator
    // upgraded by hand) has no LemonSqueezy customer, so
    // createBillingPortalSessionAction answers "No billing account yet — upgrade
    // first." Pointing them at that button for their invoices would be a smaller
    // copy of the defect this finding is about: a confident instruction that
    // leads nowhere. The currency note still belongs, because if they ever do
    // pay it will be in USD.
    const text = cardText();
    expect(text).not.toMatch(/invoices?|receipts?/i);
    expect(text).toMatch(/merchant of record/i);
  });
});
