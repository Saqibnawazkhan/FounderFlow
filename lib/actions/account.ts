"use server";

/**
 * Danger-zone server actions — the two irreversible operations that used to
 * be a GDPR/CCPA gap (now recoverable for 90 days via Tier 3 soft-delete).
 *
 *  1. `deleteAccountAction`  — "Delete my account"
 *  2. `deleteWorkspaceAction` — "Delete this workspace" (admin only)
 *
 * Both re-authenticate with a fresh password check inside the action even
 * though the caller already has a valid session cookie. A logged-in user
 * shouldn't be able to erase their data by accident; the password prompt
 * is the friction that makes the action deliberate.
 *
 * Soft-delete cascade:
 *   Instead of `db.company.delete()` we UPDATE a nullable `deletedAt`
 *   sentinel on Company + its child rows that carry the same column
 *   (Users, Projects, Tasks, Budgets, Transactions, Messages). Reads all filter
 *   `deletedAt: null`, so tombstoned rows disappear from the UI, the
 *   team list, mention pickers, and auth — but the physical rows stay
 *   for 90 days. `/api/cron/purge-soft-deleted` hard-deletes them after
 *   the window; nothing survives past that.
 *
 * Recovery within the window (ops, no user UI):
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<id>';
 *   UPDATE "User"    SET "deletedAt" = NULL WHERE "companyId" = '<id>';
 *   -- child rows share the same tombstone timestamp, so a range filter
 *   -- reunites them:
 *   UPDATE "Transaction" SET "deletedAt" = NULL
 *     WHERE "deletedAt" BETWEEN '<t - 1s>' AND '<t + 1s>';
 */

import bcrypt from "bcryptjs";
import { cancelSubscription } from "@lemonsqueezy/lemonsqueezy.js";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { DeleteAccountSchema, DeleteWorkspaceSchema } from "@/lib/schemas/account";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
// Importing from the config module (rather than reading process.env here) is
// also what runs `lemonSqueezySetup()` — the SDK is configured at that module's
// load, exactly as lib/actions/billing.ts relies on.
import { isBillingConfigured } from "@/lib/lemonsqueezy/config";
import { isTerminalSubscriptionStatus } from "@/lib/billing/plan";

import type { ActionResult } from "@/lib/actions/types";

/**
 * Delete the caller's User row.
 *
 * Since Tier 3 this is a SOFT delete — the row stays in Postgres with a
 * `deletedAt` timestamp so ops can recover within 90 days by clearing the
 * column. A nightly cron at /api/cron/purge-soft-deleted hard-purges rows
 * whose deletedAt is older than 90 days.
 *
 * Cascade semantics:
 *   - Sole-user branch (Abdul's solo-founder shape): tombstones the whole
 *     workspace so the recovery is one UPDATE per table.
 *   - Multi-user branch: only tombstones the leaving user. Their tasks +
 *     comments + activity + notifications survive so the workspace history
 *     stays intact for their teammates.
 *
 * Blocked case: sole-admin-with-teammates. Same guardrail as before —
 * promote another admin first, or delete the whole workspace.
 */
export async function deleteAccountAction(input: unknown): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DeleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { password } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "Account no longer exists" };

    const ok = await bcrypt.compare(password, me.passwordHash);
    if (!ok) return { success: false, error: "Password doesn't match" };

    const companyId = me.companyId;
    const otherUsers = await db.user.count({
      where: { companyId, id: { not: me.id }, deletedAt: null },
    });
    const otherAdmins = await db.user.count({
      where: { companyId, id: { not: me.id }, role: "admin", deletedAt: null },
    });

    const now = new Date();

    // Sole-user branch: tombstone the whole workspace (same cascade as the
    // admin-triggered workspace delete). Recovery is one UPDATE per table.
    if (otherUsers === 0) {
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: COMPANY_TEARDOWN_SELECT,
      });
      if (!company) return { success: false, error: "Workspace no longer exists" };

      // acct-013. THE SAME DESTRUCTION MUST ASK FOR THE SAME PROOF. For a solo
      // founder — FounderFlow's stated target user — this branch is the
      // workspace delete: it runs the byte-identical `softDeleteWorkspace`
      // cascade that `deleteWorkspaceAction` runs, over every transaction,
      // budget and task the business has. That path makes you type the
      // workspace name; this one asked for a password and showed copy whose
      // strongest word was "account", so the user's mental model afterwards was
      // "I removed my login" and they never asked for the 90-day restore.
      //
      // Enforced HERE, not only in the modal, because a server action is a POST
      // endpoint: UI friction that the action does not re-check is decoration.
      const typedName = readWorkspaceNameConfirmation(input);
      if (typedName === null || typedName.trim() !== company.name.trim()) {
        return {
          success: false,
          error:
            `You're the only person in "${company.name}", so deleting your account ` +
            `deletes the whole workspace — every transaction, task and budget. ` +
            `Type "${company.name}" exactly to confirm.`,
        };
      }

      // acct-002. Stop the money before tombstoning, never after: the sweep
      // below tombstones every user, and from that moment nobody can reach
      // "Manage billing" (createBillingPortalSessionAction needs a live session
      // AND company.deletedAt: null).
      const teardown = await cancelWorkspaceSubscription(company);
      if (!teardown.ok) return { success: false, error: teardown.error };

      const rowsTouched = await softDeleteWorkspace(companyId, now, teardown.billingWrite);
      warnBulkMutation(rowsTouched, {
        action: "deleteAccountAction.soleUser",
        userId: me.id,
        companyId,
        // Carried into the Sentry event so whoever reads the canary can see
        // what the sweep knowingly left untombstoned, without opening this
        // file. Empty today.
        extra: { softDeleteExcluded: SOFT_DELETE_EXCLUDED },
      });
      await signOut({ redirect: false });
      return { success: true, data: undefined };
    }

    if (me.role === "admin" && otherAdmins === 0) {
      return {
        success: false,
        error:
          "You're the only admin and there are still teammates in this workspace. " +
          "Promote another teammate to admin first, or delete the workspace instead.",
      };
    }

    // Multi-user branch: only tombstone the leaving user. Teammates still
    // see who created what — Project.supervisor and Task.assignee joins
    // still resolve because the row physically exists.
    //
    // acct-008: the tombstone hides them from the app, and `sendPushToUsers`
    // filters `user: { deletedAt: null }` — but their DEVICE registrations are
    // rows in their own right, with no tombstone of their own and no purge stage
    // that ever reaches them (the cron deliberately has no individual-user
    // stage). Someone who exercised their right to delete their account should
    // not keep a FounderFlow subscription alive on their phone, so the
    // registrations go, in the same transaction as the tombstone.
    await db.$transaction([
      db.user.update({
        where: { id: me.id },
        data: { deletedAt: now },
      }),
      db.pushSubscription.deleteMany({ where: { userId: me.id } }),
    ]);

    await signOut({ redirect: false });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, {
      action: "deleteAccountAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return {
      success: false,
      error: "Couldn't delete your account right now. Try again shortly.",
    };
  }
}

/**
 * Models that DO carry a `deletedAt` column but that this sweep deliberately
 * leaves live. Empty, and meant to stay that way.
 *
 * It is declared rather than implied so `tests/lib/db/purge-invariants.test.ts`
 * can derive the soft-deletable list from prisma/schema.prisma and check it
 * against this function. An entry here is a promise that the rows are
 * unreachable by some other means; write that reasoning next to it.
 */
const SOFT_DELETE_EXCLUDED: readonly string[] = [];

/* ─────────────────────────────────────────────────────────────────────────── */
/* Subscription teardown (acct-002)                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The billing columns a teardown decision reads, plus the name both
 * confirmations quote back at the user.
 */
const COMPANY_TEARDOWN_SELECT = {
  id: true,
  name: true,
  plan: true,
  subscriptionStatus: true,
  billingSubscriptionId: true,
} as const;

type CompanyTeardownRow = {
  name: string;
  plan: string | null;
  subscriptionStatus: string | null;
  billingSubscriptionId: string | null;
};

/** What the delete should write onto the Company row alongside the tombstone. */
type BillingTeardownWrite = { plan: "free"; subscriptionStatus: "cancelled" };

type SubscriptionTeardown =
  | { ok: true; billingWrite?: BillingTeardownWrite }
  | { ok: false; error: string };

/**
 * Read the optional workspace-name confirmation off a delete-account payload.
 *
 * `DeleteAccountSchema` validates the password and STRIPS unknown keys (zod's
 * default), so the extra field is read from the raw input rather than from the
 * parsed object. Deliberately not added to the schema as a required field: the
 * multi-user branch really does only remove the caller, and one password is the
 * right amount of friction there — the name is only demanded when the action is
 * about to erase a whole workspace.
 */
function readWorkspaceNameConfirmation(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as { workspaceName?: unknown }).workspaceName;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * acct-002. Cancel the workspace's LemonSqueezy subscription, or refuse the
 * delete.
 *
 * WHY REFUSING IS THE SAFE DIRECTION. Deleting the workspace tombstones every
 * user in it, and from then on there is no in-app route to billing at all:
 * `authorize()` rejects every account, and `createBillingPortalSessionAction`
 * additionally requires `company.deletedAt: null`. So a delete that leaves the
 * subscription running charges a real card, monthly, for a workspace the product
 * said was gone, and the customer's only remedy is a LemonSqueezy portal link in
 * an old email. An error message they can act on now beats a chargeback later.
 *
 * NOTHING TO CANCEL is a success, not a skip worth warning about: a workspace
 * that never subscribed has no `billingSubscriptionId`, and one that is already
 * `cancelled` / `expired` / `unpaid` will not be charged again.
 *
 * UNTESTED AGAINST THE LIVE PROVIDER. The call is the SDK's `cancelSubscription`
 * (the same package `lib/actions/billing.ts` uses for checkout), behind the same
 * `isBillingConfigured()` gate, so a deployment with no LemonSqueezy account is
 * unaffected. Its unit coverage is a fake in
 * tests/lib/actions/workspace-lifecycle.test.ts.
 */
async function cancelWorkspaceSubscription(
  company: CompanyTeardownRow
): Promise<SubscriptionTeardown> {
  const subscriptionId = company.billingSubscriptionId;
  if (!subscriptionId) return { ok: true };
  const status = company.subscriptionStatus;
  if (status === "cancelled" || isTerminalSubscriptionStatus(status)) {
    // Already stopped: LemonSqueezy will not charge it again, and asking it to
    // cancel a cancelled subscription is an error we would then have to ignore.
    return { ok: true };
  }

  if (!isBillingConfigured()) {
    // A subscription id with no way to reach the provider. Refusing is the only
    // honest answer — pretending the cancellation happened is how the workspace
    // disappears while the card keeps being charged.
    return {
      ok: false,
      error:
        `"${company.name}" has a live subscription and billing isn't reachable from ` +
        `this deployment, so it can't be cancelled here. Cancel it in LemonSqueezy ` +
        `first, then delete the workspace.`,
    };
  }

  try {
    const { error } = await cancelSubscription(subscriptionId);
    if (error) {
      captureServerError(error, {
        action: "cancelWorkspaceSubscription",
        extra: { subscriptionId, status },
      });
      return {
        ok: false,
        error:
          "Couldn't cancel this workspace's subscription, so nothing was deleted — " +
          "your card would have kept being charged. Try again in a moment, or cancel " +
          "from Manage billing first.",
      };
    }
  } catch (e) {
    captureServerError(e, {
      action: "cancelWorkspaceSubscription",
      extra: { subscriptionId, status },
    });
    return {
      ok: false,
      error:
        "Couldn't reach the billing provider to cancel this workspace's subscription, " +
        "so nothing was deleted. Try again in a moment.",
    };
  }

  // Written in the same transaction as the tombstone, so the row can never say
  // "team / active" about a workspace whose subscription we have just stopped.
  return { ok: true, billingWrite: { plan: "free", subscriptionStatus: "cancelled" } };
}

/**
 * Tombstone a company + every child row that carries a `deletedAt` sentinel
 * (Users, Projects, Tasks, Budgets, Transactions, Messages). Runs inside a
 * single Prisma $transaction so a partial failure never leaves half the
 * workspace tombstoned. Returns the total row count touched (for the
 * bulk-mutation canary).
 *
 * Message joined the soft-delete set on 2026-09-24 with the chat rollout and
 * this function did not follow it until 2026-09-25 — deleting a workspace left
 * every chat row live, with `deletedAt: null`, for the full 90-day retention
 * window. Nothing could read them (see below), so it was not an exposure; it
 * was a lie in the data. Anything that trusts the tombstone rather than the
 * session — an export, a support query, a future admin tool, the eventual GDPR
 * anonymization pass — would have walked straight past a "deleted" workspace's
 * messages.
 *
 * Channel, ChannelMember and MessageReaction are NOT tombstoned, and cannot be:
 * they have no `deletedAt` column at all. Channel's `archivedAt` is not a
 * substitute — it means "closed to new posts, history still readable", a
 * different thing, and writing it here would corrupt recovery (restoring the
 * workspace could not tell a channel archived by the sweep from one a human
 * archived last month). Leaving them live is safe for the same reason the
 * pre-existing skips below are: every chat read goes through
 * `requireScopedSession()`, and auth filters `deletedAt: null` on User, so a
 * tombstoned workspace has no session that can reach them. They die for real
 * when /api/cron/purge-soft-deleted hard-purges the Company.
 *
 * Skipped tables (no `deletedAt` column): Activity, Notification, Comment,
 * TimeEntry, RecurringRule, Channel, ChannelMember, MessageReaction. The nightly
 * purge deletes each of them by name when the parent Company is hard-purged.
 *
 * TWO tables are HARD-deleted here instead, because for those two "leave the row
 * and rely on the session filter" is not safe — they are credentials, not
 * history: InviteToken (acct-003) and PushSubscription (acct-008). See the
 * comments on each call.
 */
async function softDeleteWorkspace(
  companyId: string,
  now: Date,
  /**
   * Billing columns to write alongside the tombstone (acct-002). Present only
   * when the caller has just cancelled a live subscription, so the plan and the
   * cancellation land together or not at all.
   */
  billingWrite?: BillingTeardownWrite
): Promise<number> {
  const [txn, budget, task, project, message, invites, devices, user, company] =
    await db.$transaction([
      db.transaction.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      db.budget.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      db.task.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      db.project.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      // `deletedAt: null` is doing real work here, not just skipping no-ops: a
      // message a user deleted last week must keep ITS timestamp, so restoring
      // the workspace by the sweep's timestamp brings the thread back without
      // resurrecting the one message its author took down.
      db.message.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      // acct-003 / data-integrity-003. HARD-deleted, not tombstoned, and the row
      // has no `deletedAt` to tombstone anyway: an unused invite token is a live
      // SECRET, not history. `acceptInviteAction` now refuses a token whose company
      // carries a tombstone, but the token stayed valid in the database until its
      // own 7-day expiry — so the workspace was simultaneously "deleted" and
      // handing out credentials, and the 90-day purge would erase an account
      // somebody had just created. `removeUserAction` burns a removed teammate's
      // pending invites for exactly this reason (lib/actions/team.ts).
      //
      // `usedAt: null` scopes it to UNUSED tokens: a used one is the record that an
      // acceptance really happened, and it can no longer be redeemed.
      db.inviteToken.deleteMany({
        where: { companyId, usedAt: null },
      }),
      // acct-008 / data-integrity-004. Device registrations for every member,
      // reached through the relation. PushSubscription carries no tombstone, and
      // the purge cron has no individual-user stage, so without this the rows
      // outlive the workspace — and a push payload carries the notification title
      // and body verbatim, outside the app, where no session check applies.
      // `sendPushToUsers` also filters `user: { deletedAt: null }`; this is the
      // other half, so the registration is gone rather than merely unused.
      db.pushSubscription.deleteMany({
        where: { user: { companyId } },
      }),
      db.user.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      db.company.update({
        where: { id: companyId },
        // `billingWrite` is spread, not assigned key by key: absent means "leave
        // the billing columns alone", which is what a workspace that never
        // subscribed needs (bill-007 is the same lesson from the webhook side).
        data: { deletedAt: now, ...(billingWrite ?? {}) },
      }),
    ]);
  return (
    txn.count +
    budget.count +
    task.count +
    project.count +
    message.count +
    invites.count +
    devices.count +
    user.count +
    (company ? 1 : 0)
  );
}

/**
 * Delete the entire workspace and everything inside it — every user, every
 * transaction, every task. Admin-only, and requires typing the workspace
 * name exactly to guard against muscle-memory clicks.
 *
 * Since Tier 3 this is a SOFT delete via `softDeleteWorkspace()` — same
 * cascade the sole-user account-delete branch takes. Recovery in ops:
 *
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<id>';
 *   UPDATE "User" SET "deletedAt" = NULL WHERE "companyId" = '<id>';
 *   -- (repeat for Transaction/Task/Budget/Project/Message — they share the
 *   -- same tombstone timestamp so a range filter reunites them, and a
 *   -- range filter is what keeps individually-deleted messages deleted)
 *
 * The nightly cron at /api/cron/purge-soft-deleted hard-deletes rows past
 * the 90-day window; nothing is recoverable after that.
 */
export async function deleteWorkspaceAction(input: unknown): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return { success: false, error: "Not authenticated" };
  }
  if (session.user.role !== "admin") {
    return { success: false, error: "Only an admin can delete the workspace" };
  }

  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DeleteWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { password, workspaceName } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "Account no longer exists" };

    const ok = await bcrypt.compare(password, me.passwordHash);
    if (!ok) return { success: false, error: "Password doesn't match" };

    const company = await db.company.findUnique({
      where: { id: me.companyId },
      select: COMPANY_TEARDOWN_SELECT,
    });
    if (!company) {
      return { success: false, error: "Workspace no longer exists" };
    }
    // Case-sensitive on purpose. The confirmation is meant to be muscle-
    // memory friction, not a lenient guess.
    if (company.name.trim() !== workspaceName.trim()) {
      return {
        success: false,
        error: `Workspace name doesn't match. Type "${company.name}" exactly.`,
      };
    }

    // acct-002. Before anything is tombstoned: the sweep below takes every user
    // with it, and a tombstoned workspace has no path to billing at all, so this
    // is the last moment the subscription can be stopped from inside the product.
    // A provider failure refuses the whole delete rather than orphaning a live
    // subscription — see cancelWorkspaceSubscription.
    const teardown = await cancelWorkspaceSubscription(company);
    if (!teardown.ok) return { success: false, error: teardown.error };

    const now = new Date();
    const rowsTouched = await softDeleteWorkspace(me.companyId, now, teardown.billingWrite);
    warnBulkMutation(rowsTouched, {
      action: "deleteWorkspaceAction",
      userId: me.id,
      companyId: me.companyId,
      extra: { workspaceName: company.name, softDeleteExcluded: SOFT_DELETE_EXCLUDED },
    });
    await signOut({ redirect: false });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, {
      action: "deleteWorkspaceAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return {
      success: false,
      error: "Couldn't delete the workspace right now. Try again shortly.",
    };
  }
}

/**
 * What is "Delete my account" actually about to do, for THIS caller? (acct-013)
 *
 * The danger-zone modal cannot know. `deleteAccountAction` branches on whether
 * anybody else is still in the workspace, and for the sole member it runs the
 * whole-workspace cascade — so the dialog has to name the workspace and ask for
 * its name, and for everyone else it must not (the multi-user branch only removes
 * the caller). The page's props carry the company and the caller, never the
 * member count, so the modal asks for the one fact it is missing.
 *
 * Read-only, session-scoped, and it deliberately reports the SAME condition the
 * action enforces (`otherUsers === 0`, live members only) rather than a
 * lookalike: a dialog that asks for a name the action does not check, or checks
 * one the dialog never asked for, is how the two drift apart again.
 */
export async function describeAccountDeletionAction(): Promise<
  ActionResult<{ deletesWorkspace: boolean; workspaceName: string }>
> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const companyId = session.user.companyId;
    const [company, otherUsers] = await Promise.all([
      db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { name: true },
      }),
      db.user.count({
        where: { companyId, id: { not: session.user.id }, deletedAt: null },
      }),
    ]);
    if (!company) return { success: false, error: "Workspace no longer exists" };
    return {
      success: true,
      data: { deletesWorkspace: otherUsers === 0, workspaceName: company.name },
    };
  } catch (e) {
    captureServerError(e, {
      action: "describeAccountDeletionAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return { success: false, error: "Couldn't load your workspace details." };
  }
}
