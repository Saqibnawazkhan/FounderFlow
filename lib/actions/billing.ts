"use server";

/**
 * LemonSqueezy billing actions — start a hosted Checkout to upgrade to Team, or
 * open the customer's self-serve portal to manage/cancel. Admin-only (the
 * workspace owner manages billing). Both no-op gracefully with a clear error
 * when LemonSqueezy isn't configured, so the app never hard-depends on billing.
 *
 * The webhook (app/api/webhooks/lemonsqueezy) — not these actions — is the
 * source of truth for plan state. Checkout just kicks off the hosted flow, and
 * carries the workspace id in custom data so the webhook can resolve it.
 */

import { createCheckout, getSubscription } from "@lemonsqueezy/lemonsqueezy.js";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import {
  isBillingConfigured,
  LS_STORE_ID,
  LS_VARIANT_ID_TEAM,
  APP_URL,
} from "@/lib/lemonsqueezy/config";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/**
 * Turn a LemonSqueezy SDK error (or any thrown value) into a short, readable
 * string. The SDK returns a JSON:API error whose useful detail lives in
 * `.cause` (an array of { detail } objects); fall back to `.message`.
 */
function describeLsError(err: unknown): string {
  if (err && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (Array.isArray(cause)) {
      const details = cause
        .map((c) => (c && typeof c === "object" ? (c as { detail?: string }).detail : null))
        .filter(Boolean);
      if (details.length) return details.join("; ");
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(err);
}

export async function createCheckoutSessionAction(): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (session.user.role !== "admin") {
    return { success: false, error: "Only the workspace admin can manage billing" };
  }
  if (!isBillingConfigured()) {
    return { success: false, error: "Billing isn't set up on this deployment yet." };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  try {
    const company = await db.company.findFirst({
      where: { id: session.user.companyId, deletedAt: null },
      select: { id: true, name: true, plan: true },
    });
    if (!company) return { success: false, error: "Workspace not found" };
    if (company.plan === "team") {
      return { success: false, error: "You're already on the Team plan." };
    }

    const { data, error } = await createCheckout(LS_STORE_ID, LS_VARIANT_ID_TEAM, {
      checkoutData: {
        email: session.user.email ?? undefined,
        name: company.name,
        // Comes back on every subscription webhook as meta.custom_data — the
        // webhook resolves the workspace from it.
        custom: { company_id: company.id },
      },
      productOptions: {
        redirectUrl: `${APP_URL}/settings?billing=success`,
      },
    });
    const url = data?.data?.attributes?.url;
    if (error || !url) {
      captureServerError(error ?? new Error("No checkout URL returned"), {
        action: "createCheckoutSessionAction",
      });
      const detail = error ? describeLsError(error) : "no checkout URL returned";
      return { success: false, error: `Couldn't start checkout: ${detail}` };
    }
    return { success: true, data: { url } };
  } catch (e) {
    captureServerError(e, { action: "createCheckoutSessionAction" });
    return { success: false, error: `Checkout error: ${describeLsError(e)}` };
  }
}

export async function createBillingPortalSessionAction(): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (session.user.role !== "admin") {
    return { success: false, error: "Only the workspace admin can manage billing" };
  }
  if (!isBillingConfigured()) {
    return { success: false, error: "Billing isn't set up on this deployment yet." };
  }

  try {
    const company = await db.company.findFirst({
      where: { id: session.user.companyId, deletedAt: null },
      select: { billingSubscriptionId: true },
    });
    if (!company?.billingSubscriptionId) {
      return { success: false, error: "No billing account yet — upgrade first." };
    }
    // LemonSqueezy exposes a per-subscription self-serve portal URL.
    const { data, error } = await getSubscription(company.billingSubscriptionId);
    const url = data?.data?.attributes?.urls?.customer_portal;
    if (error || !url) {
      captureServerError(error ?? new Error("No portal URL returned"), {
        action: "createBillingPortalSessionAction",
      });
      const detail = error ? describeLsError(error) : "no portal URL returned";
      return { success: false, error: `Couldn't open the billing portal: ${detail}` };
    }
    return { success: true, data: { url } };
  } catch (e) {
    captureServerError(e, { action: "createBillingPortalSessionAction" });
    return { success: false, error: `Billing portal error: ${describeLsError(e)}` };
  }
}
