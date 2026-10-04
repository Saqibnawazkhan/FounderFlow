"use server";

/**
 * Comment server actions: create, delete, list.
 *
 * Permissions:
 *  - A TASK thread follows the task's own visibility: assignee, creator,
 *    supervisor of its project, or admin/cofounder. `mayAccessTaskThread`
 *    (lib/comments/task-access.ts) is that predicate, shared with the read
 *    query's `mayReadTarget` so the write and the read state one rule
 *    (tasks-and-comments-015 — this used to be a bare company check, so a
 *    member could post into a thread they were refused when reading).
 *  - A TRANSACTION thread needs `canSeeFinances`, on both paths.
 *  - Only the comment author OR a company admin can delete a comment.
 *
 * @mentions: parsed server-side against the company user list (never trust
 * the client). Each unique mentioned user (minus the author) gets a single
 * Notification with a deep link back to the target. The notification fan-out
 * runs OUTSIDE the comment's transaction — a slow / failing notification
 * write shouldn't poison the comment.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewCommentSchema, DeleteCommentSchema } from "@/lib/schemas/comment";
import { extractMentions } from "@/lib/comments/mentions";
import { mayAccessTaskThread } from "@/lib/comments/task-access";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import {
  listCommentsForTarget,
  type CommentClient,
  type CommentTarget,
} from "@/lib/queries/comments";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/**
 * Which ledger page lists a row of this `Transaction.type`.
 *
 * All three ledgers render the same table and, since transactions-ledger-016,
 * the same per-row comment control — but each client filters `transactions` to
 * ONE type, so a deep link has to name the page that actually holds the row.
 *
 * Unknown types fall back to /expenses rather than throwing: a type nobody
 * recognises must still produce a usable notification, and a broken link is a
 * far better outcome here than a failed comment write. Not derived from
 * `TRANSACTION_TYPES` because this is a ROUTING fact — which page shows which
 * type — and not something the type list knows; it is only a lookup, not a
 * second source of truth about what a type is. NOT exported: this file is
 * `"use server"`, where every export has to be an async server action.
 */
function ledgerPathForType(type: string): string {
  if (type === "income") return "/revenue";
  if (type === "investment") return "/investments";
  return "/expenses";
}

export async function createCommentAction(input: unknown): Promise<
  ActionResult<{
    id: string;
    /** IDs the parser RESOLVED from the body — useful for the UI to know
     *  "we tried to ping these people." */
    mentionedUserIds: string[];
    /** IDs the createMany ACTUALLY notified. Differs from mentionedUserIds
     *  when the fan-out throws — the UI uses this for the honest toast. */
    notifiedCount: number;
  }>
> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid comment" };
  }
  const { body, taskId, transactionId } = parsed.data;
  const { id: userId, companyId } = session.user;

  // Members can't comment on transactions — they can't see the underlying
  // expense/investment row, so they shouldn't be able to discuss it either.
  // Comments on tasks remain open to everyone.
  if (transactionId && !canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  // Which ledger page this comment's row is shown on. Read off the row below;
  // the default only ever survives for a task comment, which never uses it.
  let ledgerPath = "/expenses";

  try {
    // Verify the target belongs to this company. Prevents cross-company
    // comment writes via a forged taskId/transactionId.
    if (taskId) {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: {
          companyId: true,
          deletedAt: true,
          projectId: true,
          assignedTo: true,
          assignedBy: true,
        },
      });
      // `deletedAt` matters as much as `companyId` (tasks-and-comments-015).
      // deleteTaskAction tombstones rather than hard-deleting, and every Task
      // READ filters `deletedAt: null` — getTasks, search, the project board,
      // and `mayReadTarget` in lib/queries/comments.ts. Without the filter here
      // a stale modal, or any retained id, could append to the thread of a task
      // that exists on no surface, and a restore would bring back a
      // conversation that continued after the delete.
      if (!task || task.deletedAt || task.companyId !== companyId) {
        return { success: false, error: "Target not found" };
      }

      /* THE WRITE OBEYS THE SAME VISIBILITY RULE AS THE READ (015).
       *
       * This was `select: { companyId: true }` and a company check, and nothing
       * else: no assignee, creator or supervisor test. `mayReadTarget` in
       * lib/queries/comments.ts refuses a member a teammate's thread, so the
       * endpoint could not be READ and could still be WRITTEN by anyone holding
       * a task id — and ids are handed out freely (the clock-widget picker
       * returns company tasks as `{ id, title }`, and every task notification
       * embeds `taskId=` in its link).
       *
       * `mayAccessTaskThread` is the shared predicate so the two layers state
       * one rule rather than two that happen to agree. It is monotone in
       * `project`, so the `null` probe below can only under-grant: admins and
       * cofounders are answered without the extra query, and only a member who
       * is neither assignee nor creator pays for the project read.
       *
       * The refusal reuses "Target not found" — the same answer a forged id from
       * another workspace gets — so it confirms nothing about what exists. The
       * read side returns an empty thread for the same reason.
       */
      const reader = { userId, role: session.user.role as Role };
      let mayAccess = mayAccessTaskThread({ reader, task, project: null });
      if (!mayAccess) {
        const project = await db.project.findFirst({
          where: { id: task.projectId, companyId, deletedAt: null },
          select: { supervisorId: true },
        });
        mayAccess = mayAccessTaskThread({ reader, task, project });
      }
      if (!mayAccess) return { success: false, error: "Target not found" };
    } else if (transactionId) {
      // `type` as well as `companyId` since transactions-ledger-016: all three
      // ledgers carry a comment control now, so the row's own type is what
      // decides where its mention notification points and which page is
      // revalidated. Without it both default to /expenses, and a mention on a
      // sale lands the reader on a page that filters to `type === "expense"`
      // and therefore provably does not contain their row.
      //
      // `deletedAt` too, and it is the same rule the task branch above states
      // (transactions-ledger-005). `deleteTransactionAction` tombstones rather
      // than hard-deleting since data-integrity-001, and `mayReadTarget` in
      // lib/queries/comments.ts refuses the thread of a tombstoned row — so
      // without this filter a stale ledger modal, or any retained id, could
      // append to a thread that exists on no surface: every ledger, roll-up and
      // export filters the row out, and the restore runbook would bring back a
      // conversation that continued after the delete. It is worse than inert
      // because the mention fan-out below still fires — the author is told
      // "pinged 1 teammate", and the teammate clicks a link into a thread
      // `listCommentsForTarget` answers with an empty list.
      const txn = await db.transaction.findUnique({
        where: { id: transactionId },
        select: { companyId: true, type: true, deletedAt: true },
      });
      if (!txn || txn.deletedAt || txn.companyId !== companyId) {
        return { success: false, error: "Target not found" };
      }
      ledgerPath = ledgerPathForType(txn.type);
    }

    // Pull the author profile + company roster in one round trip. We need
    // both: the author for the denormalized fields, the roster for mention
    // resolution.
    const [author, roster] = await Promise.all([
      db.user.findUnique({ where: { id: userId } }),
      // `handle: true` IS LOAD-BEARING (finding tasks-and-comments-001). It was
      // missing here, and because `MentionUser.handle` is optional in the TYPE
      // — on purpose, so pre-handle roster queries keep compiling — the
      // omission was neither a type error nor a runtime error. It was SILENCE:
      // pass 1 of `buildMentionIndex` indexed no handles, `@ali` resolved to
      // nobody, `Comment.mentions` was stored as "[]", and zero notifications
      // fanned out. lib/queries/comments.ts DOES select handle, so the posted
      // comment still rendered a chip titled "Mentioned Ali Khan" — the writer
      // was told the ping landed and it never did. And for a teammate whose
      // display name carries no ASCII letters (the Urdu-script case the column
      // was added for) the handle is their ONLY address, so they could not be
      // mentioned at all.
      // tests/lib/comments/mention-delivery.test.ts pins this, with a fake
      // Prisma that honours `select` — a fake that ignored it would have passed
      // against the bug. tests/lib/comments/mention-roster.test.ts then sweeps
      // every OTHER whole-company roster that feeds the parser, because the
      // module header of lib/comments/mentions.ts says the only thing that
      // catches a missing `handle` is a grep — and a grep nobody runs is not a
      // guard.
      db.user.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true, name: true, handle: true },
      }),
    ]);
    if (!author) return { success: false, error: "User no longer exists" };

    const mentionedUserIds = extractMentions(body, roster, userId);

    const created = await db.comment.create({
      data: {
        companyId,
        body,
        authorId: userId,
        authorName: author.name,
        authorAvatar: author.avatar,
        taskId: taskId ?? null,
        transactionId: transactionId ?? null,
        mentions: JSON.stringify(mentionedUserIds),
      },
    });

    // Fan out notifications OUTSIDE the comment write. If this throws we
    // log + swallow rather than rolling back the comment — a missing
    // notification is recoverable, a missing comment is not. We track the
    // ACTUAL `notifiedCount` so the UI toast can say "pinged 3 teammates"
    // honestly (previously it reported the parsed mention count even
    // when the createMany threw — silent overstatement).
    let notifiedCount = 0;
    if (mentionedUserIds.length > 0) {
      /* THE TARGET COMES FIRST IN THE LINK (finding tasks-and-comments-003).
       *
       * This used to be `/tasks?comment=<commentId>` alone, and NOTHING in the
       * application reads a `comment` search param — the only `searchParams.get`
       * under app/(app)/ is `taskId`, in tasks-client.tsx. So the only call to
       * action an @mention has resolved to a bare board: no modal, no scroll, no
       * highlight. For a MEMBER it was worse than inert, because `getTasks`
       * filters their board to `assignedTo: userId`, so a mention on a
       * teammate's task landed them on a list that provably did not contain it.
       *
       * `taskId=` / `transactionId=` FIRST because that is the param the product
       * already honours: tasks-client scrolls the card into view and flashes it,
       * and so does expenses-client. `comment=` is kept, and kept SECOND, for two
       * reasons — a client that learns to read it can open the thread without this
       * link changing again, and `deleteCommentAction` below sweeps by that
       * substring. Ordering also matters to `deleteTaskAction`, which sweeps
       * `link contains "taskId=<id>"`: deleting a task now also clears the mention
       * pings that pointed into it, which is the behaviour audit row X10 asks for.
       *
       * THE LEDGER IS THE ROW'S OWN (transactions-ledger-016). This was a
       * hard-coded `/expenses`, which was right only while /expenses was the one
       * page with a comment control. Now that all three have one, a sale's
       * mention goes to /revenue and a cheque's to /investments — the page that
       * actually lists that row.
       *
       * STILL OPEN, and smaller than it was: only expenses-client reads
       * `?transactionId=`, so on /revenue and /investments the reader lands on
       * the right ledger and finds the row themselves rather than being scrolled
       * to it. Nothing reads `?comment=` anywhere yet, so no link opens the
       * thread it names.
       */
      const link = taskId
        ? `/tasks?taskId=${taskId}&comment=${created.id}`
        : `${ledgerPath}?transactionId=${transactionId}&comment=${created.id}`;
      // A mention rides the category of whatever it's attached to.
      const category = taskId ? "task" : "finance";
      const truncated = body.length > 140 ? body.slice(0, 137) + "…" : body;
      try {
        const { notified } = await notifyUsers({
          event: "mention",
          userIds: mentionedUserIds,
          companyId,
          title: `${author.name} mentioned you`,
          message: truncated,
          category,
          link,
        });
        notifiedCount = notified;
      } catch (notifyErr) {
        captureServerError(notifyErr, {
          action: "createCommentAction.fanout",
          companyId,
          userId,
          extra: { commentId: created.id, attempted: mentionedUserIds.length },
        });
      }
    }

    if (taskId) revalidatePath("/tasks");
    // The ledger the row is on, not always /expenses: revalidating the wrong
    // page leaves the right one's comment counts stale.
    else revalidatePath(ledgerPath);

    return {
      success: true,
      data: { id: created.id, mentionedUserIds, notifiedCount },
    };
  } catch (e) {
    captureServerError(e, { action: "createCommentAction" });
    return { success: false, error: "Couldn't post the comment right now." };
  }
}

/**
 * Thin wrapper around the read query so a client modal can lazy-load
 * comments without having to wire its own RSC fetch path.
 */
export async function listCommentsAction(
  target: CommentTarget
): Promise<ActionResult<CommentClient[]>> {
  try {
    const data = await listCommentsForTarget(target);
    return { success: true, data };
  } catch (e) {
    captureServerError(e, { action: "listCommentsAction" });
    return { success: false, error: "Couldn't load the thread right now." };
  }
}

export async function deleteCommentAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = DeleteCommentSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { commentId } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    const comment = await db.comment.findUnique({ where: { id: commentId } });
    // A tombstoned comment is GONE as far as this endpoint is concerned, and it
    // answers exactly as it would for an id that never existed. Two reasons it
    // is a hard refusal rather than a no-op success: re-stamping `deletedAt`
    // would move the tombstone's timestamp, and the range-filter restore in
    // CLAUDE.md's Tier 3 runbook reunites a workspace's rows BY that timestamp;
    // and the notification sweep below would run again on a second call, for a
    // comment whose pings were already cleared.
    if (!comment || comment.deletedAt) return { success: false, error: "Comment not found" };
    if (comment.companyId !== companyId) return { success: false, error: "Not authorized" };
    if (comment.authorId !== userId && role !== "admin") {
      return { success: false, error: "Only the author or an admin can delete this comment" };
    }

    /* Sweep the mention pings that deep-link at this comment, in the same
     * transaction as the delete (audit row X10, applied to comments).
     *
     * `deleteTaskAction` already does this for `taskId=` links, for the reason
     * that applies here verbatim: a notification pointing at something that no
     * longer exists lands the reader somewhere with nothing to open, and they
     * cannot tell a deleted comment from a broken app. The match is on the
     * `comment=<id>` substring every such link carries.
     *
     * A HARD delete, like the task sweep and unlike the comment's own row in a
     * soft-delete world: a notification is a transient ping, not a record, and
     * nothing promises to restore one. Scoped to `companyId` so one workspace's
     * delete can never touch another's rows even if a comment id were guessed.
     * schema.prisma's `Comment.deletedAt` comment says the same thing from the
     * other side: do NOT "make this consistent" with the tombstone. A restored
     * comment gets a live thread back, not a re-delivered ping.
     *
     * In a transaction so the two cannot land apart — a swept notification with
     * the comment still there would delete a live ping, and a deleted comment
     * with its ping intact is the dead end this exists to close.
     *
     * THE COMMENT ITSELF IS A TOMBSTONE, NOT A DELETE (data-integrity-001).
     * This was `tx.comment.delete(...)` until 2026-09-29, while CLAUDE.md's
     * Tier 3 section and the recovery runbook both counted comments as
     * recoverable for 90 days. On a thread hanging off a transaction the comment
     * IS the record of why a founder's money moved — the one thing a bank
     * statement cannot reconstruct — and a mis-click destroyed it outright.
     * `lib/queries/comments.ts` filters `deletedAt: null` on the thread read, so
     * the row stops rendering the moment this lands; without that filter a
     * tombstone does not hide a comment, it duplicates it.
     */
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.comment.update({ where: { id: commentId }, data: { deletedAt: now } });
      await tx.notification.deleteMany({
        where: { companyId, link: { contains: `comment=${commentId}` } },
      });
    });
    if (comment.taskId) revalidatePath("/tasks");
    else if (comment.transactionId) revalidatePath("/expenses");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteCommentAction" });
    return { success: false, error: "Couldn't delete the comment right now." };
  }
}
