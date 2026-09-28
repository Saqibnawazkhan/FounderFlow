/**
 * The finance wall, on the notification surface. Finding sec-005.
 *
 * WHAT WAS WRONG. `addTransactionAction` fans `transaction_logged` at every
 * other user in the company with `message: "<name> logged <amount> PKR"`. When
 * the expense carries a projectId the link is `/projects/<id>`, which is NOT in
 * MEMBER_BLOCKED_ROUTES — and the read-side filter tested ONE predicate, "is
 * this row's link a member-blocked route". So every project-tagged expense
 * broadcast its rupee figure to every member's bell dropdown and
 * /notifications page, on ordinary use, with no forged request and no devtools.
 * `Notification.projectId`'s own schema comment and lib/notify/fan-out.ts's doc
 * comment both described a project-scoped finance filter that did not exist.
 *
 * TWO HALVES, AND THEY ARE NOT THE SAME HALF.
 *
 *   • READ TIME — `visibleNotifications`. Keeps the in-app surfaces honest and,
 *     importantly, keeps the rows ALREADY IN THE TABLE from being served. The
 *     tests in the first describe below are its contract; it had none.
 *   • FAN-OUT TIME — `financeRecipients`. `notifyUsers` fires push and email
 *     BEFORE any reader ever calls a read filter, so a member with
 *     `transaction_logged` push or email switched on receives the figure on
 *     their lock screen and in their inbox, where no read-time filter can ever
 *     reach it. That is why the decision has to exist as something the fan-out
 *     path can call, and why it lives here beside the read rule: the two must
 *     agree, and a second copy in lib/notify/ is how they would drift.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Same reasoning as
 * tests/lib/queries/search-scoping.test.ts: there is no database, so the Prisma
 * client is a recorder. `lib/auth/**` is NOT mocked — `canSeeFinances` is the
 * real predicate, the same one the middleware and the write gates obey.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeRecipients, visibleNotifications } from "@/lib/queries/notifications";

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
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
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.reject(new Error("not used by these tests")),
}));

const ADMIN = "u_admin";
const COFOUNDER = "u_cofounder";
const SUPERVISOR = "u_supervisor";
const MEMBER = "u_member";

/** The figure a member must never be told. Distinctive on purpose. */
const SECRET_MESSAGE = "Ayesha logged 2,500,000 PKR";

function financeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    category: "finance",
    // The link that got through: /projects/<id> is not a member-blocked route.
    link: "/projects/p_nimbus",
    projectId: "p_nimbus",
    message: SECRET_MESSAGE,
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "n2",
    category: "task",
    link: "/tasks?taskId=t1",
    projectId: "p_nimbus",
    message: "Ayesha assigned you a task",
    ...overrides,
  };
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.answers.set("project.findMany", []);
  prisma.answers.set("project.findFirst", null);
  prisma.answers.set("user.findMany", []);
});

describe("visibleNotifications — read time", () => {
  it("keeps a project-tagged finance ping away from a plain member", async () => {
    // The exact row that leaked: category finance, link /projects/<id>.
    const rows = [financeRow(), taskRow()];

    const visible = await visibleNotifications(rows, {
      userId: MEMBER,
      companyId: "c_nimbus",
      role: "member",
    });

    expect(visible.map((n) => n.id)).toEqual(["n2"]);
    expect(JSON.stringify(visible)).not.toContain(SECRET_MESSAGE);
  });

  it("filters on the category, not on the link", async () => {
    // The old filter could be dodged by pointing the link somewhere harmless,
    // which is exactly how the rupee figures got out. A finance row with no
    // link at all, or a link to /tasks, is still a finance row.
    const rows = [
      financeRow({ id: "no_link", link: null }),
      financeRow({ id: "harmless_link", link: "/tasks" }),
    ];

    const visible = await visibleNotifications(rows, {
      userId: MEMBER,
      companyId: "c_nimbus",
      role: "member",
    });

    expect(visible).toEqual([]);
  });

  it("drops a company-wide finance ping that carries no project scope", async () => {
    const visible = await visibleNotifications([financeRow({ projectId: null, link: null })], {
      userId: MEMBER,
      companyId: "c_nimbus",
      role: "member",
    });

    expect(visible).toEqual([]);
  });

  it("keeps a finance ping for the member who supervises that project", async () => {
    // The deliberate escape hatch from lib/auth/project-permissions.ts: a
    // member supervising THIS project sees THIS project's money. Removing it
    // would be a regression, not a tightening.
    prisma.answers.set("project.findMany", [{ id: "p_nimbus" }]);

    const visible = await visibleNotifications([financeRow()], {
      userId: SUPERVISOR,
      companyId: "c_nimbus",
      role: "member",
    });

    expect(visible.map((n) => n.id)).toEqual(["n1"]);
  });

  it("does not extend the hatch to a DIFFERENT project", async () => {
    // They supervise p_other; the ping is about p_nimbus.
    prisma.answers.set("project.findMany", [{ id: "p_other" }]);

    const visible = await visibleNotifications([financeRow()], {
      userId: SUPERVISOR,
      companyId: "c_nimbus",
      role: "member",
    });

    expect(visible).toEqual([]);
  });

  it("scopes the supervisor lookup to the reader's own company", async () => {
    prisma.answers.set("project.findMany", [{ id: "p_nimbus" }]);

    await visibleNotifications([financeRow()], {
      userId: SUPERVISOR,
      companyId: "c_nimbus",
      role: "member",
    });

    const lookups = prisma.calls.filter((c) => c.delegate === "project");
    expect(lookups).toHaveLength(1);
    const where = (lookups[0].args[0] as { where: Record<string, unknown> }).where;
    expect(where.companyId).toBe("c_nimbus");
    expect(where.supervisorId).toBe(SUPERVISOR);
    expect(where.deletedAt).toBeNull();
  });

  it("hands an admin every row untouched, without paying for a lookup", async () => {
    const rows = [financeRow(), taskRow()];

    const visible = await visibleNotifications(rows, {
      userId: ADMIN,
      companyId: "c_nimbus",
      role: "admin",
    });

    expect(visible).toEqual(rows);
    expect(prisma.calls).toEqual([]);
  });

  it("hands a cofounder every row too", async () => {
    // `canSeeFinances` is a two-role predicate; a gate written as
    // `role === "member" ? …` would pass the admin test and lock a cofounder
    // out of their own company's numbers.
    const rows = [financeRow()];

    const visible = await visibleNotifications(rows, {
      userId: COFOUNDER,
      companyId: "c_nimbus",
      role: "cofounder",
    });

    expect(visible).toEqual(rows);
  });
});

describe("financeRecipients — fan-out time, before push and email leave", () => {
  /**
   * THE HALF A READ FILTER CANNOT REACH. Push and email are fired from
   * `notifyUsers` before any reader calls `visibleNotifications`, so a member
   * who has `transaction_logged` push or email switched on gets the rupee
   * figure on their lock screen and in their inbox. The only place that can be
   * stopped is the recipient list.
   */
  it("drops a member from a project-tagged finance fan-out", async () => {
    prisma.answers.set("user.findMany", [
      { id: ADMIN, role: "admin" },
      { id: MEMBER, role: "member" },
    ]);
    prisma.answers.set("project.findFirst", { supervisorId: SUPERVISOR });

    const allowed = await financeRecipients([ADMIN, MEMBER], {
      companyId: "c_nimbus",
      projectId: "p_nimbus",
    });

    expect(allowed).toEqual([ADMIN]);
  });

  it("drops a member from a company-wide finance fan-out", async () => {
    prisma.answers.set("user.findMany", [
      { id: COFOUNDER, role: "cofounder" },
      { id: MEMBER, role: "member" },
    ]);

    const allowed = await financeRecipients([COFOUNDER, MEMBER], { companyId: "c_nimbus" });

    expect(allowed).toEqual([COFOUNDER]);
    // No project scope means no project lookup to pay for.
    expect(prisma.calls.filter((c) => c.delegate === "project")).toEqual([]);
  });

  it("keeps the supervisor of the project the ping is about", async () => {
    prisma.answers.set("user.findMany", [
      { id: SUPERVISOR, role: "member" },
      { id: MEMBER, role: "member" },
    ]);
    prisma.answers.set("project.findFirst", { supervisorId: SUPERVISOR });

    const allowed = await financeRecipients([SUPERVISOR, MEMBER], {
      companyId: "c_nimbus",
      projectId: "p_nimbus",
    });

    expect(allowed).toEqual([SUPERVISOR]);
  });

  it("does not keep a supervisor of some OTHER project", async () => {
    prisma.answers.set("user.findMany", [{ id: SUPERVISOR, role: "member" }]);
    // The ping is about a project this person does not supervise.
    prisma.answers.set("project.findFirst", { supervisorId: "u_somebody_else" });

    const allowed = await financeRecipients([SUPERVISOR], {
      companyId: "c_nimbus",
      projectId: "p_other",
    });

    expect(allowed).toEqual([]);
  });

  it("scopes both lookups to the company the event belongs to", async () => {
    prisma.answers.set("user.findMany", [{ id: ADMIN, role: "admin" }]);
    prisma.answers.set("project.findFirst", { supervisorId: SUPERVISOR });

    await financeRecipients([ADMIN], { companyId: "c_nimbus", projectId: "p_nimbus" });

    expect(prisma.calls.length).toBeGreaterThan(0);
    for (const call of prisma.calls) {
      const where = (call.args[0] as { where?: Record<string, unknown> } | undefined)?.where;
      expect(where, `${call.delegate}.${call.method} has no where clause`).toBeDefined();
      expect(where, `${call.delegate}.${call.method}`).toHaveProperty("companyId", "c_nimbus");
    }
  });

  it("drops a tombstoned account rather than mailing a workspace it was removed from", async () => {
    // The recipient query in lib/actions/transactions.ts did not filter
    // deletedAt at all (data-integrity-004). Routing finance fan-out through
    // here closes that on this path too.
    prisma.answers.set("user.findMany", [{ id: ADMIN, role: "admin" }]);

    await financeRecipients([ADMIN, "u_gone"], { companyId: "c_nimbus" });

    const lookups = prisma.calls.filter((c) => c.delegate === "user");
    const where = (lookups[0].args[0] as { where: Record<string, unknown> }).where;
    expect(where.deletedAt).toBeNull();
  });

  it("asks nothing at all for an empty recipient list", async () => {
    const allowed = await financeRecipients([], { companyId: "c_nimbus", projectId: "p_nimbus" });

    expect(allowed).toEqual([]);
    expect(prisma.calls).toEqual([]);
  });
});
