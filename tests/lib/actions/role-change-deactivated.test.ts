// @vitest-environment node

/**
 * sec-017 — the one resolve-a-foreign-user path that still forgot the tombstone.
 *
 * Three of the four writes sec-017 names were already closed before it was
 * filed: `addTaskAction` by data-integrity-004 (`!assignee || assignee.deletedAt`),
 * and `createProjectAction` + `changeSupervisorAction` by data-integrity-012,
 * which tests/lib/actions/deactivated-assignment.test.ts pins. The fourth,
 * `updateUserRoleAction`, was not — it resolved the target with
 * `db.user.findUnique({ where: { id: userId } })` and then checked only
 * `target.companyId`, so a tombstoned id resolved and the role was written.
 *
 * WHY THAT IS NOT MERELY UNTIDY. The Deactivated panel on /team renders a
 * Reactivate button and nothing else — no role control — and tells the admin
 * "Reactivate to restore access with their previous role"
 * (app/(app)/team/team-client.tsx). So a role written onto a tombstoned row is
 * visible on NO surface in the product: not the roster (`getCompanyUsers`
 * filters `deletedAt: null`), not the deactivated list, not the person
 * themselves. `notifyUsers` already drops tombstoned recipients on every channel
 * (data-integrity-004), so they are not even told. The next thing that reads
 * that column is `reactivateUserAction`, which restores them with it — and
 * "admin" carries billing, invite/remove, role changes and workspace delete. A
 * stale /team tab (the roster that was rendered before someone else pressed
 * Deactivate) or a hand-made request is enough to arm it.
 *
 * THE ORDER OF THE THREE CHECKS IS PART OF THE CONTRACT, which is why two of the
 * cases below are about order rather than about the tombstone:
 *
 *   • the company check must come FIRST, because the refusal names the person —
 *     answering a cross-tenant id with "<name> is deactivated" would hand a
 *     stranger's name to whoever guessed the id, trading one hole for another;
 *   • the tombstone check must come BEFORE the `target.role === role` no-op early
 *     return, which answers `{ success: true }` so the UI can refresh. A fix
 *     placed after it would still report success for a deactivated teammate, and
 *     "no write happened" is the wrong reason to say yes.
 *
 * The fake Prisma client RECORDS; it does not pretend. Every assertion below is
 * about a question asked or an argument passed, both of which the recording
 * holds, so none of these can pass by the fake's good manners.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type UserRow = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  email: string;
  deletedAt: Date | null;
};

const H = vi.hoisted(() => ({
  users: [] as unknown[],
  calls: [] as Array<{ delegate: string; method: string; args: unknown[] }>,
  session: { value: null as unknown },
}));

vi.mock("@/lib/db", () => {
  const users = () => H.users as UserRow[];
  function record(delegate: string, method: string, args: unknown[]) {
    H.calls.push({ delegate, method, args });
  }

  const db: Record<string, unknown> = {
    user: {
      findUnique: async (a: { where: { id: string } }) => {
        record("user", "findUnique", [a]);
        return users().filter((u) => u.id === a.where.id)[0] ?? null;
      },
      count: async (a: unknown) => {
        record("user", "count", [a]);
        // Two admins, so the last-admin guard never answers for the tombstone.
        return 2;
      },
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        record("user", "update", [a]);
        const u = users().filter((x) => x.id === a.where.id)[0];
        if (u) Object.assign(u, a.data);
        return u;
      },
    },
    activity: {
      create: async (a: unknown) => {
        record("activity", "create", [a]);
        return { id: "a_1" };
      },
    },
  };
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  return { db };
});

const notify = vi.hoisted(() => ({
  notifyUsers: vi.fn(async () => ({ notified: 0, dispatched: 0 })),
}));
const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// team.ts reaches its admin gate through `auth()` and imports `signIn` for the
// post-acceptance auto-login; nothing here signs anyone in. Same two lines as
// tests/lib/auth/finance-gate.test.ts.
vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
// `import { AuthError } from "next-auth"` drags next-auth's env module in.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "203.0.113.7" }));

import { updateUserRoleAction } from "@/lib/actions/team";

type Result = { success: boolean; error?: string };

const TOMBSTONE = new Date("2026-09-01T00:00:00.000Z");

function user(id: string, over: Partial<UserRow> = {}): UserRow {
  return {
    id,
    companyId: "c_nimbus",
    name: id,
    role: "member",
    email: `${id}@nimbus.app`,
    deletedAt: null,
    ...over,
  };
}

function callsTo(delegate: string, method: string) {
  return H.calls.filter((c) => c.delegate === delegate && c.method === method);
}

beforeEach(() => {
  H.users.length = 0;
  H.calls.length = 0;
  notify.notifyUsers.mockClear();
  sentry.captureServerError.mockClear();
  H.users.push(user("u_ayesha", { role: "admin", name: "Ayesha" }));
  H.session.value = {
    user: { id: "u_ayesha", companyId: "c_nimbus", role: "admin", email: "ayesha@nimbus.app" },
  };
});

describe("sec-017 — a deactivated teammate's role cannot be changed", () => {
  it("refuses to promote a deactivated teammate to admin", async () => {
    H.users.push(user("u_bilal", { name: "Bilal", role: "member", deletedAt: TOMBSTONE }));

    const res = (await updateUserRoleAction({ userId: "u_bilal", role: "admin" })) as Result;

    expect(res.success).toBe(false);
    // The refusal has to say what is wrong and what to do; "User not found" is
    // false here (they are on the Deactivated list, in front of the admin).
    expect(res.error).toMatch(/deactivated/i);
    // The damage is the column, not the message: the role is what
    // `reactivateUserAction` restores them with.
    expect((H.users as UserRow[])[1].role).toBe("member");
    expect(callsTo("user", "update")).toHaveLength(0);
    expect(callsTo("activity", "create")).toHaveLength(0);
    expect(notify.notifyUsers).not.toHaveBeenCalled();
    // A refusal is an answer, not a crash.
    expect(sentry.captureServerError).not.toHaveBeenCalled();
  });

  it("refuses even when the requested role is the one they already hold", async () => {
    // The `target.role === role` no-op returns `{ success: true }` so the UI can
    // refresh. A tombstone check placed after it reports success for a
    // deactivated teammate — true about the write, wrong about the question.
    H.users.push(user("u_bilal", { name: "Bilal", role: "cofounder", deletedAt: TOMBSTONE }));

    const res = (await updateUserRoleAction({ userId: "u_bilal", role: "cofounder" })) as Result;

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/deactivated/i);
  });

  it("answers a cross-company id without naming the person", async () => {
    // Order matters: the company check runs before the one that names them, so
    // the new message cannot be turned into a name oracle for guessed ids.
    H.users.push(user("u_outsider", { companyId: "c_other", name: "Zoya", deletedAt: TOMBSTONE }));

    const res = (await updateUserRoleAction({ userId: "u_outsider", role: "admin" })) as Result;

    expect(res.success).toBe(false);
    expect(res.error).toBe("Not authorized");
    expect(res.error).not.toMatch(/Zoya/);
    expect(callsTo("user", "update")).toHaveLength(0);
  });

  it("still changes a live teammate's role — the gate must not be a wall", async () => {
    H.users.push(user("u_sana", { name: "Sana", role: "member" }));

    const res = (await updateUserRoleAction({ userId: "u_sana", role: "cofounder" })) as Result;

    expect(res.success).toBe(true);
    const updates = callsTo("user", "update");
    expect(updates).toHaveLength(1);
    const data = (updates[0].args[0] as { data: Record<string, unknown> }).data;
    expect(data.role).toBe("cofounder");
    // The revocation still rides in the same UPDATE as the role (sec-002).
    expect(data.sessionVersion).toEqual({ increment: 1 });
  });
});
