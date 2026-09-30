// @vitest-environment node

/**
 * data-integrity-010, the two halves an action test cannot cover: the numbers the
 * panel shows, and whether the panel is reached at all.
 *
 * `tests/lib/actions/project-restore.test.ts` drives `restoreProjectAction`. But
 * this codebase's most-repeated defect is a complete, tested feature with no
 * caller — ~10 documented instances, including the Runway card, which had a
 * component and an action and passing tests and no entry point. A restore action
 * nobody can reach closes this finding on paper and leaves the customer exactly
 * where they were: unable to see that the deleted project exists. So the last
 * describe block below asserts the WIRING, and it is the assertion that was red
 * before this change.
 *
 * The countdown is the other thing worth a test of its own. `daysUntilPurge` is
 * computed on the SERVER deliberately — it is the difference between "you can
 * still get this back" and "it is gone", and a customer's browser clock an hour
 * fast must not close the window early. And it is asserted against the purge
 * route's OWN retention literal, read out of that file, because a countdown that
 * disagrees with the job doing the deleting is worse than no countdown: it would
 * promise days that do not exist.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  color: string;
  status: string;
  supervisorId: string;
  deletedAt: Date | null;
  supervisor: { name: string } | null;
};

const H = vi.hoisted(() => ({
  projects: [] as unknown[],
  session: { userId: "u_ayesha", companyId: "c_nimbus", role: "admin" },
  /** Every `where` the query issued, so a test can assert the scope itself. */
  queries: [] as unknown[],
}));

function rows(): ProjectRow[] {
  return H.projects as ProjectRow[];
}

vi.mock("@/lib/db", () => ({
  db: {
    project: {
      findMany: async (a: { where: Record<string, unknown> }) => {
        H.queries.push(a.where);
        const where = a.where;
        return rows().filter((r) => {
          if (where.companyId && r.companyId !== where.companyId) return false;
          const d = where.deletedAt as { not?: unknown } | undefined;
          if (d && d.not === null && r.deletedAt === null) return false;
          if (where.supervisorId && r.supervisorId !== where.supervisorId) return false;
          return true;
        });
      },
    },
    timeEntry: { groupBy: async () => [] },
    transaction: { groupBy: async () => [], aggregate: async () => ({ _sum: {} }) },
    budget: { findMany: async () => [] },
    task: { count: async () => 0, findMany: async () => [] },
  },
}));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => H.session,
}));

import { listDeletedProjectsForUser, PROJECT_RETENTION_DAYS } from "@/lib/queries/projects";

const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function deletedProject(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "p_apollo",
    companyId: "c_nimbus",
    name: "Apollo",
    color: "#7c5cff",
    status: "active",
    supervisorId: "u_super",
    deletedAt: new Date(NOW.getTime() - 10 * DAY),
    supervisor: { name: "Sana" },
    ...over,
  };
}

beforeEach(() => {
  H.projects.length = 0;
  H.queries.length = 0;
  H.session = { userId: "u_ayesha", companyId: "c_nimbus", role: "admin" };
});

describe("data-integrity-010 — the panel's numbers", () => {
  it("counts the days left from the tombstone, not from now", async () => {
    H.projects.push(deletedProject());
    const [p] = await listDeletedProjectsForUser(NOW);
    expect(p.daysUntilPurge).toBe(PROJECT_RETENTION_DAYS - 10);
    expect(p.name).toBe("Apollo");
    expect(p.supervisorName).toBe("Sana");
  });

  it("never promises a negative window on a project the purge has not reached yet", async () => {
    // The purge runs nightly and takes at most ten workspaces a run, so a row can
    // outlive its own deadline. "-4 days left to restore" is not a sentence.
    H.projects.push(deletedProject({ deletedAt: new Date(NOW.getTime() - 94 * DAY) }));
    const [p] = await listDeletedProjectsForUser(NOW);
    expect(p.daysUntilPurge).toBe(0);
  });

  it("floors rather than rounds, so it never over-promises by a day", async () => {
    H.projects.push(deletedProject({ deletedAt: new Date(NOW.getTime() - 9.6 * DAY) }));
    const [p] = await listDeletedProjectsForUser(NOW);
    expect(p.daysUntilPurge).toBe(PROJECT_RETENTION_DAYS - 10);
  });

  it("agrees with the purge cron's own retention literal", () => {
    // Read out of the route rather than repeated here. The route is a Next.js
    // Route Handler and cannot export a constant, so the two numbers are separate
    // declarations — and this is what stops them drifting into a countdown that
    // promises days the job will not honour.
    const route = readFileSync(
      join(process.cwd(), "app", "api", "cron", "purge-soft-deleted", "route.ts"),
      "utf8"
    );
    const found = /const\s+RETENTION_DAYS\s*=\s*(\d+)/.exec(route);
    expect(found, "RETENTION_DAYS is gone from the purge route").not.toBeNull();
    expect(Number(found?.[1])).toBe(PROJECT_RETENTION_DAYS);
  });

  it("returns an ISO string, so the date survives the RSC boundary", async () => {
    H.projects.push(deletedProject());
    const [p] = await listDeletedProjectsForUser(NOW);
    expect(typeof p.deletedAt).toBe("string");
    expect(p.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("data-integrity-010 — who sees which deleted projects", () => {
  it("shows a founder every deleted project in the workspace", async () => {
    H.projects.push(deletedProject({ id: "p_1" }), deletedProject({ id: "p_2" }));
    const list = await listDeletedProjectsForUser(NOW);
    expect(list.map((p) => p.id)).toEqual(["p_1", "p_2"]);
  });

  it("shows a member only the ones they supervised", async () => {
    H.session = { userId: "u_member", companyId: "c_nimbus", role: "member" };
    H.projects.push(
      deletedProject({ id: "p_mine", supervisorId: "u_member" }),
      deletedProject({ id: "p_theirs", supervisorId: "u_other" })
    );
    const list = await listDeletedProjectsForUser(NOW);
    expect(list.map((p) => p.id)).toEqual(["p_mine"]);
    // Asserted on the query, not on the result: filtering afterwards would put
    // the other project's name in the RSC payload.
    expect(H.queries[0]).toMatchObject({ supervisorId: "u_member" });
  });

  it("never leaves a live project in the list", async () => {
    H.projects.push(
      deletedProject({ id: "p_dead" }),
      deletedProject({ id: "p_live", deletedAt: null })
    );
    const list = await listDeletedProjectsForUser(NOW);
    expect(list.map((p) => p.id)).toEqual(["p_dead"]);
    expect(H.queries[0]).toMatchObject({ deletedAt: { not: null } });
  });

  it("scopes to the caller's workspace", async () => {
    H.projects.push(deletedProject({ companyId: "c_other" }));
    expect(await listDeletedProjectsForUser(NOW)).toEqual([]);
  });
});

describe("data-integrity-010 — the panel is actually reachable", () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  it("the /projects server component loads the deleted list and passes it down", () => {
    // RED BEFORE THIS CHANGE. An action and a query with no caller close nothing —
    // that is this repo's most-repeated defect, ~10 documented instances.
    const page = read("app", "(app)", "projects", "page.tsx");
    expect(page).toContain("listDeletedProjectsForUser");
    expect(page).toMatch(/deletedProjects=\{deletedProjects\}/);
  });

  it("the client renders the panel and wires the restore action to it", () => {
    const client = read("app", "(app)", "projects", "projects-client.tsx");
    expect(client).toContain("restoreProjectAction");
    expect(client).toContain("RecentlyDeletedProjects");
    expect(client).toMatch(/<RecentlyDeletedProjects\s+projects=\{deletedProjects\}/);
  });

  it("something in the product finally clears Project.deletedAt", () => {
    // The sentence this finding turns on: "a grep for `deletedAt: null` writes
    // across lib/ and app/ finds only reactivateUserAction". This asserts the
    // project half of that grep now has an answer, in a `data:` bag — not in a
    // read filter, which is what nearly every `deletedAt: null` in this codebase
    // is and which would make a naive version of this test pass on day one.
    const actions = read("lib", "actions", "projects.ts");
    expect(actions).toMatch(
      /project\.updateMany\([\s\S]{0,300}?data:\s*\{\s*deletedAt:\s*null\s*\}/
    );
  });
});
