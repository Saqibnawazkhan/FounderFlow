/**
 * The security half of cross-content search.
 *
 * WHY THESE TESTS LOOK LIKE THIS: vitest has no database, so nothing here can
 * assert that a query returned the right rows. That is fine, because the two
 * properties Phase H has to hold are not properties of the rows — they are
 * properties of the QUESTIONS ASKED. A member must not have a transaction
 * query issued on their behalf at all, and every question the search asks must
 * carry the asker's own company id. Both are visible in the calls
 * `searchWorkspace` makes, so the Prisma client is replaced with a recorder and
 * the assertions run over what it recorded.
 *
 * The recorder is a Proxy rather than a hand-written `{ task: { findMany } }`
 * object on purpose. A hand-written fake only knows about the delegates that
 * existed the day it was written: add a sixth content type to
 * lib/queries/search.ts and the fake throws (best case) or, once someone
 * "fixes" it by adding the delegate, the new group joins the file without any
 * of the invariants below ever being applied to it. The Proxy answers for any
 * delegate, so a group added later is recorded, iterated, and scoped-checked
 * automatically — which is the only way a test like this stays true.
 *
 * lib/auth/** is deliberately NOT mocked. `canSeeFinances`,
 * `canSeeAllProjects` and `visibleChannelWhere` are the real predicates here;
 * mocking them would test that the query calls a stub, not that it obeys the
 * rule the rest of the product obeys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleChannelWhere } from "@/lib/auth/channel-permissions";
import { SEARCH_GROUPS, type SearchGroup } from "@/lib/schemas/search";
import { searchWorkspace } from "@/lib/queries/search";
import type { ScopedSession } from "@/lib/queries/session";

/** One call the search made against the (fake) Prisma client. */
type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  /** Rows a delegate answers with, keyed "task.findMany" / "$queryRaw". */
  const answers = new Map<string, unknown[]>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    return Promise.resolve(answers.get(`${delegate}.${method}`) ?? answers.get(delegate) ?? []);
  }

  // Tagged-template form: `db.$queryRaw`…`` arrives as (strings, ...values).
  const queryRaw = vi.fn((...args: unknown[]) => record("$queryRaw", "$queryRaw", args));
  // Present so the test can prove it is never reached — a fake that simply
  // lacked the method would fail with a TypeError, which reads as a broken
  // test rather than as the injection finding it would actually be.
  const queryRawUnsafe = vi.fn((...args: unknown[]) =>
    record("$queryRawUnsafe", "$queryRawUnsafe", args)
  );

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
        if (prop === "$queryRaw") return queryRaw;
        if (prop === "$queryRawUnsafe") return queryRawUnsafe;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db, queryRaw, queryRawUnsafe };
});

const session = vi.hoisted(() => ({
  current: {
    userId: "cme00000000000000000000aa",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));

// The entry point resolves who is asking from here and from nowhere else —
// rule 1 of lib/queries/search.ts. Every test below changes the caller by
// changing this, never by passing an argument, because there is no argument to
// pass and that is the guarantee.
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.current),
}));

type Workspace = { userId: string; companyId: string };

/** Two workspaces, so "scoped to my company" has something to be wrong about. */
const WORKSPACES: Workspace[] = [
  { userId: "cme00000000000000000000aa", companyId: "c_nimbus" },
  { userId: "crival000000000000000000b", companyId: "c_rival" },
];

/** The groups withheld from a member — the two behind `canSeeFinances`. */
const FINANCE_GROUPS: SearchGroup[] = ["transaction", "budget"];

/** Which Prisma delegate backs each finance group, for the "never asked" check. */
const FINANCE_DELEGATES = ["transaction", "budget"];

function asRole(role: ScopedSession["role"], workspace: Workspace = WORKSPACES[0]) {
  session.current = {
    userId: workspace.userId,
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: workspace.companyId,
    role,
  };
}

/**
 * Rows for every delegate, so that a query which DOES run produces a visible
 * group. The finance rows matter most: the fake client will hand transactions
 * and budgets to anyone who asks, so a member seeing no finance group is proof
 * that nothing asked — not proof that the fake was empty.
 */
function stockTheWorkspace() {
  prisma.answers.set("task.findMany", [
    { id: "t1", title: "Budget review", project: { name: "Nimbus" } },
  ]);
  prisma.answers.set("project.findMany", [{ id: "p1", name: "Budget rework", description: null }]);
  prisma.answers.set("transaction.findMany", [
    { id: "x1", description: "Budget hosting", category: "Infra", type: "expense" },
  ]);
  prisma.answers.set("budget.findMany", [{ id: "b1", category: "Budget", project: null }]);
  prisma.answers.set("$queryRaw", [
    {
      id: "m1",
      authorName: "Ayesha",
      channelSlug: "general",
      channelName: "general",
      channelKind: "public",
      snippet: "we need a <b>budget</b> for this",
    },
  ]);
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.queryRaw.mockClear();
  prisma.queryRawUnsafe.mockClear();
  stockTheWorkspace();
  asRole("admin");
});

/** Every value stored under a `companyId` key, at any depth. */
function companyIdsIn(value: unknown): string[] {
  const found: string[] = [];
  walk(value, (key, leaf) => {
    if (key === "companyId" && typeof leaf === "string") found.push(leaf);
  });
  return found;
}

/** Every string anywhere in the value — including Prisma.Sql bound parameters. */
function stringsIn(value: unknown): string[] {
  const found: string[] = [];
  walk(value, (_key, leaf) => {
    if (typeof leaf === "string") found.push(leaf);
  });
  return found;
}

type Visitor = (key: string | null, leaf: unknown) => void;

/**
 * Depth-first over arrays and plain-ish objects. `Prisma.Sql` instances hold
 * their bound parameters on an own `values` property, so this reaches into a
 * composed SQL fragment without knowing what one is.
 */
function walk(value: unknown, visit: Visitor, key: string | null = null): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, key);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, visit, childKey);
    }
    return;
  }
  visit(key, value);
}

function isRaw(call: RecordedCall): boolean {
  return call.delegate.startsWith("$query");
}

/**
 * The SQL text of a tagged-template call, parameter slots marked with `$?`.
 *
 * Includes the text of any composed `Prisma.Sql` sitting in the parameter
 * list, because that is where the channel-visibility join lives — reading only
 * the outer template would report the query as having no visibility filter at
 * all, which is the exact thing these tests are here to notice.
 */
function sqlTextOf(call: RecordedCall): string {
  const chunks = [(call.args[0] as string[]).join(" $? ")];
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const sql = value as { strings?: unknown; values?: unknown };
    if (Array.isArray(sql.strings)) chunks.push(sql.strings.join(" $? "));
    if (Array.isArray(sql.values)) sql.values.forEach(visit);
  };
  call.args.slice(1).forEach(visit);
  return chunks.join(" ");
}

function groupsOf(result: { groups: { group: SearchGroup }[] }): SearchGroup[] {
  return result.groups.map((g) => g.group);
}

describe("searchWorkspace (the finance gate)", () => {
  it("offers no finance group to a member", async () => {
    asRole("member");

    const result = await searchWorkspace("budget");
    const groups = groupsOf(result);

    // The visible half: no heading a member could read a figure under.
    for (const finance of FINANCE_GROUPS) {
      expect(groups).not.toContain(finance);
    }
    // Not vacuous — the search did run and did return the groups a member may
    // have, so the absence above is the gate and not an empty result set.
    expect(groups).toContain("task");

    // THE STRONGER PROPERTY, and the actual design: the rows were never read.
    // Filtering after the fact would mean a bug in the filter is a leak; an
    // unasked question leaks nothing and costs nothing. The fake client had
    // finance rows loaded and waiting, so this only passes because nothing
    // asked for them.
    const asked = prisma.calls.map((c) => c.delegate);
    for (const delegate of FINANCE_DELEGATES) {
      expect(asked).not.toContain(delegate);
    }
  });

  it("gives an admin the finance groups", async () => {
    asRole("admin");

    const result = await searchWorkspace("budget");
    const groups = groupsOf(result);

    // The converse, so the test above cannot pass by the search being broken
    // for everybody.
    for (const finance of FINANCE_GROUPS) {
      expect(groups).toContain(finance);
    }
    const asked = prisma.calls.map((c) => c.delegate);
    for (const delegate of FINANCE_DELEGATES) {
      expect(asked).toContain(delegate);
    }
  });

  it("gives a cofounder the finance groups too", async () => {
    // `canSeeFinances` is a two-role predicate. A gate written as
    // `role === "member" ? …` would pass the two tests above and lock a
    // cofounder out of their own company's numbers.
    asRole("cofounder");

    const groups = groupsOf(await searchWorkspace("budget"));
    for (const finance of FINANCE_GROUPS) {
      expect(groups).toContain(finance);
    }
  });
});

describe("searchWorkspace (company scope)", () => {
  /**
   * THE HIGHEST-VALUE TEST IN THIS FILE.
   *
   * Every other assertion here is about one group or one rule. This one is
   * about all of them at once, including the ones that do not exist yet: it
   * iterates whatever calls the search actually made and demands each carry
   * the caller's own company id. Nothing names `task` or `transaction`, so a
   * sixth group added to lib/queries/search.ts next month is covered by this
   * test the day it lands — and a group that forgets its `companyId` filter
   * fails here rather than in production, where the symptom is another
   * tenant's data in a palette row.
   *
   * Run twice, once per workspace, because "carries a company id" and
   * "carries MY company id" are different claims and only the second one is
   * the tenancy boundary.
   */
  it("scopes every group to the caller's own company", async () => {
    for (const workspace of WORKSPACES) {
      prisma.calls.length = 0;
      asRole("admin", workspace);

      await searchWorkspace("budget");

      // The search asked SOMETHING — an empty call list would make every
      // assertion below trivially true.
      expect(prisma.calls.length).toBeGreaterThan(0);

      for (const call of prisma.calls) {
        const where = `${call.delegate}.${call.method}`;

        if (isRaw(call)) {
          // Raw SQL has no `where` object to read, so the evidence is the
          // column it compares and the parameter it binds.
          expect(sqlTextOf(call), where).toContain('"companyId" =');
          expect(stringsIn(call.args), where).toContain(workspace.companyId);
        } else {
          const scopes = companyIdsIn(call.args);
          expect(scopes.length, `${where} carries no companyId at all`).toBeGreaterThan(0);
          for (const scope of scopes) expect(scope, where).toBe(workspace.companyId);
        }

        // And nothing belonging to the other workspace rode along — not its
        // company id, not its user id. This is what catches a cached scope or
        // a stale closure, which the per-call check above cannot see.
        const others = WORKSPACES.filter((w) => w.companyId !== workspace.companyId);
        for (const other of others) {
          expect(stringsIn(call.args), where).not.toContain(other.companyId);
          expect(stringsIn(call.args), where).not.toContain(other.userId);
        }
      }
    }
  });

  it("asks the database nothing when the term is below the minimum", async () => {
    const result = await searchWorkspace("b");

    // The minimum-length rule is enforced at the query boundary as well as in
    // the action, because this is an exported entry point an RSC could call
    // directly — and a one-character term is five full scans per keystroke.
    expect(result.groups).toEqual([]);
    expect(prisma.calls).toEqual([]);
  });
});

describe("searchWorkspace (the message path)", () => {
  it("parameterizes the message search rather than building its SQL by hand", async () => {
    const term = "budget' OR 1=1 --";

    await searchWorkspace(term);

    // `$queryRaw` (tagged template) binds every `${}` as a parameter;
    // `$queryRawUnsafe` takes a finished string. A search box is the first
    // input anyone tries an injection against, and this is the whole
    // difference between the two.
    expect(prisma.queryRaw).toHaveBeenCalled();
    expect(prisma.queryRawUnsafe).not.toHaveBeenCalled();

    const raw = prisma.calls.find(isRaw)!;
    // The tagged-template form, specifically: the first argument is the
    // template strings array. `$queryRaw(someString)` would not have `.raw`.
    expect(Array.isArray(raw.args[0])).toBe(true);
    expect(raw.args[0]).toHaveProperty("raw");

    // The term reached Postgres as a VALUE, never as SQL text.
    expect(stringsIn(raw.args.slice(1))).toContain(term);
    expect(sqlTextOf(raw)).not.toContain("1=1");
  });

  it("filters messages through the shared channel-visibility rule", async () => {
    asRole("admin");

    await searchWorkspace("budget");

    const raw = prisma.calls.find(isRaw)!;
    const bound = stringsIn(raw.args);
    const fragment = visibleChannelWhere(session.current.userId, session.current.companyId);

    // Derived from `visibleChannelWhere` itself, arm by arm, rather than from
    // a copy of what it returns today. If someone adds a third arm to the
    // fragment — a new kind of channel everyone can read — this test demands
    // the SQL carry it, which is the failure mode the whole translator in
    // lib/queries/search.ts exists to make loud.
    for (const arm of fragment.OR) {
      const carried = "kind" in arm ? arm.kind : arm.members.some.userId;
      expect(bound).toContain(carried);
    }
    expect(bound).toContain(fragment.companyId);

    // The membership arm has to be a real join, not a value sitting unused in
    // the parameter list.
    expect(sqlTextOf(raw)).toContain('"ChannelMember"');
  });

  it("does not resurface a tombstoned row in any group", async () => {
    asRole("admin");

    await searchWorkspace("budget");

    for (const call of prisma.calls) {
      const where = `${call.delegate}.${call.method}`;
      if (isRaw(call)) {
        // The generated search vector is computed from the body alone and
        // knows nothing about tombstones.
        expect(sqlTextOf(call), where).toContain('"deletedAt" IS NULL');
      } else {
        const args = call.args[0] as { where?: Record<string, unknown> };
        expect(args.where, where).toHaveProperty("deletedAt", null);
      }
    }
  });
});

describe("searchWorkspace (the shape the palette renders)", () => {
  it("returns its groups in the order lib/schemas/search.ts declares", async () => {
    asRole("admin");

    const groups = groupsOf(await searchWorkspace("budget"));

    // The palette renders what arrives, in the order it arrives. Iterating
    // SEARCH_GROUPS rather than comparing against a written-out list means a
    // new content type is checked here without this test being edited.
    const expected = SEARCH_GROUPS.filter((g) => groups.includes(g));
    expect(groups).toEqual(Array.from(expected));
  });

  it("omits a group that found nothing instead of sending an empty heading", async () => {
    asRole("admin");
    prisma.answers.set("project.findMany", []);

    const groups = groupsOf(await searchWorkspace("budget"));

    // An empty group would render a heading with nothing under it — and for a
    // member, the ABSENCE of the finance headings is the gate, so an empty
    // group is not a shape this feature may ever produce.
    expect(groups).not.toContain("project");
    for (const entry of (await searchWorkspace("budget")).groups) {
      expect(entry.hits.length).toBeGreaterThan(0);
    }
  });
});
