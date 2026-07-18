/**
 * LemonSqueezy webhook — the source of truth for a workspace's plan.
 *
 * Checkout + the customer portal are just hosted UI; the actual billing state
 * (upgraded, cancelled, past-due, expired) lands here as signed events. We
 * verify the HMAC-SHA256 signature against LEMONSQUEEZY_WEBHOOK_SECRET, then
 * reconcile the Company row from the subscription payload.
 *
 * Setup: LemonSqueezy dashboard → Settings → Webhooks → add
 *   https://<domain>/api/webhooks/lemonsqueezy
 * subscribed to the subscription_* events, with a signing secret you also put
 * in LEMONSQUEEZY_WEBHOOK_SECRET.
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { LS_WEBHOOK_SECRET, isWebhookConfigured } from "@/lib/lemonsqueezy/config";
import { captureServerError } from "@/lib/sentry-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Subscription lifecycle events whose `data` is a Subscription object.
const SUB_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);

// Statuses that keep a workspace on the paid plan. "cancelled" still has access
// until the period ends (then a subscription_expired flips it to free).
const PAID_STATUSES = new Set(["active", "on_trial", "past_due", "cancelled"]);

async function resolveCompanyId(
  customData: unknown,
  customerId: unknown
): Promise<string | undefined> {
  const fromCustom =
    customData && typeof customData === "object"
      ? (customData as Record<string, unknown>).company_id
      : undefined;
  if (typeof fromCustom === "string" && fromCustom) return fromCustom;
  if (customerId != null) {
    const c = await db.company.findFirst({
      where: { billingCustomerId: String(customerId) },
      select: { id: true },
    });
    return c?.id;
  }
  return undefined;
}

export async function POST(request: Request) {
  if (!isWebhookConfigured()) {
    return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get("x-signature") ?? "";
  // HMAC-SHA256 of the raw body, hex-encoded, timing-safe compared.
  const digest = crypto.createHmac("sha256", LS_WEBHOOK_SECRET).update(raw).digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const digBuf = Buffer.from(digest, "hex");
  if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: {
    meta?: { event_name?: string; custom_data?: unknown };
    data?: { id?: string | number; attributes?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const eventName = event.meta?.event_name ?? "";
  const sub = event.data;

  try {
    if (SUB_EVENTS.has(eventName) && sub?.attributes) {
      const attrs = sub.attributes;
      const status = String(attrs.status ?? "");
      const companyId = await resolveCompanyId(event.meta?.custom_data, attrs.customer_id);
      if (companyId) {
        // ends_at is set once cancelled; otherwise renews_at is the next cycle.
        const periodEnd = (attrs.ends_at as string | null) ?? (attrs.renews_at as string | null);
        await db.company.updateMany({
          where: { id: companyId },
          data: {
            plan: PAID_STATUSES.has(status) ? "team" : "free",
            subscriptionStatus: status,
            billingSubscriptionId: sub.id != null ? String(sub.id) : null,
            billingCustomerId: attrs.customer_id != null ? String(attrs.customer_id) : null,
            currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
          },
        });
      }
    }
  } catch (e) {
    // 500 so LemonSqueezy retries transient failures.
    captureServerError(e, { action: "lemonSqueezyWebhook", extra: { eventName } });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
