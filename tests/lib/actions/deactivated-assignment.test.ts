// @vitest-environment node

/**
 * data-integrity-012 — writes that resolve another row and forget the tombstone.
 *
 * The house rule everywhere else in this codebase is that a read of another
 * user filters `deletedAt: null`: `getCompanyUsers` does, the chat roster does,
 * and that is precisely why no picker in the product ever OFFERS a deactivated
 * person. `acceptInviteAction` shows the team knows the distinction — it documents
 * at length why its roster read is the one place that must not filter. Three
 * writes skipped it, and every one of them is reachable from a picker that was
 * rendered before the person was deactivated, or from a hand-made request:
 *
 *   • `createProjectAction` resolved the supervisor with
 *     `{ id: supervisorId, companyId }`;
 *   • `changeSupervisorAction` did the same;
 *   • `clockInAction` resolved the task it is clocking into with `{ id: taskId }`
 *     and checked only the company, so a SOFT-DELETED task could be clocked into
 *     and its title snapshotted onto the entry.
 *
 * WHAT THE CONSEQUENCE IS, so the fix is not read as tidiness. A project handed
 * to a tombstoned supervisor has an owner who cannot sign in to act: the card
 * renders their name as the owner, nothing they are notified about reaches them,
 * and — because `canManageProject` grants the supervisor the member escape hatch —
 * the account silently holds manage rights it would regain on reactivation. A
 * clock-in against a deleted task produces a time entry pointing at work that
 * exists on no surface, with the deleted task's title frozen into the row that an
 * hours-based invoice is built from.
 *
 * ALREADY CLOSED, and not re-litigated here: the fourth write the finding names,
 * `addTaskAction`'s assignee lookup, was fixed by data-integrity-004 and carries
 * `if (!assignee || assignee.deletedAt)` with the reasoning in place. One case
 * below pins it so it cannot quietly come back.
 *
 * The fakes honour `where`, including `deletedAt: null`. A fake that returned a
 * canned row would pass with or without the filter.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type UserRow = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  deletedAt: Date | null;
};
type TaskRow = { id: string; companyId: string; title: string; deletedAt: Date | null };
type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  supervisorId: string;
  status: string;
  updatedAt: Date;
  deletedAt: Date | null;
};

const H = vi.hoisted(() => ({
  users: [] as unknown[],
  tasks: [] as unknown[],
  projects: [] as unknown[],
  entries: [] as Array<Record<string, unknown>>,
  session: { value: null as unknown },
}));

function has(where: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(where, k);
}
function liveOk(row: { deletedAt: Date | null }, where: Record<string, unknown>): boolean {
  if (!has(where, "deletedAt")) return true;
  return where.deletedAt === null ? row.deletedAt === null : true;
}

vi.mock("@/lib/db", () => {
  const users = () => H.users as UserRow[];
  const tasks = () => H.tasks as TaskRow[];
  const projects = () => H.projects as ProjectRow[];

  const db: Record<string, unknown> = {
    user: {
      findFirst: async (a: { where: Record<string, unknown> }) =>
        users().filter(
          (u) =>
            (!has(a.where, "id") || u.id === a.where.id) &&
            (!has(a.where, "companyId") || u.companyId === a.where.companyId) &&
            liveOk(u, a.where)
        )[0] ?? null,
      findUnique: async (a: { where: { id: string } }) =>
        users().filter((u) => u.id === a.where.id)[0] ?? null,
      count: async () => 0,
    },
    task: {
      findUnique: async (a: { where: { id: string } }) =>
        tasks().filter((t) => t.id === a.where.id)[0] ?? null,
      findFirst: async (a: { where: Record<string, unknown> }) =>
        tasks().filter(
          (t) =>
            (!has(a.where, "id") || t.id === a.where.id) &&
            (!has(a.where, "companyId") || t.companyId === a.where.companyId) &&
            liveOk(t, a.where)
        )[0] ?? null,
      count: async () => 0,
      findMany: async () => [],
    },
    project: {
      findFirst: async (a: { where: Record<string, unknown> }) =>
        projects().filter(
          (p) =>
            (!has(a.where, "id") || p.id === a.where.id) &&
            (!has(a.where, "companyId") || p.companyId === a.where.companyId) &&
            liveOk(p, a.where)
        )[0] ?? null,
      create: async (a: { data: Record<string, unknown> }) => ({ id: "p_new", ...a.data }),
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = projects().filter((x) => x.id === a.where.id)[0];
        if (p) Object.assign(p, a.data);
        return p;
      },
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = projects().filter((p) => p.id === a.where.id);
        for (const p of found) Object.assign(p, a.data);
        return { count: found.length };
      },
    },
    timeEntry: {
      findFirst: async () => null,
      create: async (a: { data: Record<string, unknown> }) => {
        H.entries.push(a.data);
        return { id: "te_new", ...a.data };
      },
    },
    activity: { create: async () => ({ id: "a_1" }) },
    budget: { count: async () => 0 },
  };
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  return { db };
});

vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 0 }) }));

import { createProjectAction, changeSupervisorAction } from "@/lib/actions/projects";
import { clockInAction } from "@/lib/actions/time";
import { limiters } from "@/lib/rate-limit";

type Result = { success: boolean; error?: string };

const TOMBSTONE = new Date("2026-09-01T00:00:00Z");

function user(id: string, over: Partial<UserRow> = {}): UserRow {
  return { id, companyId: "c_nimbus", name: id, role: "member", deletedAt: null, ...over };
}

function signedIn(role = "admin", id = "u_ayesha"): void {
  H.session.value = { user: { id, companyId: "c_nimbus", role, email: `${id}@nimbus.app` } };
}

beforeEach(() => {
  H.users.length = 0;
  H.tasks.length = 0;
  H.projects.length = 0;
  H.entries.length = 0;
  limiters.write.reset();
  H.users.push(user("u_ayesha", { role: "admin" }));
  signedIn();
});

describe("data-integrity-012 — a deactivated teammate cannot be made a supervisor", () => {
  it("refuses a new project whose supervisor has been deactivated", async () => {
    H.users.push(user("u_gone", { deletedAt: TOMBSTONE }));
    const res = (await createProjectAction({
      name: "Apollo",
      supervisorId: "u_gone",
      color: "emerald",
    })) as Result;
    expect(res.success).toBe(false);
    // The existing message already reads correctly for a deactivated person.
    expect(res.error).toMatch(/member of this company/i);
  });

  it("refuses handing an existing project to a deactivated supervisor", async () => {
    H.users.push(user("u_gone", { deletedAt: TOMBSTONE }), user("u_super"));
    H.projects.push({
      id: "p_apollo",
      companyId: "c_nimbus",
      name: "Apollo",
      supervisorId: "u_super",
      status: "active",
      updatedAt: new Date("2026-09-20T00:00:00Z"),
      deletedAt: null,
    });
    const res = (await changeSupervisorAction({
      projectId: "p_apollo",
      supervisorId: "u_gone",
    })) as Result;
    expect(res.success).toBe(false);
    // And the project still belongs to somebody who can act on it.
    expect((H.projects as ProjectRow[])[0].supervisorId).toBe("u_super");
  });

  it("still allows a live teammate — the gate must not be a wall", async () => {
    H.users.push(user("u_sana"));
    const res = (await createProjectAction({
      name: "Apollo",
      supervisorId: "u_sana",
      color: "emerald",
    })) as Result;
    expect(res.success).toBe(true);
  });
});

describe("data-integrity-012 — a deleted task cannot be clocked into", () => {
  it("refuses a clock-in against a soft-deleted task", async () => {
    H.tasks.push({
      id: "t_gone",
      companyId: "c_nimbus",
      title: "Ship the invoice run",
      deletedAt: TOMBSTONE,
    });
    const res = (await clockInAction({ taskId: "t_gone" })) as Result;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/task not found/i);
    // The real damage is the row, not the message: an entry pointing at work that
    // exists on no surface, with the deleted task's title frozen into the record
    // an hours-based invoice is built from.
    expect(H.entries).toEqual([]);
  });

  it("still clocks in against a live task, and snapshots its title", async () => {
    H.tasks.push({
      id: "t_live",
      companyId: "c_nimbus",
      title: "Close the books",
      deletedAt: null,
    });
    const res = (await clockInAction({ taskId: "t_live" })) as Result;
    expect(res.success).toBe(true);
    expect(H.entries[0].taskTitle).toBe("Close the books");
  });

  it("still allows a clock-in with no task at all", async () => {
    const res = (await clockInAction({})) as Result;
    expect(res.success).toBe(true);
    expect(H.entries[0].taskId ?? null).toBeNull();
  });
});

describe("data-integrity-012 — the one the audit named that was already fixed", () => {
  it("keeps the deactivated-assignee guard in addTaskAction", async () => {
    // data-integrity-004 closed this one, with the reasoning in place. Pinned so
    // it cannot quietly come back while the other three are being fixed.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "actions", "tasks.ts"), "utf8");
    expect(src).toMatch(/!assignee\s*\|\|\s*assignee\.deletedAt/);
  });
});
