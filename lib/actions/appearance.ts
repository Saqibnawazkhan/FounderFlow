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
import { writeAppearanceCookies } from "@/lib/appearance/cookies";
import { captureServerError } from "@/lib/sentry-server";

import type { ActionResult } from "@/lib/actions/types";

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
    // `select` on the UPDATE, not a second read, and both halves matter.
    //
    // The MERGED row is what the cookies need (i18n-002): this action accepts
    // either field alone — the topbar language toggle sends `{ locale }` and the
    // theme switch sends `{ theme }` — so writing only what was submitted would
    // leave the other cookie stale, or overwrite it with the coerced default and
    // flip a light-theme user to dark on their next cold load. Taking the values
    // from the update's own return is the same answer a re-read would give,
    // without a second round-trip and without a window in which another device's
    // write lands between the two queries.
    const row = await db.user.update({
      where: { id: session.user.id },
      data: {
        ...(parsed.data.theme ? { theme: parsed.data.theme } : {}),
        ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
      },
      select: { theme: true, locale: true },
    });
    // Republish to the pre-paint cookie so a NEW device — or this one after its
    // storage is cleared — paints in the chosen language and colour scheme
    // instead of flipping after hydration. Never throws; see the module header.
    await writeAppearanceCookies(row);
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
