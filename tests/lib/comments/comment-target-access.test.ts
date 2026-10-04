/**
 * Can a member post into the comment thread of a task the board hides from
 * them? Finding tasks-and-comments-015.
 *
 * WHAT THE READ SIDE ALREADY DOES. `lib/queries/comments.ts` grew
 * `mayReadTarget` for finding tasks-and-comments-004: a member may read a task
 * thread only when the task is theirs (assignee or creator) or when they can
 * manage its project. Its own comment explains why that is the right predicate
 * — it is the same one `visibleProjectTasks` uses, so "the thread a member can
 * read is exactly the task they can see, by construction".
 *
 * WHAT THE WRITE SIDE DID. `createCommentAction` verified one thing about a
 * task target: `task.companyId === session.user.companyId`. No assignee check,
 * no creator check, no supervisor check, and no `deletedAt` filter. So the
 * endpoint that CANNOT be reached for reading could still be reached for
 * writing, by anyone holding a task id — and CLAUDE.md's own rule is that the
 * two layers must agree ("Permission gates exist in two layers: middleware for
 * routes, server actions for writes. Both must agree.").
 *
 * The ids are not hard to come by. The clock-widget picker hands a member
 * `{ id, title }` for company tasks, and every task notification embeds
 * `taskId=` in its link.
 *
 * WHY THE FAKE PRISMA IS A RECORDER. There is no database in vitest, so nothing
 * here asserts which rows exist. It does not need to: the property at stake is
 * whether the write is ISSUED AT ALL. `comment.create` is answered for anyone
 * who calls it, so "no comment was created" is proof that nothing asked.
 *
 * lib/auth/** is deliberately not mocked — `canSeeAllProjects` and
 * `canManageProject` are the real predicates the rest of the product obeys.
 *
 * THE TRANSACTION TARGET IS THE SAME GATE, AND IT WAS A STEP BEHIND
 * (transactions-ledger-005). 015 gave the task branch a `deletedAt` filter;
 * the transaction branch was left verifying `companyId` and reading `type`,
 * with no tombstone test and no `deletedAt` in its `select`. Yet
 * `deleteTransactionAction` has tombstoned rather than hard-deleted since
 * data-integrity-001, and `mayReadTarget` refuses a thread whose transaction is
 * tombstoned — so the write could still land on a thread no surface shows:
 * every ledger, roll-up and export filters the row out, and the restore runbook
 * would bring back a conversation that continued after the delete. The mention
 * fan-out makes it worse than inert, because the ping fires: the author is told
 * "pinged 1 teammate", and the teammate clicks a link into a thread that
 * `listCommentsForTarget` answers with `[]`. The last two tests here therefore
 * also assert the `select`, because the fake does not project `select` and a
 * check against a column the action never asked for is `undefined` in real
 * Prisma — i.e. no check at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  /** Keyed "delegate.method". `has`, not `??`, so a deliberate null is a miss. */
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy rather than a literal fake: a literal only knows the delegates
  // that existed the day it was written.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_t, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "$transaction") {
          return (cb: (tx: unknown) => unknown) => Promise.resolve(cb(db));
        }
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

const session = vi.hoisted(() => ({
  user: { id: "u_member", companyId: "c_nimbus", role: "member" } as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve({ user: session.user }) }));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: vi.fn(() => Promise.resolve({ notified: 0 })),
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCommentAction } from "@/lib/actions/comments";

/* ─────────────────────────────── fixtures ──────────────────────────────── */

const ADMIN_TASK = {
  id: "t_admin",
  companyId: "c_nimbus",
  deletedAt: null,
  projectId: "p_general",
  assignedTo: "u_admin",
  assignedBy: "u_admin",
};

/** The project ADMIN_TASK lives in, supervised by somebody else again. */
const PROJECT = { supervisorId: "u_admin" };

/** A live ledger row, as the transaction branch of the action reads it. */
const LIVE_TXN = { companyId: "c_nimbus", type: "expense", deletedAt: null };

function signedInAs(role: "admin" | "cofounder" | "member", id: string) {
  session.user = { id, companyId: "c_nimbus", role };
}

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

/** Every `comment.create` the action issued. Empty = the write never happened. */
function commentWrites(): RecordedCall[] {
  return callsTo("comment", "create");
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  signedInAs("member", "u_member");

  prisma.answers.set("user.findUnique", { id: "u_member", name: "Sana Malik", avatar: null });
  prisma.answers.set("user.findMany", []);
  prisma.answers.set("task.findUnique", { ...ADMIN_TASK });
  prisma.answers.set("task.findFirst", { ...ADMIN_TASK });
  prisma.answers.set("project.findFirst", { ...PROJECT });
  prisma.answers.set("project.findUnique", { ...PROJECT });
  prisma.answers.set("comment.create", { id: "cm_1", taskId: "t_admin" });
  prisma.answers.set("transaction.findUnique", { ...LIVE_TXN });
});

/* ══════════ the leak ══════════════════════════════════════════════════════ */

describe("a member cannot comment on a task the board hides from them (015)", () => {
  it("refuses the write on a teammate's task in a project they do not supervise", async () => {
    const res = await createCommentAction({ body: "probe", taskId: "t_admin" });

    expect(res.success, "a member posted into a thread they cannot read").toBe(false);
    expect(commentWrites(), "a Comment row was written for a hidden task").toHaveLength(0);
  });

  it("says nothing about whether the task exists", async () => {
    // Same answer as a forged id from another workspace, so the refusal is not
    // an existence oracle — the read side returns an empty thread for the same
    // reason.
    const mine = await createCommentAction({ body: "probe", taskId: "t_admin" });
    prisma.answers.set("task.findUnique", null);
    prisma.answers.set("task.findFirst", null);
    const nonexistent = await createCommentAction({ body: "probe", taskId: "t_nope" });

    expect(mine.success).toBe(false);
    expect(nonexistent.success).toBe(false);
    expect(mine.success === false && mine.error).toBe(
      nonexistent.success === false && nonexistent.error
    );
  });

  it("refuses a tombstoned task, which is gone as far as every other path is concerned", async () => {
    signedInAs("admin", "u_admin");
    prisma.answers.set("task.findUnique", { ...ADMIN_TASK, deletedAt: new Date() });
    prisma.answers.set("task.findFirst", null);

    const res = await createCommentAction({ body: "probe", taskId: "t_admin" });

    expect(res.success, "a comment was accepted onto a soft-deleted task").toBe(false);
    expect(commentWrites()).toHaveLength(0);
  });
});

/* ══════════ the same gate, on the ledger side ═════════════════════════════ */

describe("a tombstoned transaction's thread is closed, not just hidden (transactions-ledger-005)", () => {
  it("refuses a comment on a soft-deleted ledger row", async () => {
    signedInAs("admin", "u_admin");
    prisma.answers.set("transaction.findUnique", { ...LIVE_TXN, deletedAt: new Date() });

    const res = await createCommentAction({ body: "probe", transactionId: "tx_1" });

    expect(
      res.success,
      "a comment was accepted onto a tombstoned transaction — a thread every read hides"
    ).toBe(false);
    expect(commentWrites(), "a Comment row was written for a deleted ledger line").toHaveLength(0);
  });

  it("asks the database for deletedAt, rather than checking a column it never selected", async () => {
    signedInAs("admin", "u_admin");

    await createCommentAction({ body: "receipt attached", transactionId: "tx_1" });

    const reads = callsTo("transaction", "findUnique");
    expect(reads).toHaveLength(1);
    const select = (reads[0].args[0] as { select?: Record<string, unknown> }).select;
    expect(
      select?.deletedAt,
      "the tombstone check reads `undefined` in real Prisma unless the select asks for it"
    ).toBe(true);
  });

  it("still accepts a comment on a live ledger row", async () => {
    signedInAs("admin", "u_admin");

    const res = await createCommentAction({ body: "receipt attached", transactionId: "tx_1" });

    expect(res.success, "the tombstone gate locked out a live transaction thread").toBe(true);
    expect(commentWrites()).toHaveLength(1);
  });
});

/* ══════════ guard the guard — the people who MUST still be able to post ═══ */

describe("the gate does not lock out the people the comment button is for (015)", () => {
  it("lets the assignee post on their own task", async () => {
    signedInAs("member", "u_member");
    prisma.answers.set("task.findUnique", { ...ADMIN_TASK, assignedTo: "u_member" });

    const res = await createCommentAction({ body: "on it", taskId: "t_admin" });

    expect(res.success, "the assignee was refused their own thread").toBe(true);
    expect(commentWrites()).toHaveLength(1);
  });

  it("lets the creator post on a task they filed for somebody else", async () => {
    signedInAs("member", "u_member");
    prisma.answers.set("task.findUnique", { ...ADMIN_TASK, assignedBy: "u_member" });

    const res = await createCommentAction({ body: "context", taskId: "t_admin" });

    expect(res.success).toBe(true);
    expect(commentWrites()).toHaveLength(1);
  });

  it("lets the project supervisor post on any task in their project", async () => {
    signedInAs("member", "u_super");
    prisma.answers.set("project.findFirst", { supervisorId: "u_super" });
    prisma.answers.set("project.findUnique", { supervisorId: "u_super" });

    const res = await createCommentAction({ body: "reviewed", taskId: "t_admin" });

    expect(res.success, "the supervisor was refused a thread on their own project").toBe(true);
    expect(commentWrites()).toHaveLength(1);
  });

  it("lets an admin post anywhere, without paying for a project lookup", async () => {
    signedInAs("admin", "u_admin2");

    const res = await createCommentAction({ body: "ping", taskId: "t_admin" });

    expect(res.success).toBe(true);
    expect(commentWrites()).toHaveLength(1);
    expect(
      callsTo("project"),
      "an admin sees every board, so the project read is wasted work"
    ).toHaveLength(0);
  });

  it("lets a cofounder post anywhere", async () => {
    signedInAs("cofounder", "u_cofounder");

    const res = await createCommentAction({ body: "ping", taskId: "t_admin" });

    expect(res.success).toBe(true);
    expect(commentWrites()).toHaveLength(1);
  });
});
