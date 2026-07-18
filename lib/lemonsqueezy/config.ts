/**
 * LemonSqueezy wiring — key-driven and safe when unconfigured.
 *
 * LemonSqueezy is a merchant-of-record: it charges the customer (in USD),
 * handles global tax/VAT, and pays out to the seller — which is why it works
 * for sellers in countries Stripe won't onboard. Billing is OFF unless the
 * LEMONSQUEEZY_* env vars are set; every consumer null-checks via
 * isBillingConfigured() so the app runs fine with no account at all.
 *
 * Test mode: use a test-mode Store + a test API key; the checkout uses test
 * cards and takes no real money. See .env.local.example.
 */

import { lemonSqueezySetup } from "@lemonsqueezy/lemonsqueezy.js";

const apiKey = process.env.LEMONSQUEEZY_API_KEY;

// Configure the SDK once at module load when a key is present.
if (apiKey) {
  lemonSqueezySetup({ apiKey });
}

export const LS_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID ?? "";
export const LS_VARIANT_ID_TEAM = process.env.LEMONSQUEEZY_VARIANT_ID_TEAM ?? "";
export const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "";
/** Absolute app origin for the checkout redirect URL. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** Checkout needs an API key, a store, the Team variant, and an app URL. */
export function isBillingConfigured(): boolean {
  return Boolean(apiKey && LS_STORE_ID && LS_VARIANT_ID_TEAM && APP_URL);
}

/** The webhook additionally needs its signing secret. */
export function isWebhookConfigured(): boolean {
  return Boolean(LS_WEBHOOK_SECRET);
}
