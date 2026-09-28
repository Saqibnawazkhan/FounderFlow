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

import { appOrigin } from "@/lib/env";

const apiKey = process.env.LEMONSQUEEZY_API_KEY;

// Configure the SDK once at module load when a key is present.
if (apiKey) {
  lemonSqueezySetup({ apiKey });
}

export const LS_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID ?? "";
export const LS_VARIANT_ID_TEAM = process.env.LEMONSQUEEZY_VARIANT_ID_TEAM ?? "";
export const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "";
/**
 * Absolute app origin for the checkout redirect URL.
 *
 * `appOrigin()` — the one decision for the public origin (prodready-004) —
 * rather than this file's own `?? "http://localhost:3000"`. What that cost:
 * `lib/actions/billing.ts` builds `${APP_URL}/settings?billing=success`, so a
 * Production origin stored with a trailing slash sent every buyer who had just
 * paid to `https://app.founderflow.com//settings?billing=success`. That is the
 * worst possible moment for a broken URL, and the charge has already gone
 * through by then.
 */
export const APP_URL = appOrigin();

/**
 * Checkout needs an API key, a store, the Team variant, and an app URL.
 *
 * Read the `APP_URL` term honestly, and note this was stated the wrong way round
 * until it was checked: `appOrigin()` CAN return an empty string, because it
 * strips every trailing slash — an origin of "/" normalises to "". The old
 * `?? "http://localhost:3000"` could not, since "/" is not nullish. So the term
 * is a real, if narrow, guard now where it was decorative before, and it should
 * stay. Whether the origin is *right* on a production deploy is enforced
 * where it can be: `requiredProdEnv` in scripts/vercel-build.mjs and the
 * production assertion in lib/env.ts, both of which fail the build.
 */
export function isBillingConfigured(): boolean {
  return Boolean(apiKey && LS_STORE_ID && LS_VARIANT_ID_TEAM && APP_URL);
}

/** The webhook additionally needs its signing secret. */
export function isWebhookConfigured(): boolean {
  return Boolean(LS_WEBHOOK_SECRET);
}
