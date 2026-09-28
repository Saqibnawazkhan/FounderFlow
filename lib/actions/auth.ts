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
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { sendVerificationEmail } from "@/lib/email/verification";
import { ensureGeneralChannel } from "@/lib/chat/bootstrap";
import { deriveHandle } from "@/lib/user/handle";

// Discriminated union so TS narrows `error` to `string` after `if (!success)`.
import type { ActionResult } from "@/lib/actions/types";

/**
 * The name the `add_projects` backfill used, and therefore the only name a new
 * workspace's first project can have without making older ones read
 * differently. `lib/schemas/task.ts` also documents that the task form
 * "auto-prefills with 'General' when there's no other context".
 */
const GENERAL_PROJECT_NAME = "General";

/**
 * The workspace's first Project — created WITH the workspace, in the signup
 * transaction (projects-001 / tasks-and-comments-007).
 *
 * WHY THIS EXISTS. `Task.projectId` is NOT NULL and `NewTaskSchema` requires it
 * ("Pick a project"). Exactly one thing had ever created a project for a
 * workspace: the one-shot backfill in
 * `prisma/migrations/20260526151502_add_projects/migration.sql`, which ran once,
 * against the companies that had tasks or budgets on 2026-05-26, and then never
 * again. A migration is a statement about the past. So a workspace created today
 * holds zero projects: `listProjectOptions()` returns [], the task form renders
 * a single dead `<option value="">No projects yet</option>`, and /tasks invites
 * the founder to "Create your first task" with a button that opens a form whose
 * submit cannot pass validation. An invited member hits a harder wall —
 * `canCreateProject` refuses them, so they wait for an admin. Budgets, which
 * also require a projectId, have the same hole.
 *
 * This is the SAME defect as the missing #general two statements above, and
 * lib/user/handle.ts already named the lesson: "a backfill without a write path
 * is a fix with an expiry date".
 *
 * IN THE TRANSACTION, for the reason `ensureGeneralChannel` spells out at
 * length: a workspace that COMMITS without the thing the product immediately
 * asks it to use is the bug, and there is nothing to lose by refusing to commit
 * one — the account does not exist yet, so a rollback costs this person a
 * retryable error page rather than data.
 *
 * NOT IDEMPOTENT, unlike `ensureGeneralChannel`, and the asymmetry is
 * deliberate. `Project` has no `@@unique([companyId, name])` index, so a
 * lookup-then-create here could not be a guarantee — only a slower way to be
 * wrong under a race. It does not need to be one either: `company` was created
 * one statement ago inside this transaction, so its project namespace is
 * provably empty. (Same argument the handle comment below makes about the email
 * index.) If this is ever called from a second place, that caller owns the
 * de-duplication.
 *
 * `status` and `color` are left to the schema defaults ("active", "emerald") so
 * this stays one statement with one decision in it; "active" is what keeps the
 * project out of `listProjectOptions`' `status: { not: "archived" }` filter.
 *
 * NO ACTIVITY ROW, for the same reason the bootstrap channel writes none:
 * nobody performed this action, and `ACTIVITY_META` is indexed without a
 * fallback. The signup already emits `company_created`.
 *
 * STILL OWED: workspaces created between the add_projects migration and this
 * fix have no project and nothing here heals them. That repair is a NEW
 * migration, the way `20260925130000_heal_missing_general_channels` healed the
 * channel-less ones — never an edit to an applied migration.
 */
async function createGeneralProject(
  tx: Pick<typeof db, "project">,
  companyId: string,
  founderId: string
): Promise<string> {
  const project = await tx.project.create({
    data: {
      companyId,
      name: GENERAL_PROJECT_NAME,
      description: "Where your first tasks and budgets live. Rename it or add more any time.",
      // The founder supervises and created it. `supervisorId` is what
      // `canSeeProject` reads, so a project supervised by nobody would be
      // invisible to the only person in the workspace.
      supervisorId: founderId,
      createdBy: founderId,
    },
    select: { id: true },
  });
  return project.id;
}

export async function signupAction(input: unknown): Promise<ActionResult> {
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, password, companyName, industry, currency } = parsed.data;

  // Signup-spam guard, BELOW the parse because the bucket is keyed on the
  // submitted address and that address does not exist until the input is
  // parsed. Safe to sit here: `safeParse` is pure, allocates nothing and
  // touches no database, so an unparseable flood still costs nothing — and it
  // can no longer spend a slot that belongs to a real signup, which is what
  // happened while the gate was above it.
  //
  // 15 per address per 10 minutes (a dozen teammates onboarding at once is
  // real) but a sustained rate three times lower than the old 5/min, because
  // sustained is what a script does — and each signup costs a bcrypt(12) and a
  // verification email against a capped Gmail account. Plus 5 per submitted
  // address, so one address cannot be hammered. See auth-007.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "signup", ip, email });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  // SECOND LAYER, and it has to be asked BEFORE the write rather than after.
  //
  // This action does not end at the gate above: its tail calls
  // `signIn("credentials")`, which runs `authorizeCredentials` ->
  // `gateLoginAttempt` -> `limiters.credentials`, a 5-per-60s bucket keyed on
  // the bare client address wherever that address is trusted (i.e. on Vercel).
  // The signup budget above is deliberately wider than that, so without this
  // check signups 6-15 inside a rolling minute would commit a Company, a User,
  // a General project and #general, send a verification email, and only THEN be
  // refused by signIn — answering "Account created but sign-in failed", with the
  // suggested recovery refused too, because `loginAction` checks this same
  // exhausted bucket. A post-write half-state is worse than the clean pre-write
  // refusal the old shared bucket happened to give.
  //
  // `kind: "login"` CHECKS both credential buckets and consumes nothing, so it
  // is exactly the question "would signIn refuse this?" and it does not spend
  // the budget `authorize()` is about to spend. It costs nothing when the
  // downstream has room, which is the ordinary case.
  const signInGate = gateAuthAction({ kind: "login", ip, email });
  if (!signInGate.allowed) {
    return { success: false, error: signInGate.error ?? "Too many requests" };
  }

  try {
    // Reject duplicate emails up front so the user sees a useful message
    // instead of a generic Prisma constraint violation.
    //
    // `findFirst` + an explicit `select` of the tombstone, because the honest
    // message depends on WHICH kind of duplicate this is (acct-001 / auth-006).
    // `User.email` is globally `@unique` and a soft-deleted row keeps its
    // address, so someone who deleted their own account was told "an account
    // with this email already exists" — while `authorize()`, which filters
    // `deletedAt: null`, told them their credentials were wrong. Three closed
    // doors and not one of them named the real reason.
    //
    // AND DELIBERATELY NOT `where: { email, deletedAt: null }`. That is the
    // one-line version of this fix and it is worse than the bug: the unique
    // index does not care about tombstones, so the lookup would miss the row,
    // the INSERT below would fail with P2002, and the catch-all would answer
    // "Couldn't create your account right now. The team has been notified." —
    // the same lockout wearing a server error. Releasing the address for reuse
    // is a real option but it is not this one; it needs a `priorEmail` column
    // to stay restorable, and it belongs to the delete path, not to signup.
    const existing = await db.user.findFirst({
      where: { email },
      select: { id: true, deletedAt: true },
    });
    if (existing?.deletedAt) {
      // No date in this message on purpose. The tombstone ages out only when
      // the purge cron runs for real, and `PURGE_ENABLED` is off by default by
      // documented decision (CLAUDE.md) — so "wait until <date>" would be the
      // second false promise in this flow rather than the fix for the first.
      return {
        success: false,
        error:
          "That email belongs to a FounderFlow account that was deleted. " +
          "Contact support to restore it, or sign up with a different email address.",
      };
    }
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
      // The workspace's first project, for the same reason and in the same
      // transaction — see createGeneralProject below.
      await createGeneralProject(tx, company.id, user.id);
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
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Email and password are required" };
  }
  const { email, password } = parsed.data;

  // CHECKS, NEVER CONSUMES — and that is load-bearing, not an optimisation.
  // This is the readable early error for the form; the COUNTING happens once,
  // inside authorize() (lib/auth/login-throttle.ts), which is the choke point
  // both this form and a direct POST to /api/auth/callback/credentials pass
  // through. loginAction -> signIn() -> authorize() is one user action crossing
  // two layers: if both consumed, one submission would spend two entries and
  // the five attempts a minute the copy promises would silently be two — a
  // founder with three typos locked out of their own product. `gateAuthAction`
  // enforces the check-only rule for `kind: "login"`; do not swap it for a
  // consume here.
  //
  // Below the parse because the buckets are keyed on the submitted address as
  // well as the client address — a distributed spray at one known founder's
  // email is invisible to an IP bucket of any size.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "login", ip, email });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

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
