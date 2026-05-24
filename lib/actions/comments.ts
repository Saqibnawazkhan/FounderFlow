"use server";

/**
 * Comment server actions: create, delete, list.
 *
 * Permissions:
 *  - Any company member can read all comments on company resources.
 *  - Any company member can post a comment on a task/transaction in their
 *    company.
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
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import {
  listCommentsForTarget,
  type CommentClient,
  type CommentTarget,
} from "@/lib/queries/comments";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function createCommentAction(
  input: unknown
): Promise<ActionResult<{ id: string; mentionedUserIds: string[] }>> {
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

  try {
    // Verify the target belongs to this company. Prevents cross-company
    // comment writes via a forged taskId/transactionId.
    if (taskId) {
      const task = await db.task.findUnique({ where: { id: taskId }, select: { companyId: true } });
      if (!task || task.companyId !== companyId) {
        return { success: false, error: "Target not found" };
      }
    } else if (transactionId) {
      const txn = await db.transaction.findUnique({
        where: { id: transactionId },
        select: { companyId: true },
      });
      if (!txn || txn.companyId !== companyId) {
        return { success: false, error: "Target not found" };
      }
    }

    // Pull the author profile + company roster in one round trip. We need
    // both: the author for the denormalized fields, the roster for mention
    // resolution.
    const [author, roster] = await Promise.all([
      db.user.findUnique({ where: { id: userId } }),
      db.user.findMany({
        where: { companyId },
        select: { id: true, name: true },
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
    // notification is recoverable, a missing comment is not.
    if (mentionedUserIds.length > 0) {
      const link = taskId ? `/tasks?comment=${created.id}` : `/expenses?comment=${created.id}`;
      const truncated = body.length > 140 ? body.slice(0, 137) + "…" : body;
      try {
        await db.notification.createMany({
          data: mentionedUserIds.map((toUserId) => ({
            userId: toUserId,
            companyId,
            title: `${author.name} mentioned you`,
            message: truncated,
            type: "info",
            link,
          })),
        });
      } catch (notifyErr) {
        captureServerError(notifyErr, { action: "createCommentAction.fanout" });
      }
    }

    if (taskId) revalidatePath("/tasks");
    else revalidatePath("/expenses");

    return { success: true, data: { id: created.id, mentionedUserIds } };
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
    if (!comment) return { success: false, error: "Comment not found" };
    if (comment.companyId !== companyId) return { success: false, error: "Not authorized" };
    if (comment.authorId !== userId && role !== "admin") {
      return { success: false, error: "Only the author or an admin can delete this comment" };
    }

    await db.comment.delete({ where: { id: commentId } });
    if (comment.taskId) revalidatePath("/tasks");
    else if (comment.transactionId) revalidatePath("/expenses");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteCommentAction" });
    return { success: false, error: "Couldn't delete the comment right now." };
  }
}
