"use server";

/**
 * Appearance preferences (S6). Persists the user's theme + locale to their
 * User row so the choice follows them across devices instead of living only
 * in one browser's localStorage. The client store stays the fast-paint cache;
 * these actions are the durable source of truth.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

const ThemeEnum = z.enum(["light", "dark"]);
const LocaleEnum = z.enum(["en", "ur"]);

const UpdateAppearanceSchema = z
  .object({
    theme: ThemeEnum.optional(),
    locale: LocaleEnum.optional(),
  })
  .refine((v) => v.theme !== undefined || v.locale !== undefined, {
    message: "Nothing to update",
  });

export async function updateAppearanceAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const parsed = UpdateAppearanceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid preference" };
  }

  try {
    await db.user.update({
      where: { id: session.user.id },
      data: {
        ...(parsed.data.theme ? { theme: parsed.data.theme } : {}),
        ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
      },
    });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateAppearanceAction" });
    return { success: false, error: "Couldn't save your preference right now." };
  }
}

export async function getMyAppearanceAction(): Promise<
  ActionResult<{ theme: "light" | "dark"; locale: "en" | "ur" }>
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  try {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { theme: true, locale: true },
    });
    if (!user) return { success: false, error: "User not found" };
    // Coerce defensively — legacy rows or a bad manual write shouldn't break
    // the client. Fall back to the app defaults.
    const theme = user.theme === "light" ? "light" : "dark";
    const locale = user.locale === "ur" ? "ur" : "en";
    return { success: true, data: { theme, locale } };
  } catch (e) {
    captureServerError(e, { action: "getMyAppearanceAction" });
    return { success: false, error: "Couldn't load your preferences." };
  }
}
