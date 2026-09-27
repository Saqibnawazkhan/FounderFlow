"use server";

/**
 * Write side of the notification-preferences matrix (FaultsAudit S9).
 *
 * Self-scoped only — there is no "edit someone else's notification settings"
 * path, not even for an admin, so the signed-in user id is the only one we
 * trust. That also means there is no authz predicate to consult beyond being
 * signed in.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import { resolveChannels } from "@/lib/notify/preferences";
import { UpdateNotificationPreferenceSchema } from "@/lib/schemas/notification-preference";

import type { ActionResult } from "@/lib/actions/types";

/**
 * Flip one channel for one event.
 *
 * Upserts rather than updates: most people have no stored row (absent means
 * "use the defaults"), so the first flip of any switch is an insert. The row
 * is written with ALL three channels resolved — the two the user did not touch
 * are persisted at whatever they were showing, so a later change to
 * DEFAULT_CHANNELS cannot silently move a switch someone has already seen.
 */
export async function updateNotificationPreferenceAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = UpdateNotificationPreferenceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid preference" };
  }
  const { event, channel, enabled } = parsed.data;
  const userId = session.user.id;

  try {
    const existing = await db.notificationPreference.findUnique({
      where: { userId_event: { userId, event } },
      select: { event: true, inApp: true, email: true, push: true },
    });

    const next = { ...resolveChannels(event, existing), [channel]: enabled };

    await db.notificationPreference.upsert({
      where: { userId_event: { userId, event } },
      create: { userId, event, ...next },
      update: next,
    });

    revalidatePath("/settings");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateNotificationPreferenceAction" });
    return { success: false, error: "Couldn't save that preference right now." };
  }
}
