/**
 * Read-side query for comment threads. Returns a flat oldest-first list
 * with the parsed render segments already resolved so the client component
 * doesn't need to fetch the company user list itself.
 *
 * THE TARGET IS PARSED, NOT TRUSTED — and the reader is checked against it.
 * Finding tasks-and-comments-004.
 *
 * What this used to be:
 *
 *     if ("taskId" in target) where.taskId = target.taskId;
 *     else where.transactionId = target.transactionId;
 *
 * Nothing validated `target`; there was no schema on this path at all. Called
 * with `{}` — or with `{ taskId: undefined }`, which satisfies the `in` test
 * above — that assigns `undefined`, and Prisma reads an undefined field as "no
 * filter at all". The query therefore collapsed to `{ companyId }` and returned
 * EVERY Comment row in the workspace: every task thread the reader is not on,
 * and every thread ever written about an expense, an investment or a budget.
 * There was no `take` cap either. `listCommentsAction` is an exported server
 * action with no gate of its own, so one malformed body from any signed-in user
 * was the whole exploit — and "members never see finance pages" is audit-flow
 * #1, enforced in middleware and in `createCommentAction`'s own write gate
 * (canSeeFinances, lib/actions/comments.ts:64). This read walked past it.
 *
 * So there are three rules here now, in this order:
 *
 *   1. `parseTarget` returns a NARROWED union or throws. The narrowing is the
 *      point, not decoration: the where clause is built from a value
 *      TypeScript knows is a non-empty string, so an `undefined` cannot reach
 *      Prisma. It also rejects a non-string — `{ taskId: { not: "" } }` is a
 *      Prisma filter object, and spliced in it matches every commented task in
 *      the company, which a mere presence check would wave through.
 *   2. The target must exist IN THIS COMPANY and the reader must be entitled to
 *      it: a transaction only behind `canSeeFinances` (mirroring the write
 *      gate), a task only when it is theirs or when they can open its project.
 *      A miss returns an empty thread rather than an error, so the answer
 *      leaks no existence.
 *   3. The thread read is capped. This and `getTasks` were the only two
 *      uncapped list reads in lib/queries.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { canManageProject, canSeeAllProjects } from "@/lib/auth/project-permissions";
import { getProjectForUser } from "@/lib/queries/projects";
import { tokenizeForRender, type CommentSegment } from "@/lib/comments/mentions";

export type CommentTarget = { taskId: string } | { transactionId: string };

/**
 * How many comments one thread read may return. Deliberately generous — a
 * thread this long is pathological, not normal — but finite, because an
 * unbounded list read on a public server action is a denial-of-service lever
 * as well as a memory ceiling.
 */
export const COMMENT_THREAD_LIMIT = 200;

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

/**
 * Exactly one non-empty string id, or a throw. Returns the union rather than a
 * boolean so the caller builds its where clause out of a narrowed value — a
 * validator whose result TypeScript cannot see is a validator the next edit can
 * bypass, which is how the original `where.taskId = target.taskId` compiled.
 *
 * Hand-rolled rather than zod: `NewCommentSchema`'s `.refine` states the same
 * XOR rule for the write path, but a refine leaves the parsed type as
 * `{ taskId?: string; transactionId?: string }`, so the narrowing — the half
 * that makes the `undefined` unrepresentable — would still be missing here.
 */
function parseTarget(target: CommentTarget): { taskId: string } | { transactionId: string } {
  const raw = target as { taskId?: unknown; transactionId?: unknown } | null | undefined;
  const taskId = raw && typeof raw.taskId === "string" && raw.taskId.length > 0 ? raw.taskId : null;
  const transactionId =
    raw && typeof raw.transactionId === "string" && raw.transactionId.length > 0
      ? raw.transactionId
      : null;

  if (taskId !== null && transactionId === null) return { taskId };
  if (transactionId !== null && taskId === null) return { transactionId };
  throw new Error("A comment thread must name exactly one of taskId or transactionId");
}

/**
 * Whether this reader is allowed to read the named thread at all.
 *
 * Returns false rather than throwing for an absent or foreign target: the
 * caller turns that into an empty thread, which is indistinguishable from a
 * thread with no comments and therefore confirms nothing about what exists in
 * another workspace.
 */
async function mayReadTarget(
  scope: { taskId: string } | { transactionId: string },
  reader: { userId: string; companyId: string; role: Role }
): Promise<boolean> {
  const { userId, companyId, role } = reader;

  if ("transactionId" in scope) {
    // Members cannot open a finance page, cannot see the underlying row, and
    // are already refused a transaction comment on the WRITE path. The read
    // gate is the same predicate so the two layers state one rule.
    if (!canSeeFinances(role)) return false;
    const txn = await db.transaction.findFirst({
      where: { id: scope.transactionId, companyId, deletedAt: null },
      select: { id: true },
    });
    return txn !== null;
  }

  const task = await db.task.findFirst({
    where: { id: scope.taskId, companyId, deletedAt: null },
    select: { id: true, projectId: true, assignedTo: true, assignedBy: true },
  });
  if (!task) return false;

  // Admin + cofounder see every board. For a member the rule now mirrors all
  // THREE surfaces that state it: the global board narrows to
  // `assignedTo: userId` (lib/queries/tasks.ts), so does the command palette
  // (lib/queries/search.ts), and so — since projects-017 — does the PROJECT
  // board (`visibleProjectTasks`, applied in app/(app)/projects/[id]/page.tsx).
  //
  // THIS BRANCH USED TO BE JUSTIFIED BY THE OPPOSITE. Its comment read "the
  // PROJECT board deliberately does not [narrow] … a member who can open the
  // project therefore sees its whole board, and must be able to read those
  // threads" — and it ended in `getProjectForUser(...) !== null`, i.e. "any
  // member who can open the project may read any thread in it". projects-017
  // removed that premise at the page and left this line behind, so the leak it
  // closed on the board stayed open through the comment endpoint: a member
  // could still fetch a teammate's thread by task id. Found by adversarial
  // verification, not by the change that caused it.
  //
  // `canManageProject` rather than `getProjectForUser`: it is the same predicate
  // `visibleProjectTasks` uses, so the thread a member can read is exactly the
  // task they can see, by construction rather than by two rules agreeing. A
  // supervisor still reads every thread on their own project; a plain member
  // reads the threads on their own work, which is what the comment button on a
  // card they can see needs.
  if (canSeeAllProjects(role)) return true;
  if (task.assignedTo === userId || task.assignedBy === userId) return true;
  const project = await getProjectForUser(task.projectId);
  if (!project) return false;
  return canManageProject({ userId, role, project: { supervisorId: project.supervisorId } });
}

export async function listCommentsForTarget(target: CommentTarget): Promise<CommentClient[]> {
  const { userId, companyId, role } = await requireScopedSession();

  // Throws before anything is read. A rejection after an unfiltered read would
  // still have pulled every row in the workspace into this process.
  const scope = parseTarget(target);

  if (!(await mayReadTarget(scope, { userId, companyId, role }))) return [];

  const [rows, users] = await Promise.all([
    db.comment.findMany({
      // Spread of the narrowed union, so the filtering column is always a
      // string. There is no branch here that can assign `undefined`.
      //
      // `deletedAt: null` is the other half of data-integrity-001. Comment
      // became the eighth soft-delete table on 2026-09-29, so
      // `deleteCommentAction` now stamps a tombstone instead of hard-deleting.
      // A tombstone this read does not filter on does not HIDE the comment, it
      // DUPLICATES it: the deleted comment keeps rendering, the author deletes
      // it again, and the second call is refused as "Comment not found" on a row
      // they can still see. The filter sits before the spread so no target
      // branch can drop it.
      where: { companyId, deletedAt: null, ...scope },
      // Newest-first plus a reverse below, not oldest-first plus a take: with
      // a cap in play, `asc` would drop the most recent comments — the only
      // ones anybody is reading a thread for. `id` breaks a createdAt tie so
      // the page boundary is stable.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENT_THREAD_LIMIT,
    }),
    // `handle` is not optional in practice: without it every mention in this
    // thread resolves by name slug alone, which is T16 — a teammate whose name
    // carries no ASCII letters renders as plain `@text` instead of a chip even
    // though the notification fired. MentionUser.handle is optional in the
    // TYPE, so leaving it out of this select fails silently rather than loudly.
    db.user.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true, handle: true },
    }),
  ]);

  // Back to oldest-first, which is the order the thread renders in.
  return rows
    .slice()
    .reverse()
    .map((c) => {
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
