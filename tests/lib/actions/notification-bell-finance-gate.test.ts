/**
 * sec-005 residue — the TOPBAR BELL and the badge above it.
 *
 * WHAT WAS STILL WRONG. `visibleNotifications` (lib/queries/notifications.ts)
 * is the finance-visibility rule: a `finance`-CATEGORY row reaches a reader who
 * fails `canSeeFinances` only when it is scoped to a project that reader
 * SUPERVISES. It was written, reviewed and unit-tested with 15 cases — and its
 * only caller was `getNotifications`, i.e. the /notifications page.
 *
 * `listNotificationsAction` — the action behind the bell dropdown, which every
 * authenticated tab calls on mount — carried its own older copy that judged the
 * row's LINK alone. `addTransactionAction` fans `transaction_logged` at every
 * other user in the company with `message: "<name> logged <amount> PKR"`, and a
 * project-tagged expense links to `/projects/<id>`, which is not a
 * member-blocked route. So the rupee figure members are kept off finance pages
 * to protect still arrived in their bell, and a company-wide burn alert with no
 * link at all arrived there too (`if (!n.link) return true`).
 *
 * THE BADGE IS THE SAME DEFECT, IN SQL. `unreadNotificationCountAction` built
 * its exclusion out of `MEMBER_BLOCKED_ROUTES` link shapes, so it counted the
 * very rows the dropdown is supposed to hide: a number pointing at something
 * the reader cannot open, and a badge that will not clear.
 *
 * SO THESE TESTS ARE WRITTEN IN THE USER'S TERMS, not the code's:
 *   - a member's bell must contain no money;
 *   - a supervisor's bell must still contain their own project's money;
 *   - the number on the bell must equal the unread rows inside the bell.
 *
 * No database: the Prisma client is a fake that EVALUATES the `where` it is
 * handed against a fixture table, so the SQL-shaped count and the JS-shaped
 * list are judged against the same rows. `lib/auth/role-gates` and
 * `lib/queries/notifications` are the real modules — the rule under test is the
 * one the middleware and /notifications obey, not a restatement of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  userId: string;
  companyId: string;
  projectId: string | null;
  title: string;
  message: string;
  type: string;
  category: string;
  read: boolean;
  link: string | null;
  createdAt: Date;
};

const H = vi.hoisted(() => {
  return {
    rows: [] as unknown[],
    /** Project ids the signed-in reader supervises. */
    supervised: [] as string[],
    calls: [] as string[],
    session: { value: null as unknown },
  };
});

/**
 * The slice of Prisma's filter language these two code paths use. Anything
 * outside it throws rather than silently matching nothing — a fake that answers
 * "no rows" to a clause it does not understand would make a broken query look
 * like a safe one.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  const keys = Object.keys(where);
  for (const key of keys) {
    const val = where[key];
    if (key === "OR") {
      const clauses = val as Array<Record<string, unknown>>;
      let any = false;
      for (const c of clauses) if (matches(row, c)) any = true;
      if (!any) return false;
      continue;
    }
    if (key === "AND") {
      const clauses = val as Array<Record<string, unknown>>;
      for (const c of clauses) if (!matches(row, c)) return false;
      continue;
    }
    if (key === "NOT") {
      // Deliberately unsupported. A NOT over the NULLABLE `link` column is
      // three-valued logic in Postgres: a link-less row makes the predicate
      // NULL, not TRUE, so such a query silently drops most of a member's
      // notifications. If a code path grows one, this must shout.
      throw new Error("NOT over a nullable column is three-valued logic — use positive clauses");
    }
    const actual = row[key];
    if (val === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (typeof val === "object") {
      const op = val as Record<string, unknown>;
      if (typeof op.startsWith === "string") {
        if (typeof actual !== "string") return false;
        if (actual.indexOf(op.startsWith) !== 0) return false;
        continue;
      }
      if ("not" in op) {
        // SQL `<> x` over a NULL column yields NULL, i.e. no match.
        if (actual === null || actual === undefined) return false;
        if (actual === op.not) return false;
        continue;
      }
      if (Array.isArray(op.notIn)) {
        // Same: NULL NOT IN (...) is NULL, so a NULL row does NOT match.
        if (actual === null || actual === undefined) return false;
        if ((op.notIn as unknown[]).indexOf(actual) !== -1) return false;
        continue;
      }
      if (Array.isArray(op.in)) {
        if (actual === null || actual === undefined) return false;
        if ((op.in as unknown[]).indexOf(actual) === -1) return false;
        continue;
      }
      throw new Error("unsupported filter operator: " + JSON.stringify(val));
    }
    if (actual !== val) return false;
  }
  return true;
}

vi.mock("@/lib/db", () => ({
  db: {
    notification: {
      findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
        H.calls.push("notification.findMany");
        const rows = (H.rows as Row[]).filter((r) =>
          matches(r as unknown as Record<string, unknown>, args.where)
        );
        return rows.slice(0, args.take ?? rows.length);
      },
      count: async (args: { where: Record<string, unknown> }) => {
        H.calls.push("notification.count");
        return (H.rows as Row[]).filter((r) =>
          matches(r as unknown as Record<string, unknown>, args.where)
        ).length;
      },
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    project: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        H.calls.push("project.findMany");
        // The supervised-project lookup, and it must be scoped: same workspace,
        // this reader, not tombstoned.
        expect(args.where.companyId).toBe("co-1");
        expect(args.where.supervisorId).toBe("u-1");
        expect(args.where.deletedAt).toBe(null);
        return H.supervised.map((id) => ({ id }));
      },
    },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  listNotificationsAction,
  unreadNotificationCountAction,
} from "@/lib/actions/notifications";

/** The figure a member must never be told. Distinctive on purpose. */
const LEAKED_FIGURE = "2,500,000 PKR";

function row(over: Partial<Row>): Row {
  return {
    id: "n",
    userId: "u-1",
    companyId: "co-1",
    projectId: null,
    title: "Notification",
    message: "",
    type: "info",
    category: "system",
    read: false,
    link: null,
    createdAt: new Date("2026-09-20T10:00:00.000Z"),
    ...over,
  };
}

/**
 * One inbox, covering every shape the two paths disagree about.
 *
 * The three finance rows are the leak: the first is the ordinary
 * project-tagged expense (link `/projects/<id>`, not a blocked route), the
 * second is the company-wide burn alert with NO link at all, the third belongs
 * to a project the reader may supervise.
 */
const INBOX: Row[] = [
  row({
    id: "n-expense-other-project",
    category: "finance",
    projectId: "p-other",
    link: "/projects/p-other",
    message: "Ayesha logged " + LEAKED_FIGURE,
  }),
  row({
    id: "n-burn-companywide",
    category: "finance",
    projectId: null,
    link: null,
    message: "Burn crossed 80% of the monthly cap — 1,200,000 PKR",
  }),
  row({
    id: "n-expense-my-project",
    category: "finance",
    projectId: "p-mine",
    link: "/projects/p-mine",
    message: "Bilal logged 40,000 PKR on Nimbus",
  }),
  row({ id: "n-task", category: "task", link: "/tasks?taskId=t1", message: "You were assigned" }),
  row({
    id: "n-expense-deeplink",
    category: "finance",
    projectId: null,
    link: "/expenses?txId=tx1",
    message: "An expense was edited — 9,000 PKR",
  }),
  row({
    id: "n-task-read",
    category: "task",
    link: "/tasks?taskId=t2",
    message: "A task moved",
    read: true,
  }),
  row({ id: "n-digest", category: "system", link: "/dashboard", message: "Weekly digest ready" }),
];

function signedIn(role: "admin" | "cofounder" | "member") {
  H.session.value = { user: { id: "u-1", companyId: "co-1", role } };
}

/**
 * A claim minted before `companyId` was put in the token — Auth.js hands the
 * action a session whose user has an id and nothing else. Written as its own
 * helper rather than `signedIn(role, undefined)`, because a default parameter
 * fires on an explicit `undefined` and the test would quietly assert nothing.
 */
function signedInWithoutWorkspace(role: "admin" | "cofounder" | "member") {
  H.session.value = { user: { id: "u-1", role } };
}

async function bellIds(): Promise<string[]> {
  const res = await listNotificationsAction();
  if (!res.success) throw new Error("bell refused: " + res.error);
  return res.data.map((n) => n.id);
}

async function bellMessages(): Promise<string> {
  const res = await listNotificationsAction();
  if (!res.success) throw new Error("bell refused: " + res.error);
  return res.data.map((n) => n.message).join(" | ");
}

async function badge(): Promise<number> {
  const res = await unreadNotificationCountAction();
  if (!res.success) throw new Error("badge refused: " + res.error);
  return res.data.count;
}

beforeEach(() => {
  H.rows = INBOX.slice();
  H.supervised = [];
  H.calls.length = 0;
  signedIn("member");
});

describe("the bell dropdown obeys the finance wall, not the link", () => {
  it("never shows a member the rupee figure from a project-tagged expense", async () => {
    const messages = await bellMessages();
    expect(
      messages,
      "a project-tagged expense links to /projects/<id>, which is not a member-blocked route, " +
        "so the link-only filter let the amount through to every member's bell"
    ).not.toContain(LEAKED_FIGURE);
  });

  it("never shows a member a company-wide money alert that carries no link", async () => {
    const ids = await bellIds();
    expect(
      ids,
      "`if (!n.link) return true` — a link-less finance row was treated as harmless"
    ).not.toContain("n-burn-companywide");
  });

  it("shows a member exactly the rows they are allowed to open", async () => {
    expect(await bellIds()).toEqual(["n-task", "n-task-read"]);
  });

  it("keeps the supervisor escape hatch: their own project's money still reaches them", async () => {
    H.supervised = ["p-mine"];
    const ids = await bellIds();
    expect(ids).toContain("n-expense-my-project");
    expect(ids, "supervising one project is not a licence to see another's").not.toContain(
      "n-expense-other-project"
    );
    expect(ids, "nor the company-wide figure").not.toContain("n-burn-companywide");
  });

  it("shows an admin everything, including the figures", async () => {
    signedIn("admin");
    expect((await bellIds()).length).toBe(INBOX.length);
    expect(await bellMessages()).toContain(LEAKED_FIGURE);
  });

  it("refuses a session with no workspace instead of reading another one's rows", async () => {
    signedInWithoutWorkspace("member");
    const res = await listNotificationsAction();
    expect(res.success, "a claim minted before companyId existed must not read finance rows").toBe(
      false
    );
    expect(H.calls).toEqual([]);
  });
});

describe("the number on the bell equals what is inside the bell", () => {
  it("counts only the unread rows a member may actually open", async () => {
    const inBell = await bellIds();
    const unreadInBell = (H.rows as Row[]).filter(
      (r) => inBell.indexOf(r.id) !== -1 && !r.read
    ).length;

    expect(unreadInBell, "fixture sanity: the member has one unread row they may open").toBe(1);
    expect(
      await badge(),
      "the badge derived its exclusion from link shapes alone, so it counted the finance rows " +
        "the dropdown hides — a badge of 4 over a dropdown of 1, which the reader can never clear"
    ).toBe(unreadInBell);
  });

  it("counts a supervisor's own project money, matching their dropdown", async () => {
    H.supervised = ["p-mine"];
    const inBell = await bellIds();
    const unreadInBell = (H.rows as Row[]).filter(
      (r) => inBell.indexOf(r.id) !== -1 && !r.read
    ).length;
    expect(unreadInBell).toBe(2);
    expect(await badge()).toBe(unreadInBell);
  });

  it("counts every unread row for someone who may see finances", async () => {
    signedIn("cofounder");
    expect(await badge()).toBe(6);
    expect(
      H.calls.filter((c) => c === "notification.count").length,
      "someone who can see finances needs one count and no subtraction"
    ).toBe(1);
  });

  it("reads no notification rows to produce the number (perf-004 holds)", async () => {
    await badge();
    expect(H.calls.indexOf("notification.findMany")).toBe(-1);
  });

  it("refuses a session with no workspace", async () => {
    signedInWithoutWorkspace("member");
    const res = await unreadNotificationCountAction();
    expect(res.success).toBe(false);
    expect(H.calls).toEqual([]);
  });
});
