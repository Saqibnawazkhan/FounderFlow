/**
 * Structural guard: every authenticated page resolves a session server-side.
 *
 * WHY THIS FILE EXISTS (audit harness-006). CLAUDE.md states the rule plainly:
 * "Permission gates exist in two layers: middleware (auth.config.ts) for routes,
 * server actions for writes. Both must agree." Nothing checked that they did, for
 * pages. Six other invariants in this repo are enforced structurally —
 * script-safety, purge-invariants, fan-out-sites, rtl, brand, auth-forms — and
 * this one, which decides whether a page renders another tenant's data to an
 * anonymous request, was enforced by reading.
 *
 * WHAT THE AUDIT GOT WRONG, AND WHY IT MATTERS THAT IT DID. The finding named
 * five pages that "currently do not" resolve a session: /activities, /budgets,
 * /chat, /notifications and /settings. It reached that by grepping each
 * page.tsx for `requireScopedSession(` or `auth()`. None of those five contains
 * either — and all five resolve a session anyway, on the first line of the query
 * they await:
 *
 *   /activities    getActivitiesPage()      -> requireFinanceSession()
 *   /budgets       getBudgetsWithSpend()    -> financeScopeFor() -> requireFinanceSession()
 *   /chat          listChannelsForUser()    -> requireScopedSession()
 *   /notifications getNotifications()       -> requireScopedSession()
 *   /settings      getCurrentUser()         -> requireScopedSession()
 *
 * That is the same reason the sibling guard for server actions follows a call
 * instead of matching a name: a grep over one file answers "is the gate spelled
 * here", and the question is "is a session resolved before tenant data is read".
 * A guard built the way the finding describes it would have reported five false
 * positives on day one and been deleted by the end of the week — which is how a
 * missing guard stays missing.
 *
 * TWO HOPS, and /budgets is the reason. The action guard allows one, because an
 * endpoint's gate belongs in the endpoint. A page legitimately delegates: it
 * renders, and the query it awaits owns the tenant scope. So the chain is
 * page -> query -> (a helper inside that query's module), which is exactly what
 * /budgets ships.
 *
 * Measured, because the obvious version of that claim is wrong: at ONE hop
 * /budgets still passes, and it passes for the wrong reason. It also awaits
 * `listProjectOptions()`, which gates in its own body, so the page is credited
 * while the chain carrying the page's actual subject — getBudgetsWithSpend() ->
 * financeScopeFor() -> requireFinanceSession() — goes unread. The second hop is
 * what reads that chain, and `follows two hops ...` below is what pins it. Three
 * hops would start crediting gates no reviewer could find.
 *
 * WHAT THIS CANNOT PROVE, stated rather than implied:
 *   - It is a text graph. A gate inside a branch that never runs still counts,
 *     and a call reached through a variable or a higher-order function is not
 *     followed at all. Both are false-negative directions.
 *   - Resolving a session is not the same as scoping a query to the tenant.
 *     `tests/lib/queries/*-scoping.test.ts` own that question; this file only
 *     establishes that there IS a caller to scope to.
 *
 * The last describe block drives the detector over synthetic pages, because every
 * assertion over the real tree reports an empty list — which is also what a
 * detector that has stopped working reports.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodyAt,
  gateCallRegex,
  gatePath,
  makeUniverse,
  universeFromDisk,
} from "../lib/harness/gate-graph";
import type { Mod, Universe } from "../lib/harness/gate-graph";

const ROOT = process.cwd();

/**
 * Where a page and everything it can reach may live. `components/` is in the
 * list because a page can delegate to a server component beside it.
 */
const SCAN_ROOTS = ["lib", "app", "components"];

/**
 * The authenticated route group. Pages OUTSIDE it — /login, /signup,
 * /forgot-password, /reset-password, /invite/[token], /verify-email,
 * /verify-email-change, /offline and the marketing root — are pre-auth by
 * definition: demanding a session would break the only thing they exist to do.
 * The group boundary is the rule, so a new pre-auth page needs no exemption and a
 * new authenticated one gets covered the day it lands.
 */
const APP_GROUP = "app/(app)/";

/**
 * The calls that actually read a session. Same three as the action guard, and
 * short for the same reason: an authoritative-sounding name is not a gate.
 * `getCurrentCompany()` and `financeScopeFor()` are gates, and they pass here by
 * being SHOWN to reach one of these, not by being named.
 */
const PRIMITIVE_GATES = ["auth", "requireScopedSession", "requireFinanceSession"];
const GATE_CALL = gateCallRegex(PRIMITIVE_GATES);

/** See "TWO HOPS" in the header. */
const MAX_PAGE_HOPS = 2;

/**
 * Pages inside the group that legitimately resolve no session.
 *
 * EMPTY, and the test below pins that. A page in the authenticated group that
 * reads no session is either a bug or a page in the wrong group, and both are
 * fixes rather than exemptions. If it ever gains an entry, the entry needs the
 * reason an anonymous render of that page is safe.
 */
const NO_SESSION_NEEDED = new Map<string, string>([]);

let cachedRepo: Universe | null = null;

function repoUniverse(): Universe {
  if (!cachedRepo) cachedRepo = universeFromDisk(ROOT, SCAN_ROOTS);
  return cachedRepo;
}

type Page = { mod: Mod; body: string | null };

function pagesOf(universe: Universe): Page[] {
  const out: Page[] = [];
  universe.forEach((mod) => {
    if (mod.rel.indexOf(APP_GROUP) !== 0) return;
    if (!/\/page\.tsx$/.test(mod.rel)) return;
    const found = /export\s+default\s+(?:async\s+)?function\s+\w+/.exec(mod.code);
    out.push({ mod, body: found ? bodyAt(mod.code, found.index) : null });
  });
  return out.sort((a, b) => (a.mod.rel < b.mod.rel ? -1 : 1));
}

/** Page paths with no session check reachable from the default export. */
function ungatedPages(universe: Universe): string[] {
  const out: string[] = [];
  for (const page of pagesOf(universe)) {
    if (NO_SESSION_NEEDED.has(page.mod.rel)) continue;
    if (page.body === null) {
      // Loud rather than silent. A page whose default export cannot be found is
      // a page this guard did not check, and "did not check" must not read as
      // "checked and fine".
      out.push(`${page.mod.rel} (default export could not be parsed)`);
      continue;
    }
    if (!gatePath(universe, page.mod.rel, page.body, MAX_PAGE_HOPS, GATE_CALL)) {
      out.push(page.mod.rel);
    }
  }
  return out;
}

/** Page path -> how it reaches a gate, for the pages that delegate. */
function delegatedPages(universe: Universe): Record<string, string> {
  const out: Record<string, string> = {};
  for (const page of pagesOf(universe)) {
    if (page.body === null) continue;
    if (GATE_CALL.test(page.body)) continue;
    const path = gatePath(universe, page.mod.rel, page.body, MAX_PAGE_HOPS, GATE_CALL);
    if (path) out[page.mod.rel] = path;
  }
  return out;
}

describe("authenticated pages (middleware is not the only gate that has to hold)", () => {
  it("finds the pages at all", () => {
    // Guards the guard: every assertion below iterates this list, so an empty
    // walk is a green suite that inspected nothing. The audit counted 17 pages
    // in the group; the floor is deliberately below that so deleting a route is
    // not a test failure, and deliberately high enough that a broken walk is.
    const pages = pagesOf(repoUniverse());
    expect(
      pages.length,
      `almost no page was found under ${APP_GROUP} — the walk or the group prefix is broken`
    ).toBeGreaterThan(12);
    expect(pages.map((p) => p.mod.rel)).toContain("app/(app)/dashboard/page.tsx");
  });

  it("parsed every page's default export", () => {
    const unparsed = pagesOf(repoUniverse())
      .filter((p) => p.body === null)
      .map((p) => p.mod.rel);
    expect(
      unparsed,
      `The default export of these pages could not be read, so they were not checked:\n${unparsed.join("\n")}`
    ).toEqual([]);
  });

  it("resolves a session on every page in the authenticated group", () => {
    const offenders = ungatedPages(repoUniverse());
    expect(
      offenders,
      "These pages render tenant data without any session check reachable from " +
        "the default export. Middleware alone gates them, and CLAUDE.md requires " +
        "both layers to agree:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("keeps no exemptions", () => {
    // The allow-list's own test. Entries are possible and must be argued for;
    // the failure message is where the argument gets written down.
    expect(
      Array.from(NO_SESSION_NEEDED.keys()),
      "A page in the authenticated group has been exempted from resolving a " +
        "session. That needs a reason an anonymous render is safe, not an entry."
    ).toEqual([]);
  });

  it("names the pages that delegate, so the delegation cannot quietly disappear", () => {
    // The audit's five, plus /chat/[slug]. If one of these starts gating in its
    // own body the entry goes; if the traversal were removed and everything
    // allow-listed instead, this is what notices. Iterating in both directions so
    // a failure names the page rather than a count.
    const delegated = delegatedPages(repoUniverse());
    const expected = [
      "app/(app)/activities/page.tsx",
      "app/(app)/budgets/page.tsx",
      "app/(app)/chat/page.tsx",
      "app/(app)/notifications/page.tsx",
      "app/(app)/settings/page.tsx",
    ];
    expected.forEach((rel) => {
      expect(
        Object.keys(delegated),
        `${rel} no longer reaches its gate through a query — update this list`
      ).toContain(rel);
    });

    // And the chain for /budgets specifically, because it is the two-hop case
    // the hop limit is set for.
    expect(delegated["app/(app)/budgets/page.tsx"]).toContain("lib/queries/budgets.ts");
  });

  it("agrees with the middleware layer about which group is protected", () => {
    // CLAUDE.md: "Both must agree." This half is cheap and it is the half that
    // stops the two drifting: if middleware stops treating the (app) group as
    // protected, an anonymous request reaches these pages and the only thing left
    // is the per-query gate above.
    const config = readFileSync(join(ROOT, "auth.config.ts"), "utf8");
    expect(config, "auth.config.ts no longer mentions the dashboard route").toMatch(/dashboard/);
  });
});

describe("the page-gate detector (a sweep is only worth its false-negative rate)", () => {
  // Every assertion above reports an empty list against a healthy tree. The
  // violations live here, driven through the exact same functions.

  const GATE_MODULE = `
import { auth } from "@/lib/auth";
export async function requireScopedSession() {
  const session = await auth();
  if (!session) throw new Error("Not authenticated");
  return session;
}
`;

  const universeWith = (sources: Record<string, string>) =>
    makeUniverse(Object.assign({ "lib/queries/session.ts": GATE_MODULE }, sources));

  it("reports a page whose query resolves nothing", () => {
    const universe = universeWith({
      "lib/queries/things.ts": `
import { db } from "@/lib/db";
export async function listThings() {
  return db.thing.findMany({});
}
`,
      "app/(app)/things/page.tsx": `
import { listThings } from "@/lib/queries/things";
export default async function ThingsPage() {
  const things = await listThings();
  return <div>{things.length}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual(["app/(app)/things/page.tsx"]);
  });

  it("passes a page that gates in its own body", () => {
    const universe = universeWith({
      "app/(app)/things/page.tsx": `
import { requireScopedSession } from "@/lib/queries/session";
export default async function ThingsPage() {
  const { companyId } = await requireScopedSession();
  return <div>{companyId}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual([]);
    expect(delegatedPages(universe)).toEqual({});
  });

  it("follows one hop into a query that gates — the /notifications shape", () => {
    const universe = universeWith({
      "lib/queries/things.ts": `
import { requireScopedSession } from "@/lib/queries/session";
export async function listThings() {
  const { companyId } = await requireScopedSession();
  return companyId;
}
`,
      "app/(app)/things/page.tsx": `
import { listThings } from "@/lib/queries/things";
export default async function ThingsPage() {
  return <div>{await listThings()}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual([]);
    expect(delegatedPages(universe)["app/(app)/things/page.tsx"]).toContain(
      "via listThings() in lib/queries/things.ts"
    );
  });

  it("follows two hops through a query's own local helper — the /budgets shape", () => {
    // financeScopeFor() is not exported, so only the traversal can see it. This
    // is the case the hop limit exists for, reconstructed rather than named, so
    // it survives that function being renamed.
    const universe = universeWith({
      "lib/queries/things.ts": `
import { requireScopedSession } from "@/lib/queries/session";
async function scopeFor() {
  const { companyId } = await requireScopedSession();
  return companyId;
}
export async function listThings() {
  const companyId = await scopeFor();
  return companyId;
}
`,
      "app/(app)/things/page.tsx": `
import { listThings } from "@/lib/queries/things";
export default async function ThingsPage() {
  return <div>{await listThings()}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual([]);
  });

  it("does NOT pass a delegation that ends at a helper checking nothing", () => {
    // The whole reason the primitive list is three names long: an
    // authoritative-looking helper is not a gate. A detector matching on the
    // name would call this safe.
    const universe = universeWith({
      "lib/queries/things.ts": `
import { db } from "@/lib/db";
async function requireScope() {
  return { companyId: "anything" };
}
export async function listThings() {
  const { companyId } = await requireScope();
  return db.thing.findMany({ where: { companyId } });
}
`,
      "app/(app)/things/page.tsx": `
import { listThings } from "@/lib/queries/things";
export default async function ThingsPage() {
  return <div>{await listThings()}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual(["app/(app)/things/page.tsx"]);
  });

  it("does not credit an import the page never calls", () => {
    // The residue of a half-finished wiring, and the shape a grep gets wrong.
    const universe = universeWith({
      "lib/queries/things.ts": `
import { requireScopedSession } from "@/lib/queries/session";
export async function listThings() {
  await requireScopedSession();
  return [];
}
export async function listOther() {
  return [];
}
`,
      "app/(app)/things/page.tsx": `
import { listThings, listOther } from "@/lib/queries/things";
export default async function ThingsPage() {
  return <div>{(await listOther()).length}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual(["app/(app)/things/page.tsx"]);
  });

  it("does not credit a session check that only appears in a comment or a string", () => {
    const universe = universeWith({
      "app/(app)/things/page.tsx": `
// TODO: call requireScopedSession() here before shipping.
const NOTE = "requireScopedSession()";
export default async function ThingsPage() {
  return <div>{NOTE}</div>;
}
`,
    });
    expect(ungatedPages(universe)).toEqual(["app/(app)/things/page.tsx"]);
  });

  it("ignores a page outside the authenticated group", () => {
    // /login resolves no session and must not: it is what mints one.
    const universe = universeWith({
      "app/login/page.tsx": `
export default async function LoginPage() {
  return <form />;
}
`,
    });
    expect(ungatedPages(universe)).toEqual([]);
  });

  it("reports a page whose default export it cannot read, rather than passing it", () => {
    const universe = universeWith({
      "app/(app)/things/page.tsx": `
const ThingsPage = async () => <div />;
export default ThingsPage;
`,
    });
    expect(ungatedPages(universe)).toEqual([
      "app/(app)/things/page.tsx (default export could not be parsed)",
    ]);
  });
});
