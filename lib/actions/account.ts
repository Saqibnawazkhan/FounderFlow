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
 *   (Users, Projects, Tasks, Budgets, Transactions, Messages, Comments,
 *   TimeEntries — nine models in all, counting Company). Reads all filter
 *   `deletedAt: null`, so tombstoned rows disappear from the UI, the
 *   team list, mention pickers, and auth — but the physical rows stay
 *   for 90 days. `/api/cron/purge-soft-deleted` hard-deletes them after
 *   the window; nothing survives past that.
 *
 * Recovery within the window (ops, no user UI). BOTH clauses on every child
 * table — this is data-integrity-005 and the workspace id is the half that was
 * missing:
 *
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<companyId>';
 *   UPDATE "User"    SET "deletedAt" = NULL WHERE "companyId" = '<companyId>';
 *   -- Repeat for Project / Task / Budget / Transaction / Comment / TimeEntry /
 *   -- Message. `<exact t>` is the single instant softDeleteWorkspace stamped.
 *   UPDATE "Transaction" SET "deletedAt" = NULL
 *     WHERE "companyId" = '<companyId>' AND "deletedAt" = '<exact t>';
 *
 * WHY BOTH, AND WHY NOT A RANGE (data-integrity-005). The timestamp alone was a
 * CROSS-TENANT WRITE. `softDeleteWorkspace` stamps one `now` across all seven
 * updateMany calls inside one $transaction, so every row of a deleted workspace
 * shares that instant to the millisecond — and two workspaces deleted in the
 * same second are then indistinguishable to a `deletedAt`-only filter. The old
 * `BETWEEN '<t - 1s>' AND '<t + 1s>'` widened that to a two-second window for no
 * benefit. Running it restored another customer's transactions, tasks and budgets
 * into a workspace whose Company row stays tombstoned, where neither they nor
 * support can see or re-delete them: the safety net performing the worst kind of
 * write, at the moment whoever is running it is under the most pressure.
 *
 * The timestamp still has to be there, though — dropping it and restoring by
 * `companyId` alone would resurrect the messages and comments individual authors
 * deleted BEFORE the workspace was, which carry their own earlier tombstones and
 * which softDeleteWorkspace's `deletedAt: null` filter deliberately left alone.
 * Tenant AND instant. `tests/lib/db/restore-runbook.test.ts` enforces it.
 */

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { cancelSubscription } from "@lemonsqueezy/lemonsqueezy.js";
import { auth, signOut } from "@/lib/auth";
import { clearAppearanceCookies } from "@/lib/appearance/cookies";
import { db } from "@/lib/db";
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { DeleteAccountSchema, DeleteWorkspaceSchema } from "@/lib/schemas/account";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { sendSecurityNotice, sendSecurityNotices } from "@/lib/email/templates/security-notice";
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
 *   - Multi-user branch: only tombstones the leaving user, and adds ONE row —
 *     a `user_removed` activity saying they closed their own account (acct-019),
 *     written in the same transaction as the tombstone. Their tasks + comments +
 *     activity + notifications survive so the workspace history stays intact for
 *     their teammates.
 *
 * Blocked case: sole-admin-with-teammates. Same guardrail as before —
 * promote another admin first, or delete the whole workspace.
 */
export async function deleteAccountAction(input: unknown): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // Password-confirmed destruction: 10 per client address / 10 min, 5 per USER
  // / 10 min (auth-007). The per-user bucket is the real one — this is an
  // authenticated action, so the account is always known, and keying the budget
  // to it means an office sharing one address can never block each other from
  // closing their own accounts, while a hijacked session still gets only five
  // password guesses. It used to be the 5/min bucket shared with login, signup,
  // reset and both verification links.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "destructive", ip, userId: session.user.id });
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

      // acct-005. The receipt — and for this branch it is a WORKSPACE receipt,
      // not an account one, because that is what just happened (acct-013 is the
      // same observation about the confirmation copy). It carries the 90-day
      // recovery deadline and how to ask for a restore, which is the thing a
      // customer needs and the thing no channel was delivering. One recipient by
      // construction: this branch only runs when `otherUsers === 0`, so `me` IS
      // the workspace's only live member.
      await sendSecurityNotice({
        kind: "workspace-deleted",
        to: me.email,
        recipientName: me.name,
        accountEmail: me.email,
        workspaceName: company.name,
        deletedAt: now,
      });

      await signOut({ redirect: false });
      // i18n-002: the account is gone, so its year-long appearance cookies must
      // go with it - otherwise the next person on a shared browser paints in a
      // deleted user's language before hydration. Only reached when signOut
      // resolved, which is also when the session cookie was actually cleared.
      await clearAppearanceCookies();
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
    //
    // acct-019. The workspace survives this delete, so the workspace owes itself
    // a record of it. `removeUserAction` writes a `user_removed` row when an
    // ADMIN deactivates someone (lib/actions/team.ts); the self-delete path wrote
    // nothing, and the two outcomes are indistinguishable afterwards: the person
    // drops off the active roster and reappears in /team's admin-only
    // "Deactivated" panel, with a "Reactivate" button. So an admin could restore
    // an account its owner had deliberately closed, and no surface anywhere said
    // who closed it. The row reuses `user_removed` — its label ("Member removed")
    // and danger tone already exist, and the cause lives in the message, which is
    // what /activities actually renders.
    //
    // Inside the transaction, not after it: a feed row without a tombstone says
    // someone left who is still here, and a tombstone without a feed row is this
    // finding. Note the array form of $transaction — this is a promise in the
    // array, not an awaited call.
    await db.$transaction([
      db.user.update({
        where: { id: me.id },
        data: { deletedAt: now },
      }),
      db.pushSubscription.deleteMany({ where: { userId: me.id } }),
      db.activity.create({
        data: {
          companyId,
          type: "user_removed",
          message: `${me.name} deleted their own account`,
          userId: me.id,
          userName: me.name,
          // Same `kind: "user"` shape team.ts writes, so nothing downstream has
          // to learn a new variant (lib/types.ts ActivityMetadata).
          metadata: JSON.stringify({ kind: "user", invitedUser: me.name, role: me.role }),
        },
      }),
    ]);

    // The feed row is only worth writing if teammates' cached pages refetch it.
    // `removeUserAction` revalidates both of these after the identical writes;
    // this path revalidated nothing, so a teammate's roster could keep listing
    // the person who just left.
    revalidatePath("/team");
    revalidatePath("/activities");

    // acct-005. The leaving member's own receipt. The workspace survives, so
    // this notice is deliberately about the ACCOUNT and says nothing about the
    // workspace's data — but it carries the same 90-day deadline, because the
    // tombstone this branch writes is what the purge cron counts from.
    await sendSecurityNotice({
      kind: "account-deleted",
      to: me.email,
      recipientName: me.name,
      accountEmail: me.email,
      deletedAt: now,
    });

    // data-integrity-009. "The workspace survives this delete" is what the branch
    // above assumes, and under two concurrent self-deletes it was false. Asked
    // AFTER the tombstone has committed, because that is the only moment the
    // answer can be trusted — see tombstoneAbandonedWorkspace for why a
    // transaction cannot prevent the race and why the end state is what gets
    // fixed. A no-op on every ordinary delete.
    await tombstoneAbandonedWorkspace(companyId, me, now);

    await signOut({ redirect: false });
    // i18n-002: the account is gone, so its year-long appearance cookies must
    // go with it - otherwise the next person on a shared browser paints in a
    // deleted user's language before hydration. Only reached when signOut
    // resolved, which is also when the session cookie was actually cleared.
    await clearAppearanceCookies();
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
/**
 * data-integrity-009 — repair a workspace whose last live member has just left.
 *
 * THE RACE. `deleteAccountAction` counts other live users and other live admins,
 * then writes its tombstone on a separate statement. Two admins submitting
 * together each read `otherUsers = 1, otherAdmins = 1`, both pass the sole-admin
 * guard, and both tombstone themselves. The terminal state was
 * `Company.deletedAt = null` with zero live users, and every exit from it was
 * closed: the Credentials provider refuses every tombstoned user, so nobody signs
 * in; `getDeactivatedUsers` / `reactivateUserAction` are admin-only and there is
 * no live admin to call them; and the purge cron only looks at companies whose
 * `deletedAt` is SET, so the rows were simultaneously unreachable and
 * unpurgeable — sitting there for ever, which is also a retention failure for a
 * customer who asked to be erased.
 *
 * WHY THIS AND NOT "PUT THE COUNT IN THE TRANSACTION". A transaction does not
 * close this race. At READ COMMITTED both transactions read the same committed
 * rows, neither sees the other's uncommitted tombstone, and both commit. Refusing
 * the LOSER would need a row lock — `SELECT … FOR UPDATE` on the Company row, in
 * raw SQL — and that is a heavier change than this outcome justifies, because both
 * admins genuinely intended to leave. What is unacceptable is the END STATE, so
 * that is what this fixes: the workspace ends up tombstoned, exactly as the
 * sole-user branch would have left it, recoverable for 90 days by the runbook in
 * this file's header and collectable by the purge.
 *
 * THE CLAIM IS THE MUTEX. `company.updateMany({ where: { id, deletedAt: null } })`
 * is a single conditional statement, so exactly one caller can win it however many
 * notice the empty workspace. That matters beyond tidiness: the subscription
 * cancellation below is an outbound call, and asking LemonSqueezy to cancel an
 * already-cancelled subscription is an error we would then have to ignore — which
 * is how a real failure gets swallowed.
 *
 * ORDER, AND THE ONE PLACE IT DISAGREES WITH acct-002. acct-002's rule is "stop
 * the money BEFORE tombstoning", because nobody can reach Manage billing
 * afterwards. Here the members are already gone — that door shut before this
 * function was called — so the claim has to come first to keep the outbound call
 * single. And if the cancellation then fails we do NOT abort: the tombstone has
 * landed, and a tombstoned workspace with a live subscription is recoverable by a
 * human in the LemonSqueezy dashboard, whereas a live workspace with no members is
 * recoverable by nobody. The failure is raised to Sentry loudly, because a card
 * still being charged is the expensive half.
 *
 * Returns true when this call performed the repair.
 */
async function tombstoneAbandonedWorkspace(
  companyId: string,
  leaver: { id: string; name: string; email: string },
  now: Date
): Promise<boolean> {
  const liveLeft = await db.user.count({ where: { companyId, deletedAt: null } });
  if (liveLeft > 0) return false;

  const claim = await db.company.updateMany({
    where: { id: companyId, deletedAt: null },
    data: { deletedAt: now },
  });
  if (claim.count !== 1) return false;

  // Worth knowing about even though it is now handled: it means two people
  // submitted a self-delete inside the same moment, and the sole-admin guard did
  // not hold. If this fires often, the row lock above becomes worth its cost.
  captureServerError(
    new Error(
      `Workspace ${companyId} lost its last live member to a concurrent self-delete; ` +
        `tombstoned it rather than leaving it unreachable`
    ),
    { action: "deleteAccountAction.abandonedWorkspace", userId: leaver.id, companyId }
  );

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: COMPANY_TEARDOWN_SELECT,
  });
  let billingWrite: BillingTeardownWrite | undefined;
  if (company) {
    const teardown = await cancelWorkspaceSubscription(company);
    if (teardown.ok) {
      billingWrite = teardown.billingWrite;
    } else {
      captureServerError(
        new Error(
          `Abandoned workspace ${companyId} was tombstoned but its subscription could ` +
            `not be cancelled: ${teardown.error} — the card is still being charged`
        ),
        { action: "deleteAccountAction.abandonedWorkspace.billing", companyId }
      );
    }
  }

  const rowsTouched = await softDeleteWorkspace(companyId, now, billingWrite);
  warnBulkMutation(rowsTouched, {
    action: "deleteAccountAction.abandonedWorkspace",
    userId: leaver.id,
    companyId,
    extra: { softDeleteExcluded: SOFT_DELETE_EXCLUDED },
  });

  // The account receipt the caller already gets says nothing about the
  // workspace's data. This one carries the 90-day restore route, which is now the
  // only way anybody gets back in.
  await sendSecurityNotice({
    kind: "workspace-deleted",
    to: leaver.email,
    recipientName: leaver.name,
    accountEmail: leaver.email,
    workspaceName: company?.name ?? "your workspace",
    deletedAt: now,
  });
  return true;
}

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
 * (Users, Projects, Tasks, Budgets, Transactions, Messages, Comments,
 * TimeEntries — the full set is derived from prisma/schema.prisma by
 * tests/lib/db/purge-invariants.test.ts, which fails the day a tenth model
 * gains the column and this function does not follow). Runs inside a
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
 * Skipped tables (no `deletedAt` column, so there is nothing for this sweep to
 * write): Activity, Notification, RecurringRule, Channel, ChannelMember,
 * MessageReaction, BillingEvent, NotificationPreference. The nightly purge
 * deletes the first seven by name when the parent Company is hard-purged, and
 * NotificationPreference cascades off the user delete in the same transaction.
 *
 * acct-012: this list used to name Comment and TimeEntry as well. Both gained a
 * `deletedAt` column with data-integrity-001 and both are swept by
 * `softDeleteWorkspace` below, so the sentence was false about a safety
 * mechanism in exactly the
 * way this repo keeps being false about one — it told the next reader those rows
 * COULD not be tombstoned, next to the code that tombstones them. The claim is
 * now derived from the schema instead of remembered:
 * tests/lib/actions/workspace-lifecycle.test.ts fails if any table named here
 * turns out to carry the column.
 *
 * Leaving those eight live for the retention window is deliberate, and
 * deliberately NOT fixed by adding eight more `deletedAt` columns. Every read of
 * them goes through `requireScopedSession()`, which cannot resolve for a
 * workspace whose Users are all tombstoned; the one background writer that could
 * still act on a live RecurringRule already filters
 * `company: { deletedAt: null }` (app/api/cron/materialize-recurring); and the
 * one delivery channel that bypasses the session entirely, PushSubscription, is
 * hard-deleted below rather than skipped. Eight nullable columns would buy
 * nothing and create eight new places to forget a filter.
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
  const [txn, budget, task, project, message, comment, timeEntry, invites, devices, user, company] =
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
      // Comment and TimeEntry gained tombstones with data-integrity-001, so
      // they join the sweep. They carry the SAME timestamp as every sibling
      // above, which is what makes CLAUDE.md's published recovery work: one
      // range filter on `deletedAt` reunites a whole workspace. Left out, a
      // restored workspace would come back with every comment and every logged
      // hour still marked live while the rows they hang off were tombstoned —
      // and the `deletedAt: null` filter is load-bearing for the same reason it
      // is on `message`: a comment its author deleted last week must keep ITS
      // own timestamp, so a restore does not resurrect it.
      db.comment.updateMany({
        where: { companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      db.timeEntry.updateMany({
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
    // Comment and TimeEntry gained tombstones with data-integrity-001. They
    // belong in this sum for the same reason every sibling does: warnBulkMutation
    // thresholds on it, so a row missing here is erased from the ALERT rather than
    // from the database — which is the under-count this route's own header calls
    // the real harm of the missing chat tables.
    comment.count +
    timeEntry.count +
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
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<companyId>';
 *   UPDATE "User" SET "deletedAt" = NULL WHERE "companyId" = '<companyId>';
 *   -- Repeat for Transaction/Task/Budget/Project/Message/Comment/TimeEntry,
 *   -- with BOTH clauses every time (data-integrity-005):
 *   UPDATE "Transaction" SET "deletedAt" = NULL
 *     WHERE "companyId" = '<companyId>' AND "deletedAt" = '<exact t>';
 *
 * The timestamp is what keeps individually-deleted messages deleted; the
 * companyId is what keeps the restore inside one tenant. This used to carry only
 * the first, which made it a cross-tenant write — see the file header for the
 * full argument, and tests/lib/db/restore-runbook.test.ts for the guard.
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

  // Same destructive class as deleteAccountAction above, keyed on the admin
  // doing it rather than on the office they are sitting in (auth-007).
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "destructive", ip, userId: session.user.id });
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

    // acct-005. READ THE RECIPIENTS BEFORE THE SWEEP, and after the teardown
    // check so a refused delete mails nobody. One line later every one of these
    // rows carries a tombstone, and `deletedAt: null` matches nobody — so the
    // same query run afterwards returns an empty list and the notice goes
    // nowhere, silently, which is the exact shape of the bug being fixed.
    // Everyone here loses their workspace, not just the admin who pressed the
    // button, so everyone gets the deadline and the way to ask for a restore.
    const members = await db.user.findMany({
      where: { companyId: me.companyId, deletedAt: null },
      select: { name: true, email: true },
    });

    const now = new Date();
    const rowsTouched = await softDeleteWorkspace(me.companyId, now, teardown.billingWrite);
    warnBulkMutation(rowsTouched, {
      action: "deleteWorkspaceAction",
      userId: me.id,
      companyId: me.companyId,
      extra: { workspaceName: company.name, softDeleteExcluded: SOFT_DELETE_EXCLUDED },
    });

    await sendSecurityNotices(members, {
      kind: "workspace-deleted",
      workspaceName: company.name,
      deletedAt: now,
    });

    await signOut({ redirect: false });
    // i18n-002: the account is gone, so its year-long appearance cookies must
    // go with it - otherwise the next person on a shared browser paints in a
    // deleted user's language before hydration. Only reached when signOut
    // resolved, which is also when the session cookie was actually cleared.
    await clearAppearanceCookies();
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
