/**
 * Web Push (VAPID) configuration. Key-driven and safe when unconfigured — with
 * no VAPID_* env vars set, isPushConfigured() is false and every send no-ops,
 * so the app runs fine without push.
 *
 * Generate a keypair once with:  npx web-push generate-vapid-keys
 * Then set (server): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * and (client, same public value): NEXT_PUBLIC_VAPID_PUBLIC_KEY.
 */

import webpush from "web-push";

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
// A mailto: (or https:) the push services can contact about our traffic.
const subject = process.env.VAPID_SUBJECT || "mailto:hello@founderflow.app";

if (publicKey && privateKey) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

/** True when both VAPID keys are present, so sends are possible. */
export function isPushConfigured(): boolean {
  return Boolean(publicKey && privateKey);
}

export { webpush };
