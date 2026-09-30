// @vitest-environment node

/**
 * data-integrity-010 — the 90-day project tombstone bought nothing it was written
 * to buy.
 *
 * `deleteProjectAction` has stamped `Project.deletedAt` since Tier 3, and its own
 * comment says why: "so an accidental project delete has the same 90-day recovery
 * window as every other soft-delete table". Nothing ever cleared that column — a
 * grep for `deletedAt: null` WRITES across lib/ and app/ found exactly one,
 * `reactivateUserAction` — and nothing ever showed the row. So the window was
 * real in the database and unreachable from the product: /projects excluded it,
 * /projects/<id> 404'd, search excluded it, and the only recovery was ops SQL the
 * customer could not even ASK for, because they could no longer see that the
 * project existed. Compare users, which have `getDeactivatedUsers` plus
 * `reactivateUserAction` plus a "Deactivated" panel on /team.
 *
 * WHAT THE ASSERTIONS ARE ABOUT. The cheap version of this test is
 * `expect(res.success).toBe(true)`, which would pass on an action that returned
 * success and wrote nothing. So each case below asserts the ROW: whether
 * `deletedAt` actually became null, and whether the gate refused the write rather
 * than refusing after it. The reachability half — that the panel is rendered with
 * the query's output — is `tests/app/projects/deleted-projects-panel.test.ts`,
 * because an action with no caller is this repo's most-repeated defect and a green
 * action test cannot see it.
 *
 * The fake honours `where`, including `deletedAt: { not: null }`. A fake that
 * updated whatever it was handed would pass against an action with no filter at
 * all, which is the version that lets one workspace restore another's project.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  color: string;
  status: string;
  supervisorId: string;
  deletedAt: Date | null;
};

const H = vi.hoisted(() => ({
  projects: [] as unknown[],
  session: { value: null as unknown },
  activities: [] as Array<Record<string, unknown>>,
  /** Restores the row under the caller's feet, between its read and its write. */
  restoreAfterRead: { on: false },
}));

function rows(): ProjectRow[] {
  return H.projects as ProjectRow[];
}

function matches(row: ProjectRow, where: Record<string, unknown>): boolean {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(where, k);
  if (has("id") && row.id !== where.id) return false;
  if (has("companyId") && row.companyId !== where.companyId) return false;
  if (has("deletedAt")) {
    const w = where.deletedAt;
    if (w === null && row.deletedAt !== null) return false;
    if (w !== null && typeof w === "object" && (w as { not?: unknown }).not === null) {
      if (row.deletedAt === null) return false;
    }
  }
  return true;
}

vi.mock("@/lib/db", () => {
  const db: Record<string, unknown> = {
    project: {
      findFirst: async (a: { where: Record<string, unknown> }) => {
        const found = rows().filter((r) => matches(r, a.where))[0] ?? null;
        if (found && H.restoreAfterRead.on) {
          // Somebody else's Restore commits here.
          const live = rows().filter((r) => r.id === found.id)[0];
          if (live) live.deletedAt = null;
          H.restoreAfterRead.on = false;
          return { ...found };
        }
        return found ? { ...found } : null;
      },
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = rows().filter((r) => matches(r, a.where));
        for (const r of found) Object.assign(r, a.data);
        return { count: found.length };
      },
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows().filter((x) => x.id === a.where.id)[0];
        if (r) Object.assign(r, a.data);
        return r;
      },
      count: async () => 0,
    },
    task: { count: async () => 0 },
    budget: { count: async () => 0 },
    user: {
      findUnique: async () => ({ id: "u_ayesha", name: "Ayesha", role: "admin" }),
    },
    activity: {
      create: async (a: { data: Record<string, unknown> }) => {
        H.activities.push(a.data);
        return a.data;
      },
    },
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

import { restoreProjectAction } from "@/lib/actions/projects";
import { limiters } from "@/lib/rate-limit";

type Result = { success: boolean; error?: string };

const TOMBSTONE = new Date("2026-09-01T12:00:00Z");

function project(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "p_apollo",
    companyId: "c_nimbus",
    name: "Apollo",
    color: "#7c5cff",
    status: "active",
    supervisorId: "u_super",
    deletedAt: TOMBSTONE,
    ...over,
  };
}

function signedIn(role: string, id = "u_ayesha", companyId = "c_nimbus"): void {
  H.session.value = { user: { id, companyId, role, email: `${id}@nimbus.app` } };
}

function row(id = "p_apollo"): ProjectRow | undefined {
  return rows().filter((r) => r.id === id)[0];
}

beforeEach(() => {
  H.projects.length = 0;
  H.activities.length = 0;
  H.restoreAfterRead.on = false;
  limiters.write.reset();
  signedIn("admin");
});

describe("data-integrity-010 — a deleted project can be brought back", () => {
  it("clears the tombstone", async () => {
    H.projects.push(project());
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(true);
    // The whole finding. Before this action existed nothing in lib/ or app/ ever
    // wrote `deletedAt: null` on a project.
    expect(row()?.deletedAt).toBeNull();
  });

  it("records it in the activity feed, so the workspace can see it happened", async () => {
    H.projects.push(project());
    await restoreProjectAction("p_apollo");
    expect(H.activities).toHaveLength(1);
    expect(String(H.activities[0].message)).toMatch(/restored project "Apollo"/);
  });

  it("lets the project's own supervisor restore it, not just a founder", async () => {
    // The gate is `canManageProject` — the same one that allowed the delete — so
    // restoring is exactly as privileged as deleting, and no wider.
    H.projects.push(project({ supervisorId: "u_member" }));
    signedIn("member", "u_member");
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(true);
    expect(row()?.deletedAt).toBeNull();
  });
});

describe("data-integrity-010 — and only by someone entitled to", () => {
  it("refuses a member who does not supervise it, without writing", async () => {
    H.projects.push(project({ supervisorId: "u_super" }));
    signedIn("member", "u_outsider");
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/supervisor or a founder/i);
    expect(row()?.deletedAt).toEqual(TOMBSTONE);
  });

  it("cannot reach another workspace's deleted project", async () => {
    // `companyId` is in the same predicate as the id rather than checked
    // afterwards, so a forged id matches nothing instead of being found and then
    // rejected.
    H.projects.push(project({ companyId: "c_other" }));
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(false);
    expect(row()?.deletedAt).toEqual(TOMBSTONE);
  });

  it("is a no-op on a project that was never deleted", async () => {
    H.projects.push(project({ deletedAt: null }));
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Recently deleted/);
    expect(H.activities).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    H.projects.push(project());
    H.session.value = null;
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(false);
    expect(row()?.deletedAt).toEqual(TOMBSTONE);
  });

  it("is rate limited, like every other write in this file", async () => {
    H.projects.push(project({ deletedAt: null }));
    for (let i = 0; i < 60; i++) await restoreProjectAction("p_apollo");
    const over = (await restoreProjectAction("p_apollo")) as Result;
    expect(over.error).toMatch(/Too many requests/);
  });
});

describe("data-integrity-010 — two people pressing Restore together", () => {
  it("produces one restore and one honest refusal, not a second write", async () => {
    // The condition lives in the statement (`updateMany … deletedAt: { not: null }`)
    // for the same reason data-integrity-006 and -007 are about: a re-read would
    // only move the window. Throwing inside the transaction also rolls the
    // activity row back, so the feed never narrates a restore that did not happen.
    H.projects.push(project());
    H.restoreAfterRead.on = true;
    const res = (await restoreProjectAction("p_apollo")) as Result;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already been restored/i);
    expect(row()?.deletedAt).toBeNull();
    expect(H.activities).toEqual([]);
  });
});
