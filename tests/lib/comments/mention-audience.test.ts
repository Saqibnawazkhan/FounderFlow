/**
 * A mention notification must land somewhere the person can actually go.
 * Finding tasks-and-comments-016.
 *
 * WHAT WAS WRONG. `createCommentAction` resolved `@names` against the company
 * roster and fanned a Notification out to every one of them. `extractMentions`
 * answers "whose name is in this text" — it says nothing about who may OPEN the
 * thread that text is in, and the two layers that decide that are strict:
 *
 *   • a TASK thread — `mayReadTarget` (lib/queries/comments.ts) and
 *     `mayAccessTaskThread` (the write gate) both refuse a plain member a
 *     teammate's thread;
 *   • a TRANSACTION thread — both gates require `canSeeFinances`, and "members
 *     never see finance pages" is audit-flow #1 of the rebuild plan.
 *
 * So a member @-mentioned on a teammate's task received "Ayesha mentioned you",
 * clicked it, and arrived on a board that provably does not contain the task —
 * `getTasks` filters their board to `assignedTo: userId` — with
 * `listCommentsForTarget` ready to answer their thread read with `[]`. No leak:
 * every gate held. Just a notification whose only possible outcome was a dead
 * end, and an author shown a green "Mentioned X" chip for a colleague who was
 * never told and could not have acted if they had been.
 *
 * WHAT IS ASSERTED HERE. Two things, and the second is as load-bearing as the
 * first:
 *
 *   1. the fan-out is asked to notify only the people who may read the thread;
 *   2. the author is TOLD who was left out. A silent filter is the same defect
 *      as the silent fan-out of tasks-and-comments-001 pointing the other way —
 *      and it is the easier one to ship, because the suite goes green either
 *      way. `unreachableNames` is the channel, and the composer's toast
 *      (components/comments/comment-thread.tsx) is what says it out loud.
 *
 * WHY THE FAKE PRISMA PROJECTS `select`. Same reason
 * tests/lib/comments/mention-delivery.test.ts does it: the property under test
 * includes whether the roster query ASKS for `role`. A fake that handed back
 * whole rows would supply `role` whether or not the action selected it, and
 * every case below would pass against a `select` that had lost it — at which
 * point every mentioned member reads as role `undefined`, which both predicates
 * refuse, and the feature fails closed and silent for everybody who is not an
 * assignee. That is a bug this file would otherwise certify as fixed.
 *
 * lib/auth/** and lib/comments/task-access.ts are deliberately NOT mocked:
 * `mayAccessTaskThread`, `canSeeFinances` and `canManageProject` are the real
 * predicates the rest of the product obeys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();
  const users: Record<string, unknown>[] = [];

  /** Copy only the keys the caller's `select` asked for, like SQL would. */
  function project(rows: Record<string, unknown>[], select: unknown) {
    if (!select || typeof select !== "object") return rows.map((r) => ({ ...r }));
    const wanted: string[] = [];
    const s = select as Record<string, unknown>;
    for (const key of Object.keys(s)) if (s[key] === true) wanted.push(key);
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const key of wanted) out[key] = row[key];
      return out;
    });
  }

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    if (delegate === "user" && method === "findMany") {
      const select = (args[0] as { select?: unknown } | undefined)?.select;
      return Promise.resolve(project(users, select));
    }
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

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

  return { calls, answers, users, db };
});

const notify = vi.hoisted(() => ({
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 1 })),
}));

const session = vi.hoisted(() => ({
  user: { id: "u_author", companyId: "c_nimbus", role: "admin" } as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve({ user: session.user }) }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCommentAction } from "@/lib/actions/comments";

/* ───────────────────────────── the workspace ───────────────────────────── */

/** Ayesha writes the comments. Admin, so she can post anywhere. */
const AUTHOR = { id: "u_author", name: "Ayesha Raza", handle: "ayesha", role: "admin" };
/** The assignee of the target task: reachable on it, by name. */
const ASSIGNEE = { id: "u_sana", name: "Sana Malik", handle: "sana", role: "member" };
/** Supervises the target task's project: reachable on it, via the project. */
const SUPERVISOR = { id: "u_omar", name: "Omar Shah", handle: "omar", role: "member" };
/** A member with nothing to do with the task. The finding, in one row. */
const OUTSIDER = { id: "u_zara", name: "Zara Iqbal", handle: "zara", role: "member" };
/** A founder: reads every board and every ledger. */
const COFOUNDER = { id: "u_bilal", name: "Bilal Ahmed", handle: "bilal", role: "cofounder" };

/** The task every case below comments on, unless it says otherwise. */
const TASK = {
  companyId: "c_nimbus",
  deletedAt: null,
  projectId: "p_1",
  assignedTo: ASSIGNEE.id,
  assignedBy: AUTHOR.id,
};

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

/** The user ids the fan-out was asked to notify; [] when it was never called. */
function notifiedIds(): string[] {
  const call = notify.notifyUsers.mock.calls[0];
  if (!call) return [];
  return ((call[0] as { userIds?: string[] }).userIds ?? []).slice();
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.users.length = 0;
  prisma.users.push(
    { ...AUTHOR },
    { ...ASSIGNEE },
    { ...SUPERVISOR },
    { ...OUTSIDER },
    {
      ...COFOUNDER,
    }
  );
  notify.notifyUsers.mockClear();
  notify.notifyUsers.mockImplementation((input: unknown) =>
    Promise.resolve({ notified: ((input as { userIds?: string[] }).userIds ?? []).length })
  );
  session.user = { id: AUTHOR.id, companyId: "c_nimbus", role: "admin" };

  prisma.answers.set("user.findUnique", { ...AUTHOR });
  prisma.answers.set("task.findUnique", { ...TASK });
  prisma.answers.set("project.findFirst", { supervisorId: SUPERVISOR.id });
  prisma.answers.set("comment.create", { id: "cm_1", taskId: "t_1" });
  prisma.answers.set("transaction.findUnique", {
    companyId: "c_nimbus",
    type: "expense",
    deletedAt: null,
  });
});

/* ══════════ a task thread ════════════════════════════════════════════════ */

describe("a task mention only pings people who can open the task (016)", () => {
  it("does not notify a member with nothing to do with the task", async () => {
    const res = await createCommentAction({ body: "@zara thoughts?", taskId: "t_1" });

    expect(res.success).toBe(true);
    expect(
      notifiedIds(),
      "a member was pinged into a board that does not contain the task"
    ).not.toContain(OUTSIDER.id);
  });

  it("tells the author who could not be reached, by name", async () => {
    // The half a silent filter would skip. Without this the author sees the
    // green "Mentioned Zara Iqbal" chip, no warning, and nothing was sent.
    const res = await createCommentAction({ body: "@zara thoughts?", taskId: "t_1" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.unreachableNames, "the drop was silent").toEqual([OUTSIDER.name]);
    expect(res.data.notifiedCount).toBe(0);
    // And the PARSED list is unchanged, because the chip is a fact about the
    // text: her name IS in the comment, and every later reader sees that.
    expect(res.data.mentionedUserIds).toEqual([OUTSIDER.id]);
  });

  it("notifies the assignee without reading the project at all", async () => {
    // `mayAccessTaskThread` is monotone in `project`, so the cheap probe
    // answers first. A mention of the person doing the work is the common case
    // and must not cost a query.
    const res = await createCommentAction({ body: "@sana any update?", taskId: "t_1" });

    expect(res.success).toBe(true);
    expect(notifiedIds()).toEqual([ASSIGNEE.id]);
    expect(
      callsTo("project"),
      "the assignee is reachable from the task row alone — the project read is waste"
    ).toHaveLength(0);
  });

  it("notifies the project supervisor, who is reachable only through the project", async () => {
    // GUARDS THE GUARD. A filter that simply refused every member would pass
    // both cases above; this is the member who must still get the ping.
    const res = await createCommentAction({ body: "@omar can you review?", taskId: "t_1" });

    expect(res.success).toBe(true);
    expect(notifiedIds(), "the supervisor of the task's own project was dropped").toEqual([
      SUPERVISOR.id,
    ]);
    if (!res.success) return;
    expect(res.data.unreachableNames).toEqual([]);
  });

  it("notifies a cofounder, who reads every board", async () => {
    const res = await createCommentAction({ body: "@bilal FYI", taskId: "t_1" });

    expect(res.success).toBe(true);
    expect(notifiedIds()).toEqual([COFOUNDER.id]);
  });

  it("splits a mixed mention: pings who it can, names who it cannot", async () => {
    const res = await createCommentAction({
      body: "@sana @zara standup at 4",
      taskId: "t_1",
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(notifiedIds()).toEqual([ASSIGNEE.id]);
    expect(res.data.notifiedCount).toBe(1);
    expect(res.data.unreachableNames).toEqual([OUTSIDER.name]);
  });

  it("reads the project at most once however many members are named", async () => {
    // `threadProjectFor` caches. Without it this is one findFirst per mentioned
    // member, on exactly the threads where most of them miss.
    await createCommentAction({ body: "@omar @zara please look", taskId: "t_1" });

    expect(callsTo("project", "findFirst")).toHaveLength(1);
  });

  it("does not notify anybody when the task's project cannot be resolved", async () => {
    // A tombstoned or foreign project answers null, and `mayAccessTaskThread`
    // refuses on a null project. Fails closed, which is the right direction.
    prisma.answers.set("project.findFirst", null);

    const res = await createCommentAction({ body: "@omar please look", taskId: "t_1" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(notifiedIds()).toEqual([]);
    expect(res.data.unreachableNames).toEqual([SUPERVISOR.name]);
  });
});

/* ══════════ a ledger thread ══════════════════════════════════════════════ */

describe("a transaction mention only pings finance readers (016)", () => {
  it("does not notify a member about a ledger row they cannot open", async () => {
    // "Members never see finance pages" is audit-flow #1, and both comment
    // gates state it. A ping into /expenses is a ping into a 403.
    prisma.answers.set("comment.create", { id: "cm_2", transactionId: "tx_9" });

    const res = await createCommentAction({ body: "@sana is this ours?", transactionId: "tx_9" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(notifiedIds()).toEqual([]);
    expect(res.data.unreachableNames).toEqual([ASSIGNEE.name]);
  });

  it("notifies a cofounder about the same row", async () => {
    // GUARDS THE GUARD: `canSeeFinances` is a two-role predicate, so a filter
    // written as `role === "admin"` would pass the case above and still be wrong.
    prisma.answers.set("comment.create", { id: "cm_2", transactionId: "tx_9" });

    const res = await createCommentAction({ body: "@bilal is this ours?", transactionId: "tx_9" });

    expect(res.success).toBe(true);
    expect(notifiedIds()).toEqual([COFOUNDER.id]);
  });

  it("does not go looking for a project on a ledger thread", async () => {
    prisma.answers.set("comment.create", { id: "cm_2", transactionId: "tx_9" });

    await createCommentAction({ body: "@sana @bilal see this", transactionId: "tx_9" });

    expect(
      callsTo("project"),
      "a transaction thread has no task and therefore no project to read"
    ).toHaveLength(0);
  });
});

/* ══════════ the structural half ══════════════════════════════════════════ */

describe("the roster the audience filter reads is asked for the role", () => {
  it("selects role alongside name and handle", async () => {
    // The fake projects `select`, so this is not decoration: without `role` the
    // predicates see `undefined` and refuse everybody who is not an assignee —
    // a silent, total regression that every behavioural case above would still
    // report as a pass, because the fixtures' reachable people are reachable by
    // role.
    await createCommentAction({ body: "@bilal FYI", taskId: "t_1" });

    const roster = callsTo("user", "findMany");
    expect(roster).toHaveLength(1);
    const select = (roster[0].args[0] as { select?: Record<string, unknown> }).select;
    expect(select?.role, "the audience filter cannot see a role it never selected").toBe(true);
    // And the two columns tasks-and-comments-001 and T16 are about, so this
    // file cannot be "fixed" by narrowing the select to role alone.
    expect(select?.handle).toBe(true);
    expect(select?.name).toBe(true);
  });
});
