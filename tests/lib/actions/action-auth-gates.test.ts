/**
 * Structural guard: every server action reaches an auth gate.
 *
 * WHAT THIS IS DEFENDING. A `"use server"` export is a POST endpoint that
 * anyone can call — the action id is a build-stable hash that ships in the
 * client bundle, and the request body is whatever the caller sends. There is no
 * framework-level authentication in front of it. `middleware`/`auth.config.ts`
 * gates ROUTES; a server action is invoked against the route the user is
 * already on, so a route gate says nothing about whether the action checked
 * anything. The only thing standing between an anonymous request and the
 * database is a session check inside the action's own reachable code.
 *
 * WHY A SWEEP AND NOT A REVIEW. The cron-helper P0 (`sweepAutoCloseEntries`,
 * see tests/lib/actions/use-server-exports.test.ts) was not missed because
 * anyone was careless. It was missed because "does this endpoint check a
 * session?" is a question about a call graph, and a diff shows a function. The
 * 79 endpoints under lib/actions/ plus app/(app)/chat/[slug]/actions.ts are too
 * many to re-audit by eye on every change, and the ones that are ungated ON
 * PURPOSE are exactly the ones a reader learns to skim past.
 *
 * WHAT COUNTS AS A GATE, AND WHY THE LIST IS SHORT. Only two calls actually
 * read the session:
 *
 *   - `auth()`                 — lib/auth.ts, the Auth.js handle
 *   - `requireScopedSession()` — lib/queries/session.ts, which throws when the
 *                                session has no user id or no companyId
 *
 * `requireAdmin()` (a local, unexported helper in lib/actions/team.ts) and
 * `getCurrentCompany()` (lib/queries/company.ts) are gates too — but they are
 * NOT in the primitive list, deliberately. Trusting a name is how you end up
 * crediting a helper that has since been rewritten. Instead they must be SHOWN
 * to reach a primitive, by following the call. Both do, in one hop, so both
 * pass; the difference is that this file checked rather than assumed. A future
 * `requireSomething()` that looks authoritative and checks nothing fails here.
 *
 * DELEGATION IS FOLLOWED, ONE HOP. Eleven endpoints have no gate in their own
 * body and reach one through a helper — six in team.ts via `requireAdmin()`,
 * `getMyCompanyAction` via `getCurrentCompany()`, `listCommentsAction` via
 * `listCommentsForTarget()`, `loadMoreActivitiesAction` via
 * `getActivitiesPage()`, and both chat pagination actions via
 * `getChannelBySlug()`. Allow-listing them would have been the cheap option and
 * the wrong one: indirection is the precise shape that hid the cron P0, so it
 * has to be traversed, not excused. One hop is enough for all eleven today
 * (verified: raising the limit to two changes nothing), and the limit stays at
 * one on purpose — a gate two helpers deep is a gate no reviewer will find, and
 * failing here is the right outcome for it.
 *
 * TWO PARSING TRAPS, both of which produced a wrong answer on the first pass:
 *
 *   1. `lib/queries/transactions.ts` contains the string `"use server"` inside
 *      a doc comment explaining that it is NOT a server-action module. Read
 *      comments and you audit a module that has no endpoints in it.
 *   2. A return annotation like `Promise<ActionResult<{ id: string }>>` contains
 *      a `{`. Take "the first brace after the name" as the body and you get the
 *      type instead, the brace matcher closes early, and the body you test is
 *      two characters long — or, worse, runs into the NEXT function and
 *      inherits its gate. Both directions are silent.
 *
 * The last describe block runs the detector over synthetic modules, including
 * both traps and a fake delegation that leads nowhere, because every assertion
 * over the real tree reports an empty list — which is also what a detector that
 * has stopped working reports.
 */

import { describe, expect, it } from "vitest";
import {
  bodyAt,
  gateCallRegex,
  gatePath,
  makeUniverse,
  serverModules,
  universeFromDisk,
} from "../harness/gate-graph";
import type { Mod, Universe } from "../harness/gate-graph";

const ROOT = process.cwd();
const SCAN_ROOTS = ["lib", "app", "components"];

/**
 * Endpoints that legitimately have no auth gate, each with the reason it is
 * safe. Every one is a PRE-AUTH flow: by definition there is no session yet, so
 * demanding one would break the only thing the endpoint exists to do.
 *
 * The assertion below compares this list to the sweep's result in BOTH
 * directions, so it cannot grow by accident and cannot go stale: adding an
 * ungated endpoint fails until it is listed here with a reason, and removing
 * one fails until its entry is deleted. That is the whole mechanism — an
 * allow-list you can append to without anyone noticing is decoration.
 */
const PRE_AUTH_ENDPOINTS: Record<string, string> = {
  "lib/actions/auth.ts:signupAction":
    "Creates the account. There is no session to check — this is what mints one. " +
    "Defended by SignupSchema and gateAuthAction's signup class: 15 per client " +
    "address / 10 min AND 5 per submitted address / 10 min (auth-007).",
  "lib/actions/auth.ts:loginAction":
    "Exchanges a credential for a session. Defended by Auth.js credential " +
    "comparison and, inside authorize(), the credentials buckets that every " +
    "sign-in path funnels through. gateAuthAction's login class CHECKS those " +
    "buckets here for a readable early error and deliberately consumes nothing — " +
    "counting in both layers would halve the advertised 5/min (auth-007).",
  "lib/actions/auth.ts:logoutAction":
    "Destroys the caller's OWN cookie via signOut(). It reads nothing and can " +
    "affect no one else, so a session check would only make sign-out fail for " +
    "someone whose session is already broken — the exact case it must handle.",
  "lib/actions/email-verification.ts:verifyEmailAction":
    "Bearer of a single-use e-mail verification token; the token IS the " +
    "credential. gateAuthAction's tokenRedeem class on top (30/min/address), so " +
    "the token space cannot be swept — loose on purpose, because the token is " +
    "unforgeable and a false refusal lands on a customer's good link.",
  "lib/actions/email-change.ts:confirmEmailChangeAction":
    "Bearer of a single-use e-mail-change token, followed from a mail client " +
    "that carries no session cookie. gateAuthAction tokenRedeem class.",
  "lib/actions/password-reset.ts:requestPasswordResetAction":
    "By definition reachable by someone locked out. Enumeration-safe (same " +
    "response either way) and on gateAuthAction's emailDispatch class, keyed on " +
    "the SUBMITTED address so the allowance is identical whether or not the " +
    "account exists.",
  "lib/actions/password-reset.ts:resetPasswordAction":
    "Bearer of a single-use reset token; it also bumps sessionVersion in the " +
    "same UPDATE as the new hash. gateAuthAction tokenRedeem class.",
  "lib/actions/team.ts:acceptInviteAction":
    "Bearer of a single-use invite token — the invitee has no account yet, so " +
    "there is no session to require. The token row is checked for used/expired, " +
    "and for its workspace's tombstone, before anything is written. The token is " +
    "two UUIDv4s (~244 bits), so guessing it is infeasible at any rate — but the " +
    "token was for a while the ONLY defence, which left an anonymous caller free " +
    "to drive unbounded invite lookups. gateAuthAction tokenRedeem class on top " +
    "since auth-008, same 30/min/address as the other three redeem endpoints." +
    " The GET half of the same surface - the page render at" +
    " app/invite/[token]/page.tsx - is metered separately on the invitePageView" +
    " class (15/min/address); it is not a server module, so this sweep cannot see" +
    " it.",
};

/**
 * Of the pre-auth endpoints, the ones exempt from the "defend yourself some
 * other way" rule below. Exactly one, and its reason is in the table above:
 * sign-out has no secret to guess and nothing to enumerate.
 */
const PRE_AUTH_WITHOUT_SECOND_LINE = new Set<string>(["lib/actions/auth.ts:logoutAction"]);

/** The two calls that actually read a session. See the header. */
// `requireFinanceSession` delegates to `requireScopedSession` internally and
// additionally refuses a non-finance role, so it is strictly stronger than the
// other two. Without it here the traversal reports every reader gated by it as
// an ungated endpoint — a false alarm about a security property.
const PRIMITIVE_GATES = ["auth", "requireScopedSession", "requireFinanceSession"];

/**
 * How many helpers deep a gate may hide. See the header: one, on purpose.
 */
const MAX_DELEGATION_HOPS = 1;

/**
 * Endpoints known to reach their gate through a helper rather than in their own
 * body. Not an exemption — they are fully checked. It is here so that the
 * delegation code path is proven live: if the traversal broke, these would
 * appear as violations, but if the traversal were removed and everything
 * allow-listed instead, this assertion is what notices.
 */
const KNOWN_INDIRECT = [
  "app/(app)/chat/[slug]/actions.ts:loadOlderMessagesAction",
  "app/(app)/chat/[slug]/actions.ts:loadThreadAction",
  "lib/actions/activities.ts:loadMoreActivitiesAction",
  "lib/actions/comments.ts:listCommentsAction",
  "lib/actions/company.ts:getMyCompanyAction",
];

// ---------------------------------------------------------------------------
// source scanning and the module graph
//
// Both live in tests/lib/harness/, not here. The copy of the comment/string
// scanner that used to sit in this file carried audit A49: with no notion of a
// regex literal, a double quote inside a character class opened a string and
// blanked every character after it — INCLUDING an `export async function`
// declaration, which made an ungated endpoint disappear from this sweep rather
// than merely be misjudged. See `still reports an ungated endpoint declared
// below a regex literal with a quote`.
//
// The module graph — Mod, Universe, bodyAt, declarationsOf, importsOf,
// resolveSpecifier, calledNames and gatePath — lives in
// tests/lib/harness/gate-graph.ts, because tests/ops/page-auth.test.ts asks the
// same question of a different starting point (every app/(app) page rather than
// every "use server" export) and a second copy of a fiddly traversal is how this
// repo produced audit A40 and A49.
//
// What stays here is what is specific to endpoints: which calls count as gates,
// how many hops are allowed, and the endpoint surface itself.
// ---------------------------------------------------------------------------

let cachedRepo: Universe | null = null;

function repoUniverse(): Universe {
  if (!cachedRepo) cachedRepo = universeFromDisk(ROOT, SCAN_ROOTS);
  return cachedRepo;
}

export type Endpoint = { mod: Mod; name: string; body: string | null };

/** Every exported async function of a `"use server"` module — every endpoint. */
function endpointsOf(mod: Mod): Endpoint[] {
  const found = Array.from(mod.code.matchAll(/export\s+async\s+function\s+(\w+)/g));
  return found.map((m) => ({ mod, name: m[1]!, body: bodyAt(mod.code, m.index!) }));
}

function allEndpoints(universe: Universe): Endpoint[] {
  const mods = serverModules(universe);
  const out: Endpoint[] = [];
  for (const mod of mods) out.push(...endpointsOf(mod));
  return out;
}

const idOf = (e: Endpoint) => `${e.mod.rel}:${e.name}`;

// ---------------------------------------------------------------------------
// the gate check
// ---------------------------------------------------------------------------

/** The primitives that actually read a session, as a call matcher. */
const GATE_CALL = gateCallRegex(PRIMITIVE_GATES);

/** Endpoint ids with no reachable gate. Sorted, so comparisons are stable. */
function ungatedEndpoints(universe: Universe): string[] {
  const out: string[] = [];
  for (const endpoint of allEndpoints(universe)) {
    if (endpoint.body === null) {
      out.push(`${idOf(endpoint)} (body could not be parsed)`);
      continue;
    }
    if (!gatePath(universe, endpoint.mod.rel, endpoint.body, MAX_DELEGATION_HOPS, GATE_CALL)) {
      out.push(idOf(endpoint));
    }
  }
  return out.sort();
}

/** Endpoint ids that reach a gate only through a helper, with the path. */
function indirectlyGated(universe: Universe): Record<string, string> {
  const out: Record<string, string> = {};
  for (const endpoint of allEndpoints(universe)) {
    if (endpoint.body === null) continue;
    if (GATE_CALL.test(endpoint.body)) continue;
    const path = gatePath(
      universe,
      endpoint.mod.rel,
      endpoint.body,
      MAX_DELEGATION_HOPS,
      GATE_CALL
    );
    if (path) out[idOf(endpoint)] = path;
  }
  return out;
}

describe("server-action auth gates (every endpoint is anonymous until it checks)", () => {
  it("finds the endpoints at all", () => {
    // Guards the guard: every assertion below loops over this, so an empty
    // result is a green suite that inspected nothing.
    const universe = repoUniverse();
    expect(
      serverModules(universe).length,
      'almost no "use server" module was found — SCAN_ROOTS or the directive ' +
        "detector is broken and every check here is now vacuous"
    ).toBeGreaterThan(15);
    expect(
      allEndpoints(universe).length,
      "no exported async function was parsed out of the action modules"
    ).toBeGreaterThan(50);
  });

  it("parses a real body for every endpoint", () => {
    // Trap 2, asserted over the live tree. A brace matcher that closes early
    // hands the gate check a two-character body, which fails loudly; one that
    // closes LATE hands it the next function too, which passes quietly. Both
    // show up as a body that does not look like a function body.
    const broken: string[] = [];
    for (const endpoint of allEndpoints(repoUniverse())) {
      if (endpoint.body === null || endpoint.body.length < 20) {
        broken.push(`${idOf(endpoint)} — body not parsed`);
      } else if (endpoint.body.indexOf("return") === -1) {
        broken.push(`${idOf(endpoint)} — parsed body contains no return`);
      } else if (/export\s+async\s+function/.test(endpoint.body)) {
        broken.push(`${idOf(endpoint)} — parsed body swallowed the next endpoint`);
      }
    }
    expect(broken, `body extraction failed:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it('does not audit a module that only mentions "use server" in a comment', () => {
    // Trap 1, by name. lib/queries/transactions.ts says in its own doc comment
    // that it is deliberately not a server-action module.
    const found = serverModules(repoUniverse()).map((m) => m.rel);
    expect(found).not.toContain("lib/queries/transactions.ts");
    expect(found).toContain("lib/actions/transactions.ts");
  });

  it("reaches an auth gate from every endpoint except the declared pre-auth flows", () => {
    // THE assertion. Compared in both directions so the allow-list can neither
    // grow silently nor go stale.
    const ungated = ungatedEndpoints(repoUniverse());
    const declared = Object.keys(PRE_AUTH_ENDPOINTS).sort();

    expect(
      ungated,
      "Server actions are anonymous POST endpoints; nothing in front of them " +
        "authenticates. These reach no auth() / requireScopedSession() within " +
        `${MAX_DELEGATION_HOPS} helper call. Either add a gate, or — if this is a ` +
        "genuine pre-auth flow — add it to PRE_AUTH_ENDPOINTS with the reason it is " +
        "safe to expose unauthenticated.\n" +
        `  found:    ${ungated.join(", ")}\n` +
        `  declared: ${declared.join(", ")}`
    ).toEqual(declared);
  });

  it("holds no pre-auth exemption for an endpoint that no longer exists", () => {
    // A stale exemption is a standing licence for whatever takes that name next.
    const live = new Set(allEndpoints(repoUniverse()).map(idOf));
    const stale = Object.keys(PRE_AUTH_ENDPOINTS).filter((id) => !live.has(id));
    expect(stale, `exempted endpoints that are gone: ${stale.join(", ")}`).toEqual([]);
  });

  it("gives every pre-auth exemption a written reason", () => {
    // The entry is the decision record. An empty string is not one.
    const thin = Object.keys(PRE_AUTH_ENDPOINTS).filter(
      (id) => (PRE_AUTH_ENDPOINTS[id] ?? "").length < 40
    );
    expect(thin, `exemptions with no real reason: ${thin.join(", ")}`).toEqual([]);
  });

  it("makes every ungated endpoint defend itself some other way", () => {
    // No session check means the second line has to be real: an IP rate-limit
    // bucket, or a single-use token that IS the credential. This is looser than
    // the gate rule by necessity — it cannot prove the token is checked
    // properly — but it does forbid the shape that matters: a new pre-auth
    // endpoint that takes input, touches the database, and throttles nothing.
    const universe = repoUniverse();
    const byId = new Map<string, Endpoint>();
    for (const endpoint of allEndpoints(universe)) byId.set(idOf(endpoint), endpoint);

    const undefended: string[] = [];
    for (const id of Object.keys(PRE_AUTH_ENDPOINTS)) {
      if (PRE_AUTH_WITHOUT_SECOND_LINE.has(id)) continue;
      const body = byId.get(id)?.body ?? "";
      // `gateAuthAction(…)` is the auth family's limiter since auth-007 — ten
      // call sites moved off the single shared `limiters.auth` bucket, and
      // three of them (signup, login, request-password-reset) carry no `token`
      // either, so a detector that knew only the old spelling would have
      // reported them as open, unthrottled write paths. It is a widening of
      // what counts as a limiter, NOT of what counts as a gate: a pre-auth
      // endpoint with neither still fails here.
      const rateLimited = /limiters\.\w+\.consume\s*\(|gateAuthAction\s*\(/.test(body);
      const tokenBearing = /\btoken\b/.test(body);
      if (!rateLimited && !tokenBearing) undefended.push(id);
    }

    expect(
      undefended,
      "These have no auth gate AND no IP rate limit AND no token, which makes them " +
        "an open, unthrottled write path:\n  " +
        undefended.join("\n  ")
    ).toEqual([]);

    // And the one exemption from this sub-rule stays deliberate.
    expect(PRE_AUTH_WITHOUT_SECOND_LINE.size).toBe(1);
  });

  it("meters every pre-auth endpoint, because a single-use token is not a throttle", () => {
    // WHY THIS IS A SECOND, STRICTER PASS OVER THE SAME LIST. The rule above
    // accepts a token IN PLACE OF a limiter. That is the right test for "is this
    // an open, unthrottled WRITE path" and the wrong one for "can a stranger
    // make us work": an unforgeable token stops them taking a seat, and says
    // nothing about how many indexed reads they may ask for. Nothing in front of
    // the action counts either — /invite/* and the reset/verify routes are public
    // in auth.config.ts, and middleware.ts wires only NextAuth.
    //
    // That gap is auth-008. `acceptInviteAction` was the only member of this
    // family carrying no limiter of any kind, and the `token` branch of the rule
    // above is precisely what ratified it: the sweep reported it as defended.
    // A finding this file was supposed to catch, passed by this file.
    //
    // The escape hatch is the SAME set as above — logout, which has no secret to
    // guess and nothing to enumerate — deliberately, so a new pre-auth endpoint
    // cannot be excused from metering without also being excused from the rule
    // above, in writing, in the table at the top.
    const universe = repoUniverse();
    const byId = new Map<string, Endpoint>();
    for (const endpoint of allEndpoints(universe)) byId.set(idOf(endpoint), endpoint);

    const unmetered: string[] = [];
    for (const id of Object.keys(PRE_AUTH_ENDPOINTS)) {
      if (PRE_AUTH_WITHOUT_SECOND_LINE.has(id)) continue;
      const body = byId.get(id)?.body ?? "";
      if (!/limiters\.\w+\.consume\s*\(|gateAuthAction\s*\(/.test(body)) unmetered.push(id);
    }

    expect(
      unmetered,
      "These pre-auth endpoints rely on a token alone. A token is a credential, " +
        "not a valve: an anonymous caller can still spend our database one " +
        "round trip per POST, indefinitely, from one address. Add the matching " +
        "gateAuthAction class — `tokenRedeem` for a redeem endpoint, which is " +
        "30/min/address and costs a real customer nothing:\n  " +
        unmetered.join("\n  ")
    ).toEqual([]);
  });

  it("actually traverses delegation rather than trusting a helper's name", () => {
    // Proves the traversal is live on the real tree. If it were deleted and
    // these five allow-listed instead, this is the assertion that objects —
    // and the six team.ts actions behind requireAdmin() would all go ungated.
    const indirect = indirectlyGated(repoUniverse());
    const ids = Object.keys(indirect).sort();

    for (const known of KNOWN_INDIRECT) {
      expect(
        ids,
        `${known} has no gate in its own body and is supposed to reach one through a ` +
          `helper. It no longer does — either the delegation traversal broke, or the ` +
          `helper stopped gating. Check ${known} before assuming this is a test bug.`
      ).toContain(known);
    }

    // requireAdmin() is a LOCAL helper in team.ts, not in PRIMITIVE_GATES. If
    // this stops holding, every admin-only team action is being credited by a
    // name rather than by a checked call.
    const teamViaAdmin = ids.filter(
      (id) => id.indexOf("lib/actions/team.ts:") === 0 && /requireAdmin/.test(indirect[id] ?? "")
    );
    expect(
      teamViaAdmin.length,
      "no team.ts action was seen reaching auth() through requireAdmin() — a naive " +
        "scan misattributes all of team.ts without that hop"
    ).toBeGreaterThan(3);
  });
});

describe("the gate detector (a sweep is only worth its false-negative rate)", () => {
  // Every assertion above reports an empty list, which is also what a broken
  // detector reports — and the real modules cannot show otherwise while they
  // are correct. So the violations live here, as a universe of synthetic
  // modules driven through the exact same functions.

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

  it("reports an endpoint with no gate anywhere", () => {
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { db } from "@/lib/db";
export async function sweepEverythingAction(): Promise<void> {
  await db.timeEntry.updateMany({ where: { clockOutAt: null }, data: { autoClosed: true } });
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:sweepEverythingAction"]);
  });

  it("still reports an ungated endpoint declared below a regex literal with a quote", () => {
    // Audit A49, in the direction that reaches a customer. The scanner read the
    // double quote inside the character class as the start of a string literal
    // and blanked every character after it — including the `export async
    // function` below — so this file reported no offender and an anonymous,
    // unscoped updateMany over every tenant's time entries passed the sweep.
    // The A49 reproduction in reachability.test.ts loses an hour; this one
    // ships the hole.
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { db } from "@/lib/db";
const SAFE_LABEL = /[^<>"@]+/;
export async function sweepEverythingAction(label: string): Promise<void> {
  if (!SAFE_LABEL.test(label)) return;
  await db.timeEntry.updateMany({ where: { clockOutAt: null }, data: { autoClosed: true } });
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:sweepEverythingAction"]);
  });

  it("passes an endpoint that gates in its own body", () => {
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { auth } from "@/lib/auth";
export async function okAction(): Promise<void> {
  const session = await auth();
  if (!session) return;
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual([]);
  });

  it("follows one hop into an imported query that gates", () => {
    // The listCommentsAction / getActivitiesPage shape.
    const universe = universeWith({
      "lib/queries/things.ts": `
import { requireScopedSession } from "@/lib/queries/session";
export async function listThings() {
  const { companyId } = await requireScopedSession();
  return companyId;
}
`,
      "lib/actions/fixture.ts": `"use server";
import { listThings } from "@/lib/queries/things";
export async function listThingsAction(): Promise<unknown> {
  return listThings();
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual([]);
    expect(indirectlyGated(universe)["lib/actions/fixture.ts:listThingsAction"]).toContain(
      "via listThings() in lib/queries/things.ts"
    );
  });

  it("follows one hop into a local helper that gates", () => {
    // The requireAdmin() shape: unexported, so only the traversal can see it.
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { auth } from "@/lib/auth";
async function requireAdmin() {
  const session = await auth();
  return session?.user?.role === "admin";
}
export async function removeUserAction(): Promise<void> {
  const gate = await requireAdmin();
  if (!gate) return;
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual([]);
  });

  it("does NOT pass a delegation that leads to a helper checking nothing", () => {
    // The whole reason requireAdmin() and getCurrentCompany() are not in
    // PRIMITIVE_GATES: an authoritative-looking name is not a gate. A detector
    // that pattern-matched the name would call this safe.
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { db } from "@/lib/db";
async function requireAdmin() {
  return true;
}
export async function removeUserAction(): Promise<void> {
  const gate = await requireAdmin();
  if (gate) await db.user.deleteMany({});
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:removeUserAction"]);
  });

  it("stops at the hop limit rather than finding a gate two helpers deep", () => {
    // Asserted so the limit is a decision, not an accident. A gate this far
    // from the endpoint is one no reviewer will find, and the header says so.
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { auth } from "@/lib/auth";
async function inner() {
  return auth();
}
async function outer() {
  return inner();
}
export async function deepAction(): Promise<void> {
  await outer();
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:deepAction"]);
  });

  it("does not let a comment vouch for a gate", () => {
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { db } from "@/lib/db";
/**
 * Calls auth() and requireScopedSession() before touching anything. Honest.
 */
export async function wipeAction(): Promise<void> {
  // const session = await auth();
  await db.task.deleteMany({});
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:wipeAction"]);
  });

  it("does not let a string literal vouch for a gate", () => {
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { db } from "@/lib/db";
export async function wipeAction(): Promise<void> {
  const note = "gated by requireScopedSession()";
  await db.task.deleteMany({ where: { title: note } });
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:wipeAction"]);
  });

  it("is not defeated by a generic return annotation containing a brace", () => {
    // Trap 2, both directions. `firstAction` is ungated and MUST be reported
    // even though its return type carries a `{`; and it must not inherit the
    // gate in `secondAction` below it, which is what a runaway brace matcher
    // would hand it.
    const universe = universeWith({
      "lib/actions/fixture.ts": `"use server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
export async function firstAction(
  input: unknown
): Promise<ActionResult<{ id: string; rows: Array<{ n: number }> }>> {
  await db.task.deleteMany({});
  return { success: true, data: { id: "x", rows: [] } };
}
export async function secondAction(): Promise<ActionResult<void>> {
  const session = await auth();
  return { success: Boolean(session), data: undefined };
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual(["lib/actions/fixture.ts:firstAction"]);

    // And the extracted body really is just the first function.
    const mod = universe.get("lib/actions/fixture.ts")!;
    const first = endpointsOf(mod).filter((e) => e.name === "firstAction")[0]!;
    expect(first.body).toContain("db.task.deleteMany");
    expect(first.body).not.toContain("secondAction");
  });

  it("ignores a non-server module, however gateless", () => {
    // A plain query module has no endpoint in it. Auditing one produces noise
    // that trains readers to ignore this file.
    const universe = universeWith({
      "lib/queries/fixture.ts": `/**
 * Read-side queries. No "use server" round-trip — just data.
 */
import { db } from "@/lib/db";
export async function listEverything() {
  return db.task.findMany({});
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual([]);
  });

  it("resolves a relative import as well as an @/ alias", () => {
    // app/(app)/chat/[slug]/actions.ts uses the alias, but nothing stops the
    // next one from using "./queries" — and an unresolved import silently
    // becomes "no gate found", which reads as a real violation.
    const universe = universeWith({
      "app/(app)/x/queries.ts": `
import { requireScopedSession } from "@/lib/queries/session";
export async function loadPage() {
  return requireScopedSession();
}
`,
      "app/(app)/x/actions.ts": `"use server";
import { loadPage } from "./queries";
export async function loadPageAction(): Promise<unknown> {
  return loadPage();
}
`,
    });
    expect(ungatedEndpoints(universe)).toEqual([]);
  });
});
