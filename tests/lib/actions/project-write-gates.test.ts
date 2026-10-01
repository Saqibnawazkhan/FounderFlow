/**
 * The two things every project WRITE owes, which three of the five did not pay.
 *
 * projects-012, the server half. `createProjectAction` and
 * `duplicateProjectAction` each open with `limiters.write.consume(userId)`.
 * `updateProjectAction`, `changeSupervisorAction` and `deleteProjectAction` had
 * no gate at all — so any authenticated member who supervises ONE project could
 * drive `updateProjectAction` as fast as the network allows, and every call
 * writes an Activity row inside the action's own transaction. That is an
 * unbounded growth path in a table every teammate's feed reads, reachable
 * without forging anything: the header's Restore button in a loop.
 *
 * The assertion is on the CONSUME, not on the 61st call failing, because the
 * property under test is "this action participates in the write policy". A test
 * that hammered the real limiter would pin the number 60, which is a tuning
 * decision this file has no business freezing.
 *
 * projects-016. A project's status is exactly what the global task board keys
 * on — `taskScopeWhere` in lib/queries/tasks.ts hides tasks whose parent project
 * is `completed` or `archived` — and what the dashboard's project counts read.
 * `updateProjectAction` revalidated only `/projects` and `/projects/<id>`, so on
 * a real Vercel build (where the RSC payload is genuinely cached, unlike dev) a
 * user archived a project and its tasks were still on the board afterwards.
 * `duplicateProjectAction` gets this right and says why in its own comment;
 * `createProjectAction` revalidates `/dashboard`; `deleteProjectAction`
 * revalidated neither. The three siblings disagreed, which is the tell.
 *
 * NOT RE-TESTED HERE, because it already holds and is already pinned:
 *   • the `deletedAt: null` filter on both project lookups (projects-015) —
 *     tests/lib/actions/project-update-concurrency.test.ts
 *   • the `deletedAt: null` filter on both supervisor lookups (projects-009,
 *     first half) — tests/lib/actions/deactivated-assignment.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const revalidated: string[] = [];
  const consumed: Array<{ bucket: string; key: string }> = [];
  const gate = { allowed: true as boolean, error: undefined as string | undefined };

  const MODELS = ["project", "user", "activity", "notification", "task", "budget"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "deleteMany",
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
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { db, calls, results, revalidated, consumed, gate, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    H.revalidated.push(p);
  },
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 0 }) }));
// The real limiter is an in-process token bucket keyed by user id; here it is a
// recorder, so the assertion is about WHICH bucket each action spends and for
// whom, not about the numbers in lib/rate-limit.ts.
vi.mock("@/lib/rate-limit", () => ({
  limiters: {
    write: {
      consume: (key: string) => {
        H.consumed.push({ bucket: "write", key });
        return { allowed: H.gate.allowed, error: H.gate.error };
      },
    },
  },
}));

import {
  changeSupervisorAction,
  deleteProjectAction,
  updateProjectAction,
} from "@/lib/actions/projects";

const LIVE_PROJECT = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: "d",
  supervisorId: "u-1",
  status: "active",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-1",
  updatedAt: new Date("2026-09-29T09:00:00.000Z"),
  deletedAt: null,
};

function signedIn(role = "admin", id = "u-1") {
  H.session.value = { user: { id, companyId: "c-1", role } };
}

/** Did any project row actually get written? The point of a rejected gate. */
function projectWrites(): number {
  return H.calls.filter((c) => c.path === "project.update" || c.path === "project.updateMany")
    .length;
}

beforeEach(() => {
  H.calls.length = 0;
  H.revalidated.length = 0;
  H.consumed.length = 0;
  H.results.clear();
  H.gate.allowed = true;
  H.gate.error = undefined;
  signedIn();
  H.results.set("project.findFirst", LIVE_PROJECT);
  H.results.set("project.findUnique", LIVE_PROJECT);
  H.results.set("user.findUnique", { id: "u-1", name: "Ada", companyId: "c-1" });
  H.results.set("user.findFirst", { id: "u-2", name: "Bilal" });
  H.results.set("project.update", { ...LIVE_PROJECT });
  H.results.set("project.updateMany", { count: 1 });
  H.results.set("activity.create", { id: "a-1" });
  // deleteProjectAction refuses a project that still has children.
  H.results.set("task.count", 0);
  H.results.set("budget.count", 0);
});

describe("projects-012 — every project write takes the same rate-limit gate", () => {
  /**
   * `logsActivity` is not decoration: `deleteProjectAction` writes no Activity
   * row at all, so asserting "it did not log one" for that case cannot fail in
   * either direction. Recording which actions log lets the assertion apply where
   * it discriminates and be absent where it would be theatre.
   */
  const cases: Array<{
    name: string;
    run: () => Promise<{ success: boolean }>;
    logsActivity: boolean;
  }> = [
    {
      name: "updateProjectAction",
      run: () => updateProjectAction({ projectId: "p-1", status: "completed" }),
      logsActivity: true,
    },
    {
      name: "changeSupervisorAction",
      run: () => changeSupervisorAction({ projectId: "p-1", supervisorId: "u-2" }),
      logsActivity: true,
    },
    { name: "deleteProjectAction", run: () => deleteProjectAction("p-1"), logsActivity: false },
  ];

  for (const c of cases) {
    it(`${c.name} spends one write token for the caller`, async () => {
      await c.run();

      expect(
        H.consumed,
        `${c.name} takes no rate-limit gate, so it is an unbounded write path — unlike createProjectAction and duplicateProjectAction, which both consume`
      ).toEqual([{ bucket: "write", key: "u-1" }]);
    });

    it(`${c.name} writes nothing once the gate denies`, async () => {
      H.gate.allowed = false;
      H.gate.error = "Too many requests. Try again in a minute.";

      const res = await c.run();

      expect(res.success).toBe(false);
      expect(projectWrites(), `${c.name} wrote the row anyway`).toBe(0);
      // ONLY FOR THE CASES THAT ACTUALLY LOG ONE. `deleteProjectAction` contains
      // no `logProjectActivity` call at all, so for that case this could not fail
      // in either direction, gate or no gate — a sub-assertion whose failure
      // message described a behaviour the action does not have. The
      // `projectWrites()` line above is the real discriminator for delete (it
      // writes through `db.project.update`), so the block still catches gate
      // removal; this one is now scoped to where it means something.
      if (c.logsActivity) {
        expect(
          H.calls.some((x) => x.path === "activity.create"),
          `${c.name} still logged an Activity row for a write it did not make`
        ).toBe(false);
      }
    });
  }

  it("guards the guard: the recorder is wired, so an empty list means 'no gate'", async () => {
    // If the mock ever stopped being reached, every assertion above would read
    // as "no gate" and pass a fix that removed one. This pins the opposite
    // direction against an action that has always had the gate.
    const { createProjectAction } = await import("@/lib/actions/projects");
    H.results.set("project.create", { ...LIVE_PROJECT });
    await createProjectAction({
      name: "New",
      supervisorId: "u-2",
      color: "emerald",
    });

    expect(H.consumed.length).toBeGreaterThan(0);
  });
});

describe("projects-016 — a project write revalidates the surfaces it changes", () => {
  it("archiving revalidates the global task board", async () => {
    await updateProjectAction({ projectId: "p-1", status: "archived" });

    expect(
      H.revalidated,
      "the archived project's tasks stay on /tasks until something else revalidates it — the user archives again, or assumes the archive failed"
    ).toContain("/tasks");
  });

  it("archiving revalidates the dashboard", async () => {
    await updateProjectAction({ projectId: "p-1", status: "archived" });

    expect(H.revalidated, "the dashboard's project totals stay wrong").toContain("/dashboard");
  });

  it("a rename revalidates the task board too, because the board prints the name", async () => {
    // `getTasks` selects `project: { select: { name: true } }` and surfaces it as
    // `projectName`, so a rename is stale content on /tasks in exactly the same
    // way an archive is missing content.
    await updateProjectAction({
      projectId: "p-1",
      name: "Nimbus — Q4",
      expectedUpdatedAt: LIVE_PROJECT.updatedAt.toISOString(),
    });

    expect(H.revalidated).toContain("/tasks");
  });

  it("still revalidates the two surfaces it always did", async () => {
    await updateProjectAction({ projectId: "p-1", status: "archived" });

    expect(H.revalidated).toContain("/projects");
    expect(H.revalidated).toContain("/projects/p-1");
  });

  it("deleting revalidates the task board and the dashboard", async () => {
    await deleteProjectAction("p-1");

    expect(
      H.revalidated,
      "deleteProjectAction revalidated only /projects, so a deleted project's counts survived on the dashboard"
    ).toContain("/dashboard");
    expect(H.revalidated).toContain("/tasks");
  });

  it("changing the supervisor revalidates the project surfaces", async () => {
    // Unchanged behaviour, pinned so the sweep above cannot be satisfied by
    // making every action revalidate everything.
    await changeSupervisorAction({ projectId: "p-1", supervisorId: "u-2" });

    expect(H.revalidated).toContain("/projects");
    expect(H.revalidated).toContain("/projects/p-1");
  });
});
