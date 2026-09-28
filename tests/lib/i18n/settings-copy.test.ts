/**
 * What the settings screen TELLS the customer about destructive buttons and
 * about money. Three findings, all of them "the copy states something untrue".
 *
 *   • acct-007 — the dialog behind "Reset local preferences" said "All
 *     transactions, tasks, activity, and team members will be wiped. This cannot
 *     be undone." and then removed one localStorage key. Two opposite failures
 *     from one string: someone who wanted their data gone believes it is, and
 *     someone clearing a stuck theme is told they are about to destroy the
 *     business's books and backs out of a harmless action. The section's own note
 *     two elements away already says the truth ("only wipes UI prefs (theme,
 *     sidebar state) — it does not delete server data").
 *   • acct-002 — the workspace-delete confirmation never mentioned the
 *     subscription, and the delete did not cancel it. Now that it does, the
 *     confirmation has to say so: the customer is about to lose the only in-app
 *     route to billing.
 *   • bill-005 — the plan sentence was `Renews ${date}` for EVERY status, and
 *     `currentPeriodEnd` is `ends_at ?? renews_at` where `ends_at` is set
 *     precisely when the subscription has been CANCELLED. So the one case where
 *     the date means "your access stops" was the one case guaranteed to read "you
 *     will be charged again". `describeBillingPeriod` (lib/billing/plan.ts) was
 *     written for this and had no caller.
 *
 * WHY A COPY TEST AT ALL, AND WHY IT ASSERTS ABSENCE. The defect is not a missing
 * string; it is a present, confident, wrong one. A test that asserts the new
 * wording exists would still pass if "All transactions … will be wiped" were left
 * beside it, so each assertion below names the claim that must NOT be there, in
 * both locales — a mistranslation that quietly keeps the old promise in Urdu is
 * the same bug for the customer who reads Urdu.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en, ur } from "@/lib/i18n/strings";

const SETTINGS_CLIENT = join(process.cwd(), "app", "(app)", "settings", "settings-client.tsx");

describe("the reset dialog describes what it actually does (acct-007)", () => {
  it("does not claim to wipe transactions, tasks or team members", () => {
    expect(
      en.settings.resetConfirmDesc,
      "handleResetData runs two statements: localStorage.removeItem and a " +
        "navigation. It deletes no server data, so a dialog promising that every " +
        "transaction goes is a claim nobody can trust afterwards."
    ).not.toMatch(/transaction/i);
    expect(en.settings.resetConfirmDesc).not.toMatch(/cannot be undone/i);
    // The Urdu copy carried the same promise, word for word.
    expect(ur.settings.resetConfirmDesc).not.toContain("ٹرانزیکشنز");
  });

  it("agrees with the button that opens it", () => {
    // The button says "Reset local preferences"; the dialog said "Reset
    // workspace data?". One of the two was lying about the same click.
    expect(en.settings.resetConfirmTitle).toMatch(/preferences/i);
    expect(en.settings.resetConfirmTitle).not.toMatch(/workspace data/i);
    expect(ur.settings.resetConfirmTitle).toContain("ترجیحات");
  });

  it("does not label a preferences reset 'Reset everything'", () => {
    expect(en.settings.resetConfirmLabel).not.toMatch(/everything/i);
    expect(ur.settings.resetConfirmLabel).not.toContain("سب کچھ");
  });

  it("says plainly that workspace data survives", () => {
    expect(en.settings.resetConfirmDesc).toMatch(/not affected|isn't affected|stays/i);
  });

  it("does not send the still-signed-in user to /login", () => {
    // The session cookie is untouched, so /login bounced them straight back in
    // and providers.tsx re-hydrated their identity — the "reset" visibly did
    // nothing, which is its own bug report.
    const src = readFileSync(SETTINGS_CLIENT, "utf8");
    const reset = src.slice(
      src.indexOf("async function handleResetData"),
      src.indexOf("async function handleExport")
    );
    expect(reset.length).toBeGreaterThan(50);
    expect(
      reset,
      "a signed-in user sent to /login is redirected back into the app, so the " +
        "dialog appears to have done nothing at all"
    ).not.toContain('"/login"');
  });
});

describe("the workspace-delete confirmation mentions the subscription (acct-002)", () => {
  it("says the subscription is cancelled, in both locales", () => {
    expect(
      en.settings.deleteWorkspaceConfirmDesc,
      "deleting the workspace cancels the LemonSqueezy subscription and tombstones " +
        "every user, so this dialog is the last place the customer can be told what " +
        "happens to their billing"
    ).toMatch(/subscription/i);
    expect(ur.settings.deleteWorkspaceConfirmDesc).toContain("سبسکرپشن");
  });
});

describe("the solo founder is told they are deleting a workspace (acct-013)", () => {
  it("has copy that names the workspace and what goes with it", () => {
    const copy = en.settings.deleteAccountWorkspaceConfirmDesc;
    expect(
      copy,
      "for the only member of a workspace, deleteAccountAction runs the identical " +
        "whole-workspace cascade as deleteWorkspaceAction. The dialog has to name " +
        "the workspace — the old copy's strongest word was 'account'."
    ).toContain("{workspace}");
    expect(copy).toMatch(/workspace/i);
    expect(ur.settings.deleteAccountWorkspaceConfirmDesc).toContain("{workspace}");
  });
});

describe("the plan sentence is not a claim about renewal (bill-005)", () => {
  it("the settings screen asks describeBillingPeriod instead of formatting its own", () => {
    const src = readFileSync(SETTINGS_CLIENT, "utf8");
    expect(
      src,
      "lib/billing/plan.ts exports describeBillingPeriod — the status-aware " +
        "sentence, unit-tested in tests/lib/billing/subscription-access.test.ts — " +
        "and the settings screen never called it."
    ).toContain("describeBillingPeriod");
    expect(
      src,
      "a hardcoded `Renews ${date}` is the bill-005 bug: currentPeriodEnd is " +
        "`ends_at ?? renews_at`, and ends_at is set precisely when the subscription " +
        "has been cancelled, so this label is wrong exactly when it matters."
    ).not.toContain("Renews ${");
  });
});
