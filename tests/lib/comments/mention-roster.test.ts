/**
 * Structural guard: every roster handed to the mention parser must select
 * `handle`.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS STRUCTURAL RATHER THAN BEHAVIOURAL.
 * `MentionUser.handle` is OPTIONAL in the type on purpose — lib/comments/
 * mentions.ts says so at length, so that a roster query written before the
 * handle column existed keeps compiling. The price is that omitting
 * `handle: true` from a `select` is neither a type error nor a runtime error.
 * It is SILENCE: pass 1 of `buildMentionIndex` indexes nothing, `@ali` resolves
 * to nobody, and the surface degrades to name-slug behaviour — which is exactly
 * the T16 failure the handle column was added to fix, because a teammate whose
 * display name carries no ASCII letters has no name slug at all.
 *
 * That module's own header names the consequence and then says the quiet part:
 *
 *     "…which means only a grep catches them — see the roster selects in
 *      lib/queries/ and lib/actions/."
 *
 * A grep nobody runs is not a guard. This file is that grep, run by CI.
 *
 * It found finding tasks-and-comments-001 in BOTH directions:
 *
 *   • THE WRITE PATH (fixed). `createCommentAction` and `sendMessageAction`
 *     both loaded the roster as `select: { id, name }`, so every @mention typed
 *     as a handle notified nobody — while the posted comment still rendered a
 *     green "Mentioned Ali Khan" chip, because lib/queries/comments.ts DOES
 *     select handle. The writer was told the ping landed and it never did.
 *
 *   • THE CHAT RENDER PATH (closed — this assertion was red for it, and is the
 *     reason it is worth keeping green). `loadRoster` in lib/queries/chat.ts
 *     selected `{ id, name }`, so with only the write path fixed a chat mention
 *     by handle fired its notification and stored the id, then rendered as plain
 *     text with no chip, because the roster that tokenizes it could not resolve
 *     the handle. The asymmetry was inverted rather than closed, against the
 *     promise in lib/comments/mentions.ts that "a chip renders exactly when a
 *     notification fired". `handle` is now in that select, and this sweep is
 *     what fails if any future roster drops it again.
 *
 * WHAT THIS DOES NOT COVER. The @-autocomplete in the tasks, expenses and
 * project surfaces narrows its roster with
 * `users.map((u) => ({ id: u.id, name: u.name }))` before handing it to
 * `useMentionAutocomplete`, so the picker offers name-slug tokens and never a
 * handle. That is three client components, none of them scanned here, and it is
 * reported rather than asserted — this file is about the rosters that feed the
 * PARSER, which is a server concern.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { extractMentions, tokenizeForRender, type MentionUser } from "@/lib/comments/mentions";

const ROOT = process.cwd();

/** Where a server-side roster can live. Client components are out of scope. */
const SCAN_ROOTS = ["lib"];

/**
 * The parser entry points, plus the shared roster PROVIDER.
 *
 * `getMentionRoster` (lib/comments/roster.ts) exists so a client composer can be
 * handed a roster that carries `handle` - finding tasks-and-comments-002, where
 * /tasks narrowed its roster to `{ id, name }` before handing it to the
 * autocomplete, so no handle could ever be offered and a teammate whose name has
 * no ASCII letters had no row in the dropdown at all. That module does not call
 * the parser itself, so without its name here it escaped this sweep entirely and
 * could have dropped `handle: true` as silently as the queries this file was
 * written for.
 */
const PARSER_ENTRY = /\b(extractMentions|tokenizeForRender|getMentionRoster)\b/;

/**
 * Blank out comments, preserving length so offsets still line up.
 *
 * Load-bearing: the roster selects this file is about are surrounded by long
 * prose comments that quote `select: { id: true, name: true, handle: true }`
 * verbatim, both as the bug and as the fix. Counting those would make every
 * assertion below pass against the bug.
 */
function stripComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let state = "code";

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (state === "code") {
      if (c === "/" && c2 === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        state = "line";
        continue;
      }
      if (c === "/" && c2 === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        state = "block";
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        i += 1;
        continue;
      }
      out[i] = " ";
      i += 1;
      continue;
    }

    // block
    if (c === "*" && c2 === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      state = "code";
      continue;
    }
    if (c !== "\n") out[i] = " ";
    i += 1;
  }

  return out.join("");
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function relOf(abs: string): string {
  return abs
    .slice(ROOT.length + 1)
    .split(sep)
    .join("/");
}

/**
 * The argument text of every `user.findMany(…)` in `src`, by counting brackets
 * forward from the marker.
 *
 * A bracket inside a string literal would throw the count off; there are none
 * in a Prisma `select`, and a roster query that grows one will trip the
 * "found enough queries" guard below rather than pass silently.
 */
function findManyArgs(src: string): string[] {
  const marker = "user.findMany(";
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    let i = at + marker.length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") depth -= 1;
      i += 1;
    }
    out.push(src.slice(at + marker.length, i - 1));
    from = i;
  }
  return out;
}

/**
 * The text of the object literal following `key:` inside `src`, or "".
 *
 * Same bracket count as above, one nesting level in.
 */
function objectAfter(src: string, key: string): string {
  const at = new RegExp("\\b" + key + "\\s*:\\s*\\{").exec(src);
  if (!at) return "";
  let i = at.index + at[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    i += 1;
  }
  return src.slice(start, i - 1);
}

/**
 * Is this `user.findMany` a MENTION roster, as opposed to some other list of
 * people?
 *
 * The distinction is not stylistic, it is structural: `buildMentionIndex` is a
 * two-pass algorithm whose whole correctness argument rests on seeing EVERY
 * claimant of a token, because a handle or a name slug contested by two people
 * has to be voided rather than handed to whichever of them the query happened to
 * return. So a mention roster is, necessarily, every live member of the company:
 * `where: { companyId, deletedAt: null }` and nothing else.
 *
 * A query that filters a PERSON out therefore cannot be a mention roster, and
 * the two in scope here are not: `listDmCandidates` excludes the viewer
 * (`id: { not: userId }`) because you cannot DM yourself, and
 * `addChannelMembersAction` re-verifies a specific list (`id: { in: userIds }`).
 * Demanding `handle: true` of either would be asking for a column nothing reads.
 *
 * A query with NO `select` returns every column, `handle` included, so it is not
 * a hazard and is not reported.
 */
function isMentionRoster(args: string): boolean {
  if (!/\bselect\s*:/.test(args)) return false;
  const where = objectAfter(args, "where");
  if (!/\bcompanyId\b/.test(where)) return false;
  if (!/\bdeletedAt\s*:\s*null\b/.test(where)) return false;
  return !/\bid\s*:/.test(where);
}

type Roster = { mod: string; args: string };

/** Every whole-company roster read in a module that names a parser entry point. */
function rosterQueries(): Roster[] {
  const out: Roster[] = [];
  for (const root of SCAN_ROOTS) {
    const dir = join(ROOT, root);
    if (!statSync(dir).isDirectory()) continue;
    for (const abs of sourceFiles(dir)) {
      const code = stripComments(readFileSync(abs, "utf8"));
      if (!PARSER_ENTRY.test(code)) continue;
      for (const args of findManyArgs(code)) {
        if (!isMentionRoster(args)) continue;
        out.push({ mod: relOf(abs), args });
      }
    }
  }
  return out.sort((a, b) => (a.mod < b.mod ? -1 : 1));
}

const selectsName = (args: string) => /\bname\s*:\s*true\b/.test(args);
const selectsHandle = (args: string) => /\bhandle\s*:\s*true\b/.test(args);

describe("mention rosters (an unselected column is a silently dead @mention)", () => {
  it("finds the roster queries at all", () => {
    // Guards the guard. The assertion below is a loop over this list, so a
    // renamed helper or a moved directory would turn this file into a test
    // that cannot fail — silently, and in green.
    const rosters = rosterQueries();
    expect(
      rosters.length,
      "almost no roster query was found — either `user.findMany` was renamed, the " +
        "parser entry points moved, or stripComments is eating code. Every check " +
        "below is now vacuous. The floor rose to 5 when lib/comments/roster.ts " +
        "was added for tasks-and-comments-002; it must never be lowered to let a " +
        "deleted roster pass."
    ).toBeGreaterThanOrEqual(5);
    expect(
      rosters.filter((r) => selectsName(r.args)).length,
      "no roster selects `name: true`, which every one of them must"
    ).toBeGreaterThanOrEqual(5);
  });

  it("every roster that feeds the mention parser selects handle", () => {
    // THE assertion. `handle` is optional in MentionUser so that pre-handle
    // call sites compile; the cost is that forgetting it is invisible. This is
    // the compiler the type deliberately does not provide.
    const missing = rosterQueries()
      .filter((r) => selectsName(r.args) && !selectsHandle(r.args))
      .map((r) => r.mod);

    expect(
      missing,
      "These modules hand a roster to extractMentions or tokenizeForRender with " +
        "`name: true` and no `handle: true`. Nothing fails, nothing throws, nothing " +
        "logs: @-mentions by handle simply resolve to nobody on that surface, and a " +
        "teammate whose display name has no ASCII letters becomes unmentionable. Add " +
        "`handle: true` to the select:\n" +
        missing.map((m) => `  - ${m}`).join("\n")
    ).toEqual([]);
  });

  it("does not demand the column of a list that is not a mention roster", () => {
    // The precision half. `listDmCandidates` and the membership re-verification
    // in `addChannelMembersAction` both read people out of the same table in a
    // module that mentions the parser, and neither feeds it — one excludes the
    // viewer, the other names specific ids. Asking them for `handle` would be
    // asking for a column nothing reads, which is how a guard earns its way
    // into an allow-list and then into the bin.
    expect(
      isMentionRoster("{ where: { companyId, deletedAt: null }, select: { id: true, name: true } }")
    ).toBe(true);
    expect(
      isMentionRoster(
        "{ where: { companyId, deletedAt: null, id: { not: userId } }, select: { id: true, name: true } }"
      )
    ).toBe(false);
    expect(
      isMentionRoster(
        "{ where: { id: { in: userIds }, companyId, deletedAt: null }, select: { id: true } }"
      )
    ).toBe(false);
    // No `select` at all → every column, handle included. Not a hazard.
    expect(isMentionRoster("{ where: { companyId, deletedAt: null } }")).toBe(false);
  });

  it("does not credit a comment that quotes the fix", () => {
    // Trap: lib/actions/chat.ts and lib/actions/comments.ts each carry a long
    // note quoting both `select: { id: true, name: true }` (the bug) and
    // `handle: true` (the fix). A scan that read comments would call a broken
    // select green because the prose beside it mentions handle.
    const withHandleInProse = "const x = 1; /* handle: true */ const y = 2;";
    expect(selectsHandle(stripComments(withHandleInProse))).toBe(false);
    expect(selectsHandle(stripComments("select: { handle: true }"))).toBe(true);
  });
});

describe("the two halves agree over one roster (the contract the select breaks)", () => {
  // Behavioural anchor for the structural sweep above: WHY the column matters.
  // lib/comments/mentions.ts promises "a chip renders exactly when a
  // notification fired", and both halves read the roster they are given — so
  // the promise is only kept when both are given the same, complete one.
  const AUTHOR = "u_author";
  const complete: MentionUser[] = [
    { id: "u_ali", name: "Ali Khan", handle: "ali" },
    // The case the column exists for: no ASCII letters, so no name slug. The
    // handle is this person's ONLY address.
    { id: "u_mahwish", name: "مہوش", handle: "mahwish" },
  ];
  const narrowed: MentionUser[] = complete.map((u) => ({ id: u.id, name: u.name }));

  it("notifies and renders a chip for the same handle", () => {
    expect(extractMentions("@mahwish can you look at this?", complete, AUTHOR)).toEqual([
      "u_mahwish",
    ]);
    const chips = tokenizeForRender("@mahwish can you look at this?", complete).filter(
      (s) => s.type === "mention"
    );
    expect(chips.length).toBe(1);
  });

  it("goes silent in BOTH halves when the roster arrives without handles", () => {
    // Not an aspiration — a demonstration of what the missing column costs, so
    // the sweep above is not mistaken for tidiness. Nobody is notified and
    // nothing is rendered as a mention: the token is just text.
    expect(extractMentions("@mahwish can you look at this?", narrowed, AUTHOR)).toEqual([]);
    expect(
      tokenizeForRender("@mahwish can you look at this?", narrowed).filter(
        (s) => s.type === "mention"
      ).length
    ).toBe(0);
  });
});
