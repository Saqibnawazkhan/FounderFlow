/**
 * Read-side query for comment threads. Returns a flat oldest-first list
 * with the parsed render segments already resolved so the client component
 * doesn't need to fetch the company user list itself.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { tokenizeForRender, type CommentSegment } from "@/lib/comments/mentions";

export type CommentTarget = { taskId: string } | { transactionId: string };

export interface CommentClient {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  mentionedUserIds: string[];
  segments: CommentSegment[]; // pre-tokenized for the UI
  createdAt: string;
  editedAt: string | null;
}

export async function listCommentsForTarget(target: CommentTarget): Promise<CommentClient[]> {
  const { companyId } = await requireScopedSession();

  const where: { companyId: string; taskId?: string; transactionId?: string } = {
    companyId,
  };
  if ("taskId" in target) where.taskId = target.taskId;
  else where.transactionId = target.transactionId;

  const [rows, users] = await Promise.all([
    db.comment.findMany({
      where,
      orderBy: { createdAt: "asc" },
    }),
    db.user.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ]);

  return rows.map((c) => {
    let mentioned: string[] = [];
    try {
      const parsed = JSON.parse(c.mentions) as unknown;
      if (Array.isArray(parsed))
        mentioned = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // Bad JSON in DB → treat as no mentions rather than blowing up the thread.
    }
    return {
      id: c.id,
      body: c.body,
      authorId: c.authorId,
      authorName: c.authorName,
      authorAvatar: c.authorAvatar,
      mentionedUserIds: mentioned,
      segments: tokenizeForRender(c.body, users),
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt?.toISOString() ?? null,
    };
  });
}
