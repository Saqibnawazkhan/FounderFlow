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
import { sendVerificationEmail } from "@/lib/email/verification";
import { ensureGeneralChannel } from "@/lib/chat/bootstrap";
import { deriveHandle } from "@/lib/user/handle";

// Discriminated union so TS narrows `error` to `string` after `if (!success)`.
import type { ActionResult } from "@/lib/actions/types";

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
  const { name, email, password, companyName, industry, currency } = parsed.data;

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
    const createdUser = await db.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { name: companyName, industry, currency },
      });
      const user = await tx.user.create({
        data: {
          name,
          email,
          // The founder's @mention address, written at birth because nothing
          // else in the product ever would. `20260925140000_add_user_handle`
          // backfilled the users who existed when it ran and, being a
          // migration, is a statement about the past only — a row that commits
          // without a handle stays NULL forever, and NULLS DISTINCT means the
          // unique index never complains about it. The founder would simply be
          // unmentionable in their own workspace with nothing saying why:
          // FaultsAudit T16, reintroduced for every account created after the
          // migration landed. Same lesson as `ensureGeneralChannel` below, so
          // it is in the same transaction for the same reason.
          //
          // NO DE-DUPLICATION AND NO P2002 RETRY HERE, unlike
          // `acceptInviteAction`, and the asymmetry is the point: `company` was
          // created one statement ago inside this transaction, so it holds no
          // other user and `@@unique([companyId, handle])` is scoped to that
          // brand-new companyId. The handle namespace is provably empty.
          // Loading a taken-set that can only come back empty, and retrying a
          // race that has no second party, would be code no test could ever
          // exercise. `uniqueHandle` is the invite path's job.
          //
          // So a P2002 out of THIS create is the email index, not this one —
          // the duplicate-email pre-check above and the catch-all below own
          // that case. And if a future change ever adds a second user to this
          // transaction, the index fails the signup loudly instead of writing a
          // NULL, which is the right failure and the cue to give this path the
          // invite path's de-duplication.
          handle: deriveHandle(email),
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
      // Chat's #general, with the founder as its owner.
      //
      // IN the transaction, not after it, and that is the whole fix. Chat
      // shipped on 2026-09-24 with a migration that backfilled one #general
      // per EXISTING workspace and nothing that created one afterwards, so
      // every account opened since then has landed on an empty chat. A
      // workspace that commits without its channel is that bug, and there is
      // nothing to lose by refusing to commit one: the account does not exist
      // yet, so a rollback costs this person a retryable error page rather
      // than any data. Contrast the verification email below, which is
      // deliberately fire-and-forget OUTSIDE the transaction because a slow
      // SMTP host must never cost someone their signup — the email is
      // resendable from the in-app banner; a missing channel is not
      // re-creatable by anything in the product.
      //
      // No Activity row for it: `ActivityType` is a closed union whose
      // ACTIVITY_META record is indexed without a fallback, so an unknown type
      // throws in the /activities UI. See the header of lib/actions/chat.ts.
      await ensureGeneralChannel(tx, company.id, user.id);
      return user;
    });

    // Fire the email-verification link. Fire-and-forget OUTSIDE the signup
    // transaction — a slow or failing SMTP send must never roll back the
    // account, and the user can always resend from the in-app banner. We log
    // failures so a stuck credential is visible.
    void sendVerificationEmail({ userId: createdUser.id, name, email }).catch((e: unknown) =>
      captureServerError(e, {
        action: "signupAction.sendVerification",
        extra: { userId: createdUser.id },
      })
    );

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

    return { success: true, data: undefined };
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
    return { success: true, data: undefined };
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
    return { success: true, data: undefined };
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
