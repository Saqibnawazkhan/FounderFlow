/**
 * perf-004 — the unread badge, server half.
 *
 * WHAT IT COST. `components/layout/sidebar.tsx` polled `listNotificationsAction()`
 * every 30 seconds and threw the rows away:
 *
 *     const res = await listNotificationsAction();
 *     setUnreadCount(res.data.filter((n) => !n.read).length);
 *
 * That action runs `auth()` (a User lookup) plus
 * `notification.findMany({ where: { userId }, take: 200 })` and returns every
 * field of every row — titles, message bodies, links. Two SQL statements and up
 * to ~40KB, twice a minute, per open tab, to render one integer. Ten seats with
 * three tabs each is 3,600 requests an hour and ~140MB of egress for a badge,
 * and it is the app's only background load, so it also sets the floor on
 * database connections at idle.
 *
 * `Notification_userId_read_idx` (prisma/schema.prisma) exists for exactly this
 * count and was used by no read query in the codebase.
 *
 * THE PART THE OBVIOUS FIX GETS WRONG. `count({ where: { userId, read: false } })`
 * is not equivalent to what the sidebar displayed. `listNotificationsAction`
 * drops finance-linked rows for members (a member cannot open /expenses, and the
 * message body carries a PKR figure), so a raw count would show a member a
 * badge of 3 over a dropdown containing 1 — a number pointing at something they
 * are not allowed to see. The count has to honour the same visibility rule, and
 * it has to do it in SQL rather than by reading the rows it is trying not to
 * read.
 *
 * Both queries here are POSITIVE conditions. `NOT (link = … OR …)` over a
 * NULLABLE column is three-valued logic: a notification with no link makes the
 * predicate NULL, so a plain `NOT` would silently drop every link-less
 * notification from a member's badge. Counting the blocked rows and subtracting
 * cannot have that bug, and still returns two integers instead of 200 rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_BLOCKED_ROUTES } from "@/lib/auth/role-gates";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["notification", "user"];
  const OPS = ["findMany", "count", "findUnique", "update", "updateMany", "deleteMany"];

  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        if (typeof canned === "function") {
          return (canned as (a: Record<string, unknown>) => unknown)(args ?? {});
        }
        return canned ?? [];
      };
    }
    db[model] = delegate;
  }

  const session = { value: null as unknown };
  return { db, calls, results, session };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import * as notifications from "@/lib/actions/notifications";

function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

function signedIn(role: "admin" | "cofounder" | "member") {
  H.session.value = { user: { id: "u-1", companyId: "co-1", role } };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  signedIn("admin");
});

describe("perf-004 — the badge asks for a number, not a page of rows", () => {
  it("exists as its own action", () => {
    expect(
      typeof notifications.unreadNotificationCountAction,
      "there is no count endpoint, so the sidebar has nothing to call but the full list"
    ).toBe("function");
  });

  it("counts unread rows in SQL and reads none of them", async () => {
    H.results.set("notification.count", () => 7);

    const res = await notifications.unreadNotificationCountAction();

    expect(res.success).toBe(true);
    expect(res.success && res.data.count).toBe(7);
    expect(
      callsTo("notification.findMany").length,
      "a badge that runs findMany is the bug — 200 full rows for one integer"
    ).toBe(0);
    expect(callsTo("notification.count").length).toBeGreaterThan(0);
  });

  it("filters on the (userId, read) index the schema already carries", async () => {
    H.results.set("notification.count", () => 3);
    await notifications.unreadNotificationCountAction();

    const where = callsTo("notification.count")[0].args.where as Record<string, unknown>;
    expect(where.userId).toBe("u-1");
    expect(where.read, "read must be filtered in SQL, not by reading rows back").toBe(false);
  });

  it("does not look the user row up again just to count their notifications", async () => {
    H.results.set("notification.count", () => 1);
    await notifications.unreadNotificationCountAction();
    expect(callsTo("user.findUnique").length).toBe(0);
    expect(callsTo("user.findMany").length).toBe(0);
  });

  it("refuses an anonymous caller", async () => {
    H.session.value = null;
    const res = await notifications.unreadNotificationCountAction();
    expect(res.success).toBe(false);
    expect(callsTo("notification.count").length).toBe(0);
  });

  it("runs exactly one count for someone who can see finances", async () => {
    signedIn("cofounder");
    H.results.set("notification.count", () => 4);
    const res = await notifications.unreadNotificationCountAction();
    expect(callsTo("notification.count").length).toBe(1);
    expect(res.success && res.data.count).toBe(4);
  });
});

describe("perf-004 — a member's badge counts only what a member may open", () => {
  it("subtracts unread notifications that deep-link into finance pages", async () => {
    signedIn("member");
    // First count = all unread; second = the finance-linked subset.
    const queue = [9, 4];
    H.results.set("notification.count", () => queue.shift() ?? 0);

    const res = await notifications.unreadNotificationCountAction();

    expect(
      res.success && res.data.count,
      "the badge said 9 while the dropdown listed 5 — the 4 finance rows are hidden from a member by listNotificationsAction"
    ).toBe(5);
    expect(callsTo("notification.count").length).toBe(2);
  });

  it("names every member-blocked route in the exclusion, and only as a positive match", async () => {
    signedIn("member");
    const queue = [5, 0];
    H.results.set("notification.count", () => queue.shift() ?? 0);
    await notifications.unreadNotificationCountAction();

    const second = callsTo("notification.count")[1].args.where as Record<string, unknown>;
    expect(second.userId).toBe("u-1");
    expect(second.read).toBe(false);
    expect(
      second.NOT,
      "a NOT over the nullable `link` column is three-valued logic — it would drop every link-less notification from the badge"
    ).toBe(undefined);

    const or = second.OR as Array<Record<string, unknown>>;
    expect(Array.isArray(or)).toBe(true);
    const serialized = JSON.stringify(or);
    for (const route of MEMBER_BLOCKED_ROUTES) {
      expect(serialized, `${route} is not excluded from a member's badge`).toContain(route);
    }
    // `/expenses?id=1` and `/expenses/1` both have to be caught, not just the
    // bare path — every notification link in the app carries a query string.
    expect(serialized).toContain("/expenses/");
    expect(serialized).toContain("/expenses?");
  });

  it("never reports a negative count if the two counts disagree", async () => {
    signedIn("member");
    // Pathological: the subset count arrives larger (two statements, two
    // instants — a row can be marked read between them).
    const queue = [2, 5];
    H.results.set("notification.count", () => queue.shift() ?? 0);

    const res = await notifications.unreadNotificationCountAction();
    expect(res.success && res.data.count).toBe(0);
  });
});
