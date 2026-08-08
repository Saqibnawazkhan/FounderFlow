"use server";

/**
 * Web Push subscription lifecycle — the browser subscribes/unsubscribes on the
 * client and calls these to persist/remove the subscription server-side.
 * Scoped to the signed-in user; endpoints are unique per device.
 */

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { PushSubscriptionSchema } from "@/lib/schemas/push";
import { captureServerError } from "@/lib/sentry-server";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function savePushSubscriptionAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const parsed = PushSubscriptionSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid subscription" };
  const { endpoint, keys } = parsed.data;

  try {
    const ua = (await headers()).get("user-agent")?.slice(0, 300) ?? null;
    // Endpoint is globally unique. Upsert so re-subscribing (or a device that
    // changed hands via logout/login) reassigns to the current user.
    await db.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: session.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: ua,
      },
      update: { userId: session.user.id, p256dh: keys.p256dh, auth: keys.auth },
    });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "savePushSubscription" });
    return { success: false, error: "Couldn't enable push notifications right now." };
  }
}

export async function deletePushSubscriptionAction(endpoint: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };
  try {
    await db.pushSubscription.deleteMany({ where: { endpoint, userId: session.user.id } });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deletePushSubscription" });
    return { success: false, error: "Couldn't disable push notifications right now." };
  }
}
