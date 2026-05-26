"use server";

/**
 * Auth server actions. Replace the localStorage-based signup/login that
 * lived in the Zustand store with real Prisma + bcrypt + Auth.js (closes
 * audit flaws #1, #2, #5).
 *
 * - signupAction: validates input with zod, hashes the password with bcrypt,
 *   creates Company + User atomically, then sets the Auth.js session cookie
 *   via signIn("credentials", ...). UI redirects to /dashboard on success.
 * - loginAction: thin wrapper around signIn so we can return a typed result
 *   instead of letting NextAuth throw a redirect.
 *
 * Both return { success: boolean; error?: string }. UI calls them with
 * useTransition for the loading state.
 */

import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { LoginSchema, SignupSchema } from "@/lib/schemas/auth";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";

// Discriminated union so TS narrows `error` to `string` after `if (!success)`.
// The previous shape `{ success: boolean; error?: string }` left error
// typed `string | undefined` everywhere, forcing callers into `error ??
// "fallback"` boilerplate (or worse, dropping the message entirely).
export type ActionResult = { success: true } | { success: false; error: string };

export async function signupAction(input: unknown): Promise<ActionResult> {
  // Brute-force / signup-spam guard. 5/min/IP — covers a tab-spam attacker
  // but is well above any human signup rate.
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, password, companyName, industry } = parsed.data;

  try {
    // Reject duplicate emails up front so the user sees a useful message
    // instead of a generic Prisma constraint violation.
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return { success: false, error: "An account with this email already exists" };
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Two-step inside a transaction to break the User <-> Company circular FK
    // (Company.ownerId is nullable; we backfill it after the user is created).
    await db.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { name: companyName, industry, currency: "PKR" },
      });
      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
          role: "admin",
          companyId: company.id,
        },
      });
      await tx.company.update({
        where: { id: company.id },
        data: { ownerId: user.id },
      });
      await tx.activity.create({
        data: {
          companyId: company.id,
          type: "company_created",
          message: `${name} created the company "${companyName}"`,
          userId: user.id,
          userName: name,
        },
      });
    });

    // signIn with redirect:false so the caller controls the navigation; if
    // we let it redirect, the server action throws and the client never gets
    // the success result.
    try {
      await signIn("credentials", { email, password, redirect: false });
    } catch (e) {
      if (e instanceof AuthError) {
        return { success: false, error: "Account created but sign-in failed. Try logging in." };
      }
      throw e;
    }

    return { success: true };
  } catch (e) {
    // Catch-all so the client never sees an unhandled rejection (which would
    // hang the loading spinner). Prisma connection failures, missing env vars,
    // etc. all funnel through here. Sentry captures the full stack with tags.
    captureServerError(e, { action: "signupAction" });
    return {
      success: false,
      error: "Couldn't create your account right now. The team has been notified.",
    };
  }
}

export async function loginAction(input: unknown): Promise<ActionResult> {
  // Same auth bucket as signup — 5 failed credential attempts per IP per
  // minute is the classic brute-force threshold.
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Email and password are required" };
  }
  const { email, password } = parsed.data;

  try {
    await signIn("credentials", { email, password, redirect: false });
    return { success: true };
  } catch (e) {
    if (e instanceof AuthError) {
      return { success: false, error: "Invalid email or password" };
    }
    captureServerError(e, { action: "loginAction" });
    return { success: false, error: "Couldn't sign you in right now. Try again." };
  }
}

export async function logoutAction(): Promise<ActionResult> {
  try {
    await signOut({ redirect: false });
    return { success: true };
  } catch (e) {
    // signOut throws on session-cookie-write failure (e.g., Auth.js DB
    // adapter issue). The CLIENT used to clear local Zustand regardless,
    // which left the user "logged out" in the UI but still authenticated
    // server-side — next reload put them back in. Surface failure so
    // callers can keep the local state intact and toast an error.
    captureServerError(e, { action: "logoutAction" });
    return { success: false, error: "Couldn't sign you out. Try again." };
  }
}
