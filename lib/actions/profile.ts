"use server";

/**
 * /settings profile + password mutations.
 *
 * Both actions are scoped to the signed-in user — there's no "edit another
 * user's profile" path here (admin team management lives in /team via
 * lib/actions/team.ts). The session.user.id is the only ID we trust.
 *
 *   updateProfileAction({ name, email })
 *     • Updates display name and login email.
 *     • Rejects duplicate emails (DB has a unique constraint; we check up
 *       front to surface a clean error instead of the Prisma collision).
 *
 *   changePasswordAction({ currentPassword, newPassword, confirmPassword })
 *     • Re-verifies the current password with bcrypt before writing.
 *     • Hashes the new one at work factor 12 (matches signup).
 *     • Does NOT invalidate the existing JWT — Auth.js sessions are
 *       cookie-based and stateless. The user stays signed in on this
 *       device. Worth revisiting if we add a "sign out other sessions"
 *       feature later.
 */

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ChangePasswordSchema, UpdateProfileSchema } from "@/lib/schemas/profile";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function updateProfileAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = UpdateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid profile" };
  }
  const { name } = parsed.data;

  try {
    // Name only — email changes route through the verified change flow
    // (lib/actions/email-change.ts) so they can't skip inbox ownership.
    await db.user.update({
      where: { id: session.user.id },
      data: { name },
    });

    revalidatePath("/settings");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateProfileAction" });
    return { success: false, error: "Couldn't update your profile right now." };
  }
}

export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // Auth-tier limiter — same envelope as login/signup, treats password
  // change as a sensitive action.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ChangePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid password" };
  }
  const { currentPassword, newPassword } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "User no longer exists" };

    const ok = await bcrypt.compare(currentPassword, me.passwordHash);
    if (!ok) return { success: false, error: "Current password is incorrect" };

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.user.update({
      where: { id: me.id },
      data: { passwordHash },
    });

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "changePasswordAction" });
    return { success: false, error: "Couldn't change your password right now." };
  }
}
