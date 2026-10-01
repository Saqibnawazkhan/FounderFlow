// @vitest-environment node

/**
 * The three TimeEntry write paths, judged on what they actually store.
 *
 * Findings time-003, time-004, time-005, time-006, time-007 and time-008 are all
 * the same shape: `clockInAction`, `createManualEntryAction` and
 * `updateTimeEntryAction` each build a `data` object by hand, and each one was
 * missing a different part of it. So this file asserts on the recorded `where`
 * and `data` of every statement the actions issue, against a fake client that
 * HONOURS the `where` it is given — a fake that returned whatever it was handed
 * would pass against every version of these actions, which is the failure mode
 * this repo keeps re-shipping.
 *
 * What each describe block defends:
 *
 *   time-003  a tombstoned task must answer exactly as an id that never existed.
 *             `clockInAction` was fixed for data-integrity-012; the manual-entry
 *             and admin-edit paths still validated with
 *             `findUnique({ where: { id } })` and a `task.companyId === companyId`
 *             comparison afterwards, so a deleted task's title was still
 *             snapshotted onto a brand-new billable row.
 *   time-004  `TimeEntry.projectId` / `projectName` exist in the schema (the
 *             20260526151502_add_projects migration added the columns AND the
 *             `[projectId, clockInAt]` index) and no writer ever set them. Every
 *             "Hours tracked" figure on /projects reads 0m for ever, because
 *             lib/queries/projects.ts filters `projectId: { in: ... }`.
 *   time-005  a manual entry had no maximum length and no overlap check, and
 *             `createManualEntryAction` is deliberately ungated by role — so the
 *             lowest-privilege user in the workspace controlled the hours total.
 *   time-006  "only one open entry per user" is the invariant `clockInAction`
 *             defends and the module header states; the admin edit could blank
 *             the clock-out field and add a second one.
 *   time-007  blanking the clock-out left `lastActivityAt` hours BEHIND the new
 *             `clockInAt`, and the nightly sweep writes `clockOutAt =
 *             lastActivityAt`, so `durationMs` clamps the session to 0m and the
 *             hours are gone with no error anywhere.
 *   time-008  a human correction left `autoClosed` true, so the stopwatch badge
 *             and the "Auto-closed" KPI kept reporting a row a human had just
 *             typed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MIN = 60_000;
const HR = 60 * MIN;

type Json = Record<string, unknown>;

/** A Prisma-ish `where` matcher. Understands the operators these actions use. */
function matches(row: Json, where: Json): boolean {
  for (const key of Object.keys(where)) {
    const want = where[key];
    if (key === "OR") {
      if (!(want as Json[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(want as Json[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(row, want as Json)) return false;
      continue;
    }
    const actual = row[key];
    if (want === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (want instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== want.getTime()) return false;
      continue;
    }
    if (typeof want === "object") {
      const ops = want as Json;
      for (const op of Object.keys(ops)) {
        const arg = ops[op];
        const a = actual instanceof Date ? actual.getTime() : (actual as number);
        const b = arg instanceof Date ? arg.getTime() : (arg as number);
        if (op === "lt" && !(actual !== null && actual !== undefined && a < b)) return false;
        else if (op === "lte" && !(actual !== null && actual !== undefined && a <= b)) return false;
        else if (op === "gt" && !(actual !== null && actual !== undefined && a > b)) return false;
        else if (op === "gte" && !(actual !== null && actual !== undefined && a >= b)) return false;
        else if (op === "in" && !(arg as unknown[]).includes(actual)) return false;
        else if (op === "notIn" && (arg as unknown[]).includes(actual)) return false;
        else if (op === "not") {
          if (arg === null) {
            if (actual === null || actual === undefined) return false;
          } else if (actual === arg) return false;
        }
      }
      continue;
    }
    if (actual !== want) return false;
  }
  return true;
}

const H = vi.hoisted(() => ({
  entries: [] as Record<string, unknown>[],
  tasks: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
  calls: [] as { path: string; args: Record<string, unknown> }[],
  session: { value: null as unknown },
  nextId: { n: 0 },
}));

vi.mock("@/lib/db", () => {
  const rec = (path: string, args: Record<string, unknown> | undefined) => {
    H.calls.push({ path, args: args ?? {} });
  };
  const m = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    matches(row as Json, (where ?? {}) as Json);
  return {
    db: {
      timeEntry: {
        findFirst: async (a: { where: Record<string, unknown> }) => {
          rec("timeEntry.findFirst", a);
          return H.entries.find((r) => m(r, a.where)) ?? null;
        },
        findUnique: async (a: { where: Record<string, unknown> }) => {
          rec("timeEntry.findUnique", a);
          return H.entries.find((r) => m(r, a.where)) ?? null;
        },
        findMany: async (a: { where: Record<string, unknown> }) => {
          rec("timeEntry.findMany", a);
          return H.entries.filter((r) => m(r, a.where));
        },
        count: async (a: { where: Record<string, unknown> }) => {
          rec("timeEntry.count", a);
          return H.entries.filter((r) => m(r, a.where)).length;
        },
        create: async (a: { data: Record<string, unknown> }) => {
          rec("timeEntry.create", a);
          const row = {
            id: `e_new_${++H.nextId.n}`,
            clockInAt: new Date(),
            clockOutAt: null,
            lastActivityAt: new Date(),
            autoClosed: false,
            deletedAt: null,
            projectId: null,
            projectName: null,
            ...a.data,
          };
          H.entries.push(row);
          return row;
        },
        update: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          rec("timeEntry.update", a);
          const row = H.entries.find((r) => m(r, a.where));
          if (!row) throw new Error("P2025: record not found");
          Object.assign(row, a.data);
          return row;
        },
        updateMany: async (a: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          rec("timeEntry.updateMany", a);
          const hit = H.entries.filter((r) => m(r, a.where));
          hit.forEach((r) => Object.assign(r, a.data));
          return { count: hit.length };
        },
      },
      task: {
        findFirst: async (a: { where: Record<string, unknown> }) => {
          rec("task.findFirst", a);
          return H.tasks.find((r) => m(r, a.where)) ?? null;
        },
        findUnique: async (a: { where: Record<string, unknown> }) => {
          rec("task.findUnique", a);
          return H.tasks.find((r) => m(r, a.where)) ?? null;
        },
        findMany: async (a: { where: Record<string, unknown> }) => {
          rec("task.findMany", a);
          return H.tasks.filter((r) => m(r, a.where));
        },
      },
      user: {
        findUnique: async (a: { where: Record<string, unknown> }) => {
          rec("user.findUnique", a);
          return H.users.find((r) => m(r, a.where)) ?? null;
        },
      },
    },
  };
});
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));

import {
  clockInAction,
  createManualEntryAction,
  heartbeatAction,
  updateTimeEntryAction,
} from "@/lib/actions/time";
import { MAX_MANUAL_ENTRY_MS } from "@/lib/time/thresholds";

const ADMIN = "u_admin";
const COMPANY = "c_nimbus";
const LIVE_TASK = "t_live";
const DEAD_TASK = "t_dead";

function signedIn(role: "admin" | "cofounder" | "member" = "admin", id = ADMIN) {
  H.session.value = { user: { id, companyId: COMPANY, role } };
}

function lastCall(path: string) {
  const hits = H.calls.filter((c) => c.path === path);
  return hits[hits.length - 1];
}
function dataOf(path: string): Record<string, unknown> {
  const call = lastCall(path);
  expect(call, `no ${path} was issued`).toBeDefined();
  return (call!.args.data ?? {}) as Record<string, unknown>;
}
function whereOf(path: string): Record<string, unknown> {
  const call = lastCall(path);
  expect(call, `no ${path} was issued`).toBeDefined();
  return (call!.args.where ?? {}) as Record<string, unknown>;
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    companyId: COMPANY,
    userId: ADMIN,
    userName: "Ayesha",
    taskId: null,
    taskTitle: null,
    note: null,
    clockInAt: new Date(Date.now() - 5 * HR),
    clockOutAt: new Date(Date.now() - 4 * HR),
    lastActivityAt: new Date(Date.now() - 4 * HR),
    autoClosed: false,
    deletedAt: null,
    projectId: null,
    projectName: null,
    editedBy: null,
    editedByName: null,
    editedAt: null,
    ...over,
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.entries.length = 0;
  H.tasks.length = 0;
  H.users.length = 0;
  H.nextId.n = 0;
  H.users.push({ id: ADMIN, name: "Ayesha", companyId: COMPANY, deletedAt: null });
  H.tasks.push({
    id: LIVE_TASK,
    companyId: COMPANY,
    title: "Ship the invoice screen",
    deletedAt: null,
    projectId: "p_nimbus",
    project: { id: "p_nimbus", name: "Nimbus Rebuild" },
  });
  H.tasks.push({
    id: DEAD_TASK,
    companyId: COMPANY,
    title: "Terminate a contract",
    deletedAt: new Date("2026-09-01T00:00:00.000Z"),
    projectId: "p_nimbus",
    project: { id: "p_nimbus", name: "Nimbus Rebuild" },
  });
  signedIn();
});

/* --------------------------------- time-003 --------------------------------- */

describe("time-003 - a tombstoned task is not a clock-in target", () => {
  it("refuses a soft-deleted task on a manual entry", async () => {
    const res = await createManualEntryAction({
      clockInAt: new Date(Date.now() - 3 * HR),
      clockOutAt: new Date(Date.now() - 2 * HR),
      taskId: DEAD_TASK,
    });
    expect(res.success, "a deleted task was accepted as a manual entry's tag").toBe(false);
    if (!res.success) expect(res.error).toBe("Task not found");
    expect(lastCall("timeEntry.create"), "nothing should have been written").toBeUndefined();
  });

  it("asks the question at the data boundary, not after the row arrives", async () => {
    await createManualEntryAction({
      clockInAt: new Date(Date.now() - 3 * HR),
      clockOutAt: new Date(Date.now() - 2 * HR),
      taskId: LIVE_TASK,
    });
    const where = whereOf("task.findFirst");
    expect(where.deletedAt, "the tombstone filter belongs in the predicate").toBeNull();
    expect(where.companyId, "so does the tenant, not an `if` afterwards").toBe(COMPANY);
  });

  it("refuses a soft-deleted task on the admin edit", async () => {
    H.entries.push(entry());
    const res = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 4 * HR),
      taskId: DEAD_TASK,
    });
    expect(res.success, "a deleted task was accepted as the edit's new tag").toBe(false);
    if (!res.success) expect(res.error).toBe("Task not found");
  });
});

/* --------------------------------- time-004 --------------------------------- */

describe("time-004 - the entry carries the task's project, so hours roll up", () => {
  it("stamps projectId + projectName when clocking in against a task", async () => {
    const res = await clockInAction({ taskId: LIVE_TASK });
    expect(res.success).toBe(true);
    const data = dataOf("timeEntry.create");
    expect(data.projectId, "/projects rolls hours up by projectId; NULL reads as 0m").toBe(
      "p_nimbus"
    );
    expect(data.projectName).toBe("Nimbus Rebuild");
  });

  it("leaves both null for untagged general work", async () => {
    const res = await clockInAction({});
    expect(res.success).toBe(true);
    const data = dataOf("timeEntry.create");
    expect(data.projectId ?? null).toBeNull();
    expect(data.projectName ?? null).toBeNull();
  });

  it("stamps them on a manual entry too", async () => {
    const res = await createManualEntryAction({
      clockInAt: new Date(Date.now() - 3 * HR),
      clockOutAt: new Date(Date.now() - 2 * HR),
      taskId: LIVE_TASK,
    });
    expect(res.success).toBe(true);
    const data = dataOf("timeEntry.create");
    expect(data.projectId).toBe("p_nimbus");
    expect(data.projectName).toBe("Nimbus Rebuild");
  });

  it("re-points them when an admin re-tags an entry, and clears them when untagged", async () => {
    H.entries.push(entry());
    const tagged = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 4 * HR),
      taskId: LIVE_TASK,
    });
    expect(tagged.success).toBe(true);
    expect(dataOf("timeEntry.update").projectId).toBe("p_nimbus");
    expect(dataOf("timeEntry.update").projectName).toBe("Nimbus Rebuild");

    const untagged = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 4 * HR),
      taskId: null,
    });
    expect(untagged.success).toBe(true);
    expect(dataOf("timeEntry.update").projectId).toBeNull();
    expect(dataOf("timeEntry.update").projectName).toBeNull();
  });

  it("asks the task read for the project, rather than inferring it client-side", async () => {
    await clockInAction({ taskId: LIVE_TASK });
    const select = lastCall("task.findFirst")!.args.select as Record<string, unknown>;
    expect(select.project, "the project has to be part of the task lookup").toBeTruthy();
  });
});

/* --------------------------------- time-005 --------------------------------- */

describe("time-005 - the overlap rule is the same rule on all three write paths", () => {
  /*
   * WHY THIS BLOCK EXISTS SEPARATELY FROM THE ONE BELOW. time-005's probe went
   * into `createManualEntryAction` only, so the product refused an overlap you
   * TYPED and accepted the identical overlap by two other routes. An inconsistent
   * rule is worse than a missing one: the user learns it from one screen and is
   * then contradicted by another, and either way an hours-based invoice
   * double-counts. Found by adversarial verification.
   */

  it("refuses a live clock-in that lands inside hours already logged", async () => {
    // Hand-logged 09:00-12:00, and it is 10:00. The pre-existing check asks only
    // whether another entry is OPEN, which this row is not, so both rows stood.
    H.entries.push(
      entry({
        id: "e_logged",
        clockInAt: new Date(Date.now() - 1 * HR),
        clockOutAt: new Date(Date.now() + 1 * HR),
      })
    );

    const res = await clockInAction({});

    expect(res.success, "clocking in inside logged hours double-counts them").toBe(false);
    if (!res.success) expect(res.error).toMatch(/overlap/i);
    expect(
      H.calls.filter((c) => c.path === "timeEntry.create"),
      "a refusal must not still write the row"
    ).toHaveLength(0);
  });

  it("still lets someone clock in when nothing live covers this moment", async () => {
    // The control. Without it the fix could be "never allow a clock-in", which
    // every other case in this file would happily accept.
    H.entries.push(
      entry({
        id: "e_earlier",
        clockInAt: new Date(Date.now() - 5 * HR),
        clockOutAt: new Date(Date.now() - 4 * HR),
      })
    );

    const res = await clockInAction({});

    expect(res.success, "an ordinary clock-in after a finished session was refused").toBe(true);
  });

  it("refuses an admin edit that drags a row across another of that person's sessions", async () => {
    // The widest-reach path: an admin editing somebody ELSE's timesheet. The same
    // hour then appears in two rows and the person whose hours they are never sees
    // it happen.
    H.entries.push(
      entry({
        id: "e_keep",
        clockInAt: new Date(Date.now() - 5 * HR),
        clockOutAt: new Date(Date.now() - 3 * HR),
      }),
      entry({
        id: "e_move",
        clockInAt: new Date(Date.now() - 2 * HR),
        clockOutAt: new Date(Date.now() - 1 * HR),
      })
    );

    const res = await updateTimeEntryAction({
      entryId: "e_move",
      clockInAt: new Date(Date.now() - 4 * HR),
      clockOutAt: new Date(Date.now() - 3.5 * HR),
    });

    expect(res.success, "the edit manufactured exactly the overlap the create path refuses").toBe(
      false
    );
    if (!res.success) expect(res.error).toMatch(/overlap/i);
  });

  it("does not refuse a row for overlapping ITSELF", async () => {
    // `excludeEntryId` is the whole subtlety of applying the probe to the edit
    // path: without it every edit collides with the row being edited, and the
    // modal becomes impossible to save. This is the case that would have caught
    // that, and it is why the helper takes the parameter at all.
    H.entries.push(
      entry({
        id: "e_solo",
        clockInAt: new Date(Date.now() - 5 * HR),
        clockOutAt: new Date(Date.now() - 4 * HR),
      })
    );

    const res = await updateTimeEntryAction({
      entryId: "e_solo",
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 3 * HR),
    });

    expect(res.success, "an ordinary edit was refused as an overlap with itself").toBe(true);
  });
});

describe("time-005 - a manual entry cannot overlap another", () => {
  it("refuses a window that overlaps an existing session", async () => {
    H.entries.push(
      entry({
        id: "e_existing",
        clockInAt: new Date(Date.now() - 6 * HR),
        clockOutAt: new Date(Date.now() - 3 * HR),
      })
    );
    // 10:00 -> 13:00 against an existing 09:00 -> 12:00: the 10-12 hours would be
    // counted twice, which needs no malice at all - two tasks, one afternoon.
    const res = await createManualEntryAction({
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 2 * HR),
    });
    expect(res.success, "the overlapping hours were double-counted").toBe(false);
    expect(H.entries.filter((e) => e.id !== "e_existing")).toHaveLength(0);
  });

  it("refuses a window that swallows a still-running session", async () => {
    H.entries.push(
      entry({
        id: "e_open",
        clockInAt: new Date(Date.now() - 4 * HR),
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 10 * MIN),
      })
    );
    const res = await createManualEntryAction({
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 1 * HR),
    });
    expect(res.success).toBe(false);
  });

  it("allows a window that merely abuts an existing session", async () => {
    const twelve = new Date(Date.now() - 3 * HR);
    H.entries.push(
      entry({
        id: "e_existing",
        clockInAt: new Date(Date.now() - 6 * HR),
        clockOutAt: twelve,
      })
    );
    // 12:00 -> 13:00, starting exactly where the other ended. Back-to-back
    // sessions are the normal case and must not be refused.
    const res = await createManualEntryAction({
      clockInAt: twelve,
      clockOutAt: new Date(Date.now() - 2 * HR),
    });
    expect(res.success, "back-to-back sessions are legal").toBe(true);
  });

  it("ignores a tombstoned entry when looking for an overlap", async () => {
    H.entries.push(
      entry({
        id: "e_deleted",
        clockInAt: new Date(Date.now() - 6 * HR),
        clockOutAt: new Date(Date.now() - 3 * HR),
        deletedAt: new Date(),
      })
    );
    const res = await createManualEntryAction({
      clockInAt: new Date(Date.now() - 5 * HR),
      clockOutAt: new Date(Date.now() - 4 * HR),
    });
    expect(res.success, "a deleted entry must not block a re-log of the same hours").toBe(true);
  });

  it("scopes the overlap probe to the caller's own rows", async () => {
    await createManualEntryAction({
      clockInAt: new Date(Date.now() - 3 * HR),
      clockOutAt: new Date(Date.now() - 2 * HR),
    });
    const probe = H.calls.find(
      (c) => c.path === "timeEntry.findFirst" || c.path === "timeEntry.count"
    );
    expect(probe, "no overlap probe was issued at all").toBeDefined();
    const where = (probe!.args.where ?? {}) as Record<string, unknown>;
    expect(where.userId).toBe(ADMIN);
    expect(where.deletedAt).toBeNull();
  });
});

/* --------------------------------- time-006 --------------------------------- */

describe("time-006 - the admin edit cannot open a second clock", () => {
  it("refuses to blank the clock-out while the owner already has a live session", async () => {
    H.entries.push(
      entry({
        id: "e_open",
        clockInAt: new Date(Date.now() - 2 * HR),
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 10 * MIN),
      })
    );
    H.entries.push(
      entry({
        id: "e_closed",
        clockInAt: new Date(Date.now() - 30 * HR),
        clockOutAt: new Date(Date.now() - 29 * HR),
        lastActivityAt: new Date(Date.now() - 29 * HR),
      })
    );
    const res = await updateTimeEntryAction({
      entryId: "e_closed",
      clockInAt: new Date(Date.now() - 30 * HR),
      clockOutAt: null,
    });
    expect(res.success, "two rows with clockOutAt = null for one user").toBe(false);
    expect(H.entries.filter((e) => e.clockOutAt === null)).toHaveLength(1);
  });

  it("still lets an admin edit the user's ONE open entry and leave it open", async () => {
    H.entries.push(
      entry({
        id: "e_open",
        clockInAt: new Date(Date.now() - 2 * HR),
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 10 * MIN),
      })
    );
    const res = await updateTimeEntryAction({
      entryId: "e_open",
      clockInAt: new Date(Date.now() - 3 * HR),
      clockOutAt: null,
      note: "corrected start",
    });
    expect(res.success, "the entry being edited is not a competing open entry").toBe(true);
  });

  it("does not count another PERSON's open entry against this one", async () => {
    H.entries.push(
      entry({
        id: "e_other_open",
        userId: "u_other",
        clockInAt: new Date(Date.now() - 2 * HR),
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 10 * MIN),
      })
    );
    H.entries.push(
      entry({
        id: "e_closed",
        clockInAt: new Date(Date.now() - 30 * HR),
        clockOutAt: new Date(Date.now() - 29 * HR),
        lastActivityAt: new Date(Date.now() - 29 * HR),
      })
    );
    const res = await updateTimeEntryAction({
      entryId: "e_closed",
      clockInAt: new Date(Date.now() - 30 * HR),
      clockOutAt: null,
    });
    expect(res.success, "the one-open-entry rule is per user").toBe(true);
  });
});

/* --------------------------------- time-007 --------------------------------- */

describe("time-007 - reopening an entry cannot leave the sweep able to zero it", () => {
  it("moves lastActivityAt forward so it is never behind the new clockInAt", async () => {
    // The input the cron turns into 0m: lastActivityAt hours BEHIND clockInAt.
    // sweepAutoCloseEntries writes `clockOutAt = lastActivityAt`, and durationMs
    // clamps a negative interval to zero, so the hours are destroyed silently by
    // a background job hours after the admin left.
    const newStart = new Date(Date.now() - 5 * MIN);
    H.entries.push(
      entry({
        clockInAt: new Date(Date.now() - 30 * HR),
        clockOutAt: new Date(Date.now() - 29 * HR),
        lastActivityAt: new Date(Date.now() - 29 * HR),
      })
    );
    const res = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: newStart,
      clockOutAt: null,
    });
    expect(res.success).toBe(true);
    const row = H.entries.find((e) => e.id === "e1")!;
    expect(row.lastActivityAt).toBeInstanceOf(Date);
    expect(
      (row.lastActivityAt as Date).getTime(),
      "lastActivityAt behind clockInAt is exactly what the sweep turns into 0m"
    ).toBeGreaterThanOrEqual(newStart.getTime());
  });
});

/* --------------------------------- time-008 --------------------------------- */

describe("time-008 - a human correction clears the auto-closed badge", () => {
  it("sets autoClosed false when a human supplies the clock-out", async () => {
    H.entries.push(
      entry({
        clockInAt: new Date(Date.now() - 30 * HR),
        clockOutAt: new Date(Date.now() - 20 * HR),
        lastActivityAt: new Date(Date.now() - 20 * HR),
        autoClosed: true,
      })
    );
    const res = await updateTimeEntryAction({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 30 * HR),
      clockOutAt: new Date(Date.now() - 27 * HR),
    });
    expect(res.success).toBe(true);
    expect(
      H.entries.find((e) => e.id === "e1")!.autoClosed,
      "the badge means nobody typed these times, and somebody just did"
    ).toBe(false);
  });
});

/* --------------------------------- time-015 --------------------------------- */

describe("time-015 - a heartbeat cannot keep a session alive for ever", () => {
  it("closes an entry that has been open past the auto-close horizon", async () => {
    // The real-world shape: a tab parked on a second monitor. <ClockWidget>
    // heartbeats every HEARTBEAT_MS whenever `document.hidden` is false, so
    // lastActivityAt is always fresh, `entryState` never leaves "active", and the
    // nightly sweep's `lastActivityAt: { lt: cutoff }` never matches. A timer
    // started Friday afternoon was still counting on Monday. heartbeatAction
    // refused only if the entry was ALREADY closed - it never asked how long the
    // entry had been running.
    const clockIn = new Date(Date.now() - 40 * HR);
    H.entries.push(
      entry({
        id: "e_marathon",
        clockInAt: clockIn,
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 1 * MIN),
      })
    );

    const res = await heartbeatAction({ entryId: "e_marathon" });

    expect(res.success, "the heartbeat was accepted on a 40-hour session").toBe(false);
    const row = H.entries.find((e) => e.id === "e_marathon")!;
    expect(row.clockOutAt, "the row is still open and still accruing").not.toBeNull();
    expect((row.clockOutAt as Date).getTime()).toBe(clockIn.getTime() + MAX_MANUAL_ENTRY_MS);
    expect(row.autoClosed, "nothing would warn anyone that the figure is junk").toBe(true);
  });

  it("does NOT close a long day that somebody actually worked", async () => {
    /*
     * THE CEILING MOVED FROM AUTO_CLOSE_MS (12.5h) TO MAX_MANUAL_ENTRY_MS (24h),
     * and this case is why. The original fix used the IDLE horizon, which is
     * correct for the nightly sweep — that keys on a stale `lastActivityAt`, i.e.
     * on nobody being there. It is the wrong question here: a heartbeat only
     * arrives while `document.hidden` is false, so reaching the branch at all is
     * evidence the person IS present. A fourteen-hour day lost 1.5h and was
     * labelled idle.
     *
     * 24h is this repo's own answer to "when does a duration stop being
     * plausible" — `MAX_MANUAL_ENTRY_MS`, whose docstring argues it is
     * deliberately looser than AUTO_CLOSE_MS because "a 20-hour launch night is a
     * thing people really log". An attended live session should not be held to a
     * stricter ceiling than a typed one.
     *
     * The 40-hour case above still closes, so this is not "remove the ceiling":
     * while heartbeats keep arriving the sweep never fires, and a tab left visible
     * on an unattended monitor would otherwise run for ever.
     */
    const clockIn = new Date(Date.now() - 14 * HR);
    H.entries.push(
      entry({
        id: "e_long_day",
        clockInAt: clockIn,
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 1 * MIN),
      })
    );

    const res = await heartbeatAction({ entryId: "e_long_day" });

    expect(res.success, "a present worker's 14-hour session was cut short").toBe(true);
    const row = H.entries.find((e) => e.id === "e_long_day")!;
    expect(row.clockOutAt, "still running, as it should be").toBeNull();
    expect(row.autoClosed, "nothing was auto-closed, so nothing may be badged").toBe(false);
  });

  it("does not move lastActivityAt on the session it just closed", async () => {
    const clockIn = new Date(Date.now() - 40 * HR);
    const lastSeen = new Date(Date.now() - 1 * MIN);
    H.entries.push(
      entry({
        id: "e_marathon",
        clockInAt: clockIn,
        clockOutAt: null,
        lastActivityAt: lastSeen,
      })
    );
    await heartbeatAction({ entryId: "e_marathon" });
    const row = H.entries.find((e) => e.id === "e_marathon")!;
    expect((row.lastActivityAt as Date).getTime()).toBe(lastSeen.getTime());
  });

  it("accepts an ordinary heartbeat on a session inside the horizon", async () => {
    // Guard-the-guard: the bound must not break the thing heartbeats are for.
    H.entries.push(
      entry({
        id: "e_normal",
        clockInAt: new Date(Date.now() - 3 * HR),
        clockOutAt: null,
        lastActivityAt: new Date(Date.now() - 5 * MIN),
      })
    );
    const res = await heartbeatAction({ entryId: "e_normal" });
    expect(res.success).toBe(true);
    const row = H.entries.find((e) => e.id === "e_normal")!;
    expect(row.clockOutAt).toBeNull();
    expect((row.lastActivityAt as Date).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });
});
