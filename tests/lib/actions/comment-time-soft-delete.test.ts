/**
 * data-integrity-001, the two tables that were still missing: Comment and
 * TimeEntry.
 *
 * WHAT WAS WRONG. CLAUDE.md's Tier 3 section and prisma/schema.prisma both
 * promise that a deleted row is tombstoned and recoverable for 90 days with one
 * `UPDATE … SET "deletedAt" = NULL`. `tests/lib/actions/soft-delete.test.ts`
 * nailed that down for Transaction / Task / Budget. Comment and TimeEntry were
 * left calling Prisma's real `delete()`:
 *
 *     await tx.comment.delete({ where: { id: commentId } });     // comments.ts
 *     await db.timeEntry.delete({ where: { id: entryId } });     // time.ts
 *
 * So the written record of WHY a founder's money moved — the thread hanging off
 * a transaction, the one thing a bank statement cannot reconstruct — was
 * destroyed by a mis-click, and a MEMBER could erase their own billable hours
 * along with the editedBy/editedAt audit trail that exists to prove nobody
 * else touched them.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Copied deliberately from
 * tests/lib/actions/soft-delete.test.ts, for the reason its header gives: the
 * cheap version of this file asserts `success === true`, which was ALREADY true
 * of the hard-delete code — the row was destroyed successfully. The defect is
 * not a missing write, it is the WRONG write. So every assertion names the
 * operation it forbids (`comment.delete`, `timeEntry.delete`) as well as the one
 * it requires.
 *
 * AND THE OTHER HALF, which is what makes a tombstone worth writing:
 *
 *   • A read that does not filter `deletedAt: null` does not hide the row, it
 *     DUPLICATES it — the deleted comment keeps rendering and the user deletes
 *     it again. `listCommentsForTarget` is asserted on directly here.
 *   • A lookup that does not notice an existing tombstone lets the same row be
 *     deleted twice, and — the sharp one — `clockInAction`'s "one open entry per
 *     user" probe would match a TOMBSTONED open entry forever, so deleting your
 *     own running timer would refuse every future clock-in with "You're already
 *     clocked in" and show you no entry to clock out of. A permanent lockout
 *     created by the fix itself. The clock-in test below drives that through a
 *     fake that HONOURS the filter, so it fails against a probe that omits it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client — a recorder, same shape as soft-delete.test.ts           */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → the value to resolve with, or a function of the call args. */
  const results = new Map<string, unknown>();
  /** Anything the actions swallowed into Sentry. A test that expects success
   *  asserts this is empty, so a thrown error cannot masquerade as a polite
   *  "Couldn't delete the comment right now." pass. */
  const errors: unknown[] = [];

  // An explicit model list, not a Proxy: an action that starts reaching for a
  // NEW table fails loudly here ("db.budget is undefined") instead of silently
  // recording nothing and passing.
  const MODELS = ["comment", "notification", "task", "transaction", "user", "timeEntry"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "aggregate",
    "groupBy",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  // The `$transaction` marker is recorded too, so a test can assert the
  // tombstone and the notification sweep rode the SAME transaction rather than
  // merely both happening.
  db.$transaction = async (arg: unknown) => {
    calls.push({ path: "$transaction", args: {} });
    return typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  };

  return {
    db,
    calls,
    results,
    errors,
    session: { value: null as unknown },
    scoped: { value: null as unknown },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => H.scoped.value,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
// Always-allow, so a run of eight write actions in one file can't trip the
// real in-memory window and turn a behavioural assertion into a 429.
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async () => ({ notified: 0 }),
}));

import { deleteCommentAction } from "@/lib/actions/comments";
import { listCommentsForTarget } from "@/lib/queries/comments";
import {
  autoCloseEntryAction,
  clockInAction,
  clockOutAction,
  deleteTimeEntryAction,
  heartbeatAction,
  updateTimeEntryAction,
} from "@/lib/actions/time";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

function scopedAs(role: string, id = "u1"): void {
  H.scoped.value = {
    userId: id,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId: "c1",
    role,
  };
}

const TOMBSTONE = new Date("2026-09-01T00:00:00.000Z");

function commentRow(over: Record<string, unknown> = {}) {
  return {
    id: "cm1",
    companyId: "c1",
    body: "we wired Falcon the 4.2m today",
    authorId: "u1",
    authorName: "Saqib",
    authorAvatar: null,
    mentions: "[]",
    taskId: null,
    transactionId: "tx1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    editedAt: null,
    deletedAt: null,
    ...over,
  };
}

function entryRow(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    companyId: "c1",
    projectId: null,
    projectName: null,
    userId: "u1",
    userName: "Saqib",
    taskId: null,
    taskTitle: null,
    note: null,
    clockInAt: new Date("2026-09-20T09:00:00.000Z"),
    clockOutAt: new Date("2026-09-20T17:00:00.000Z"),
    lastActivityAt: new Date("2026-09-20T17:00:00.000Z"),
    autoClosed: false,
    editedBy: null,
    editedByName: null,
    editedAt: null,
    createdAt: new Date("2026-09-20T09:00:00.000Z"),
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.errors.length = 0;
  H.session.value = null;
  H.scoped.value = null;
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Comment — the thread is the record of why the money moved                    */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("deleteCommentAction (a mis-clicked comment must be recoverable)", () => {
  it("stamps deletedAt instead of hard-deleting the row", async () => {
    signedInAs("admin");
    when("comment.findUnique", commentRow());
    when("comment.update", commentRow({ deletedAt: new Date() }));
    when("notification.deleteMany", { count: 2 });

    const res = await deleteCommentAction({ commentId: "cm1" });

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(true);
    expect(
      callsTo("comment.delete"),
      "comment.delete() destroys the only written record of why a transaction happened"
    ).toHaveLength(0);

    const [update] = callsTo("comment.update");
    expect(update, "deleteCommentAction must write the tombstone").toBeDefined();
    expect(whereOf(update)).toEqual({ id: "cm1" });
    expect(dataOf(update).deletedAt).toBeInstanceOf(Date);
  });

  it("still hard-deletes the mention pings, in the same transaction as the tombstone", async () => {
    signedInAs("admin");
    when("comment.findUnique", commentRow());
    when("comment.update", commentRow({ deletedAt: new Date() }));
    when("notification.deleteMany", { count: 2 });

    await deleteCommentAction({ commentId: "cm1" });

    // A ping is a transient pointer, not history — schema.prisma says in so
    // many words that this must NOT be "made consistent" with the tombstone.
    expect(callsTo("notification.deleteMany")[0]).toEqual({
      where: { companyId: "c1", link: { contains: "comment=cm1" } },
    });
    const order = H.calls.map((c) => c.path);
    expect(order.indexOf("$transaction")).toBeGreaterThan(-1);
    expect(order.indexOf("$transaction")).toBeLessThan(order.indexOf("comment.update"));
    expect(order.indexOf("$transaction")).toBeLessThan(order.indexOf("notification.deleteMany"));
  });

  it("refuses a comment that is already tombstoned, and writes nothing", async () => {
    signedInAs("admin");
    when("comment.findUnique", commentRow({ deletedAt: TOMBSTONE }));

    const res = await deleteCommentAction({ commentId: "cm1" });

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toBe("Comment not found");
    expect(callsTo("comment.update")).toHaveLength(0);
    expect(callsTo("comment.delete")).toHaveLength(0);
    // And it must not re-sweep pings for a comment somebody already deleted.
    expect(callsTo("notification.deleteMany")).toHaveLength(0);
  });
});

describe("listCommentsForTarget (a tombstoned comment must stop rendering)", () => {
  it("filters deletedAt: null on the thread read", async () => {
    scopedAs("admin");
    when("task.findFirst", {
      id: "t1",
      projectId: "p1",
      assignedTo: "u1",
      assignedBy: "u1",
    });
    when("comment.findMany", []);
    when("user.findMany", []);

    await listCommentsForTarget({ taskId: "t1" });

    const [read] = callsTo("comment.findMany");
    expect(read, "the thread read never ran").toBeDefined();
    expect(whereOf(read)).toEqual({ companyId: "c1", taskId: "t1", deletedAt: null });
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* TimeEntry — a member's own billable hours, and its audit trail              */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("deleteTimeEntryAction (billable hours must be recoverable)", () => {
  it("stamps deletedAt instead of hard-deleting the row", async () => {
    signedInAs("member");
    when("timeEntry.findUnique", entryRow());
    when("timeEntry.update", entryRow({ deletedAt: new Date() }));

    const res = await deleteTimeEntryAction("e1");

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(true);
    expect(
      callsTo("timeEntry.delete"),
      "a member deleting their own entry destroyed hours only they could reconstruct"
    ).toHaveLength(0);

    const [update] = callsTo("timeEntry.update");
    expect(update, "deleteTimeEntryAction must write the tombstone").toBeDefined();
    expect(whereOf(update)).toEqual({ id: "e1" });
    expect(dataOf(update).deletedAt).toBeInstanceOf(Date);
  });

  it("refuses an entry that is already tombstoned, and writes nothing", async () => {
    signedInAs("member");
    when("timeEntry.findUnique", entryRow({ deletedAt: TOMBSTONE }));

    const res = await deleteTimeEntryAction("e1");

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toBe("Entry not found");
    expect(callsTo("timeEntry.update")).toHaveLength(0);
    expect(callsTo("timeEntry.delete")).toHaveLength(0);
  });
});

describe("clockInAction (deleting a running timer must not lock you out forever)", () => {
  it("clocks in even though a TOMBSTONED open entry exists", async () => {
    signedInAs("member");
    // The fake honours the filter, the way Postgres would: the tombstoned open
    // row is returned only to a probe that forgot `deletedAt: null`.
    when("timeEntry.findFirst", (args: Record<string, unknown>) => {
      const where = whereOf(args);
      if ("deletedAt" in where) return null;
      return entryRow({ clockOutAt: null, deletedAt: TOMBSTONE });
    });
    when("user.findUnique", { id: "u1", name: "Saqib" });
    when("timeEntry.create", { id: "e2" });

    const res = await clockInAction({});

    expect(H.errors).toEqual([]);
    expect(
      res.success,
      'a tombstoned open entry must not answer "You\'re already clocked in." for the rest of time'
    ).toBe(true);
    expect(callsTo("timeEntry.create")).toHaveLength(1);
    expect(whereOf(callsTo("timeEntry.findFirst")[0]).deletedAt).toBeNull();
  });

  it("still refuses when a LIVE open entry exists", async () => {
    signedInAs("member");
    when("timeEntry.findFirst", entryRow({ clockOutAt: null }));

    const res = await clockInAction({});

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toBe("You're already clocked in.");
    expect(callsTo("timeEntry.create")).toHaveLength(0);
  });
});

describe("the other TimeEntry writers treat a tombstone as gone", () => {
  it("clockOutAction refuses a tombstoned entry", async () => {
    signedInAs("member");
    when("timeEntry.findUnique", entryRow({ clockOutAt: null, deletedAt: TOMBSTONE }));

    const res = await clockOutAction({ entryId: "e1" });

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toBe("Entry not found");
    expect(callsTo("timeEntry.update")).toHaveLength(0);
  });

  it("autoCloseEntryAction refuses a tombstoned entry", async () => {
    signedInAs("member");
    when("timeEntry.findUnique", entryRow({ clockOutAt: null, deletedAt: TOMBSTONE }));

    const res = await autoCloseEntryAction({ entryId: "e1" });

    expect(res.success).toBe(false);
    expect(callsTo("timeEntry.update")).toHaveLength(0);
  });

  it("heartbeatAction refuses a tombstoned entry", async () => {
    signedInAs("member");
    when("timeEntry.findUnique", entryRow({ clockOutAt: null, deletedAt: TOMBSTONE }));

    const res = await heartbeatAction({ entryId: "e1" });

    expect(res.success).toBe(false);
    expect(callsTo("timeEntry.update")).toHaveLength(0);
  });

  it("updateTimeEntryAction refuses to edit the times of a tombstoned entry", async () => {
    signedInAs("admin");
    when("timeEntry.findUnique", entryRow({ deletedAt: TOMBSTONE }));
    when("user.findUnique", { id: "u1", name: "Ayesha" });

    const res = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: "2026-09-20T09:00:00.000Z",
      clockOutAt: "2026-09-20T17:00:00.000Z",
    });

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toBe("Entry not found");
    expect(callsTo("timeEntry.update")).toHaveLength(0);
  });
});
