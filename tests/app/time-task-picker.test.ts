/**
 * /time fills a `<select>`. It must not read the whole task table to do it.
 *
 * THE FINDING (perf-002 / the reachability wave's third row). `listTaskOptions`
 * in lib/queries/tasks.ts was written, reviewed and unit-tested for exactly one
 * purpose — "the /time edit modal's dropdown" says so in its own docstring —
 * and then nothing called it. /time kept calling `getTasks()`, which is
 * `getTaskPage()`: a 300-row window with a `_count: { comments: true }`
 * subquery and a `project: { select: { name: true } }` join PER ROW, whose
 * every field then crosses the RSC boundary so that `page.tsx` can immediately
 * throw all but two of them away:
 *
 *     const taskOptions = tasks.map((t) => ({ id: t.id, title: t.title }));
 *
 * That is the shape this repo keeps shipping: a correct, tested decision with
 * no road to it. A green test on `listTaskOptions` proves only that the
 * function works; it says nothing about whether any customer's /time request is
 * cheaper. So this file asserts on the QUERY THE PAGE ACTUALLY ISSUES, with a
 * recording Prisma client in place of a database.
 *
 * WHAT IS AND IS NOT MOCKED. lib/queries/tasks.ts is deliberately NOT mocked —
 * it is the thing under test, and a test that asserted "the page called a stub
 * named listTaskOptions" would pass just as happily against a stub that read
 * the whole table. The session is mocked (there is no cookie here) and the
 * page's client island is stubbed so the component tree stays out of the module
 * graph; everything else is real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedSession } from "@/lib/queries/session";

type RecordedCall = { delegate: string; method: string; args: Record<string, unknown> };

const prisma = vi.hoisted(() => {
  const calls: Array<{ delegate: string; method: string; args: Record<string, unknown> }> = [];
  const answers = new Map<string, unknown>();

  /** Narrow each answer row to the keys a `select` asked for, as Prisma does. */
  function project(answer: unknown, select: unknown): unknown {
    if (!select || typeof select !== "object" || !Array.isArray(answer)) return answer;
    const keys = Object.keys(select as Record<string, unknown>).filter(
      (k) => (select as Record<string, unknown>)[k]
    );
    return answer.map((row) => {
      if (!row || typeof row !== "object") return row;
      const out: Record<string, unknown> = {};
      keys.forEach((k) => {
        out[k] = (row as Record<string, unknown>)[k];
      });
      return out;
    });
  }

  // A Proxy rather than a hand-written fake: if this page's read graph grows a
  // delegate later, the call is still recorded instead of throwing
  // "db.foo is undefined" and sending someone to edit this file.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_t, method) {
          if (typeof method !== "string") return undefined;
          return (args?: Record<string, unknown>) => {
            const a = args ?? {};
            calls.push({ delegate: name, method, args: a });
            const key = name + "." + method;
            // Default [] rather than null: every read on this page maps its
            // result, so an unanswered delegate should come back empty, not
            // explode somewhere unrelated to the assertion.
            const answer = answers.has(key) ? answers.get(key) : [];
            // Honour `select` the way Prisma does. Without this the fake hands
            // back every column whatever was asked for, and "the picker gets
            // two columns" would pass against the whole-table read — the fake
            // would be hiding the exact defect this file exists to catch.
            return Promise.resolve(project(answer, a.select));
          };
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const session = vi.hoisted(() => ({
  current: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.current),
}));
vi.mock("@/app/(app)/time/time-client", () => ({ TimeClient: () => null }));

/** A task row with every column the BOARD read would want, so the old
 *  whole-table path gets far enough to be judged on its query rather than
 *  dying in `toClient` on a missing `deadline`. */
function fullTaskRow() {
  return {
    id: "k1",
    companyId: "c_nimbus",
    projectId: "p1",
    title: "Ship the invoice screen",
    description: "",
    status: "pending",
    priority: "high",
    assignedTo: "u_admin",
    assignedToName: "Ayesha",
    assignedBy: "u_admin",
    assignedByName: "Ayesha",
    deadline: new Date("2026-10-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    completedAt: null,
    order: 0,
    project: { name: "Nimbus" },
    _count: { comments: 4 },
  };
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.answers.set("task.findMany", [fullTaskRow()]);
  session.current = {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  };
});

function taskReads(): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === "task");
}

async function renderTimePage(searchParams: { scope?: string } = {}) {
  const mod = await import("@/app/(app)/time/page");
  const element = (await mod.default({ searchParams })) as unknown as {
    props: Record<string, unknown>;
  };
  return element;
}

describe("/time's task picker reads two columns, not the board", () => {
  it("asks for id + title only — no comment-count subquery, no project join", async () => {
    await renderTimePage();

    const reads = taskReads();
    expect(reads, "/time reads tasks exactly once, to fill the picker").toHaveLength(1);
    const args = reads[0].args;

    expect(
      args.select,
      "the picker needs two columns; selecting nothing means selecting every column"
    ).toEqual({ id: true, title: true });
    expect(
      args.include,
      "`include` here is the _count-of-comments subquery and the per-row project " +
        "join that the board needs and a `<select>` does not"
    ).toBeUndefined();
    expect(typeof args.take, "an unbounded picker read is the original bug").toBe("number");
  });

  it("keeps the role, tombstone and project-status boundary the board enforces", async () => {
    // The cheap version of this fix is a raw `db.task.findMany({ select })` in
    // the page, which would drop every one of these. They live in ONE shared
    // `where` in lib/queries/tasks.ts precisely so a second read cannot
    // disagree with the board about which tasks exist.
    await renderTimePage();

    const where = (taskReads()[0].args.where ?? {}) as Record<string, unknown>;
    expect(where.companyId).toBe("c_nimbus");
    expect(where.deletedAt, "a tombstoned task must not be offerable in the picker").toBeNull();
    expect(
      where.project,
      "a deleted/completed/archived project's tasks are off the global board"
    ).toEqual({ deletedAt: null, status: { notIn: ["completed", "archived"] } });
  });

  it("hands the picker exactly the rows the query returned", async () => {
    // The wiring half. A bounded query whose result never reaches the client
    // island is the same defect one layer down.
    const element = await renderTimePage();
    expect(element.props.tasks).toEqual([{ id: "k1", title: "Ship the invoice screen" }]);
  });

  it("reads no tasks at all for a member, who never opens the edit modal", async () => {
    session.current = { ...session.current, userId: "u_member", role: "member" };
    const element = await renderTimePage();

    expect(taskReads(), "a member cannot edit entry times, so the picker is never drawn").toEqual(
      []
    );
    expect(element.props.tasks).toEqual([]);
  });
});
