/**
 * team-and-invites-009 — the invite smoke could never reach step 3.
 *
 * `scripts/smoke-invite.mjs` is the project's only end-to-end cover for the
 * invite round trip, and CLAUDE.md's "Targeted puppeteer smoke under
 * scripts/smoke-*.mjs for any feature that touches auth, finance, or projects"
 * is the rule it was written to satisfy. It could not satisfy it, for two
 * independent reasons that both sit in the first thirty lines:
 *
 *   1. THE PASSWORD IT TYPES IS REJECTED BY THE SCHEMA. It set
 *      `` `claim-${stamp}` ``, where `stamp` is `Date.now()` — lowercase letters
 *      and digits and no capital. `PasswordSchema` (lib/schemas/password.ts)
 *      requires a lowercase AND an uppercase AND a digit, and
 *      `AcceptInviteSchema` embeds it, so `acceptInviteAction` answered
 *      "Password needs an uppercase letter" every single run. Step 3 — accept,
 *      auto-sign-in, land on /dashboard — was unreachable.
 *
 *   2. IT POINTED AT A PORT NOTHING SERVES. `BASE` defaulted to :3009 while the
 *      documented dev port is 3000 (CLAUDE.md's "Local development from
 *      scratch"), so a run with no `BASE` in the environment failed at the first
 *      `goto` and never got as far as the password at all.
 *
 * Every finding filed against this flow — an invite into a tombstoned workspace,
 * the seat cap, the deactivated-teammate refusal, the role change that did not
 * revoke anything — lives in code this script was supposed to be watching.
 *
 * WHY A UNIT TEST RATHER THAN A RUN. A smoke script rots silently: nobody runs
 * it, and when they do the failure looks like a product bug rather than a stale
 * literal. Parsing the source and pushing its own password literal through the
 * real `PasswordSchema` catches the rot without a browser, a dev server or a
 * database — and it is the check that would have caught this on the day it was
 * written.
 *
 * WHAT THIS CANNOT CHECK, so nobody reads green here as "the invite flow works":
 * it proves the script's inputs are valid, not that the round trip passes. That
 * still needs a dev server on :3000 and the local Postgres. It also does not fix
 * the third defect the finding names — the script drives the seeded `demo-nimbus`
 * workspace instead of signing up its own throwaway tenant, so a run leaves an
 * Activity row and a #general membership behind. That is a rewrite of the whole
 * script, unverifiable without the run, and is filed rather than half-done.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PasswordSchema } from "@/lib/schemas/password";

const SMOKE_PATH = join(process.cwd(), "scripts", "smoke-invite.mjs");
const source = readFileSync(SMOKE_PATH, "utf8");

/**
 * `source` with its comment-only lines dropped, for the sweep that looks for a
 * call shape.
 *
 * NEEDED because the script's own comments QUOTE the defective calls in order to
 * explain them — "these two reads were `db.user.count()`" — so a sweep over the
 * raw text reports the explanation as the defect. That is not hypothetical: this
 * test failed exactly that way against a correct script, the second time in this
 * one file that a structural assertion was fooled by prose.
 *
 * DELIBERATELY NOT the two-regex stripper (blank `/*…*\/`, then `//…`) that nine
 * other guards in this repo share. FaultsAudit A40: running the block pattern
 * over text that still contains line comments lets a `//` comment containing a
 * `/*` open a block the regex closes at the next `*\/`, blanking every real line
 * between — and it silently blanked 130 lines in one of those guards. Dropping
 * whole comment-only lines cannot do that: it never deletes part of a line, so a
 * line carrying real code is always kept in full, whatever punctuation the
 * comments around it contain.
 *
 * Only the sweep uses it; the literal checks stay on `source`, where matching the
 * real text is the point.
 */
const code = source
  .split("\n")
  .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
  .join("\n");

describe("scripts/smoke-invite.mjs — its own inputs have to be valid", () => {
  it("was read at all", () => {
    // Guard the guard: every assertion below is a regex over `source`, so a
    // move or a rename would turn this file into six vacuous passes.
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain("puppeteer");
    expect(source).toContain("/invite/");
    // …and that stripping comments left the code behind, not an empty string.
    expect(code).toContain("db.inviteToken.findFirst(");
  });

  it("types a password the invite schema actually accepts", () => {
    // The literal is a template with one interpolation, so the check has to be
    // on the STRING THE SCRIPT PRODUCES, not on the template text: substituting a
    // real stamp is what makes this the same question the server asks.
    const match = /const newPassword = `([^`]*)`/.exec(source);
    expect(match, "the password literal moved — this assertion needs updating").not.toBeNull();

    const produced = (match as RegExpExecArray)[1].replace("${stamp}", String(Date.now()));
    const parsed = PasswordSchema.safeParse(produced);

    expect(
      parsed.success
        ? "accepted"
        : `rejected: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      "AcceptInviteSchema embeds PasswordSchema, so a password this refuses means " +
        "acceptInviteAction refuses the smoke before it touches the invite at all."
    ).toBe("accepted");
  });

  it("defaults to the documented dev port", () => {
    const match = /process\.env\.BASE \?\? "http:\/\/localhost:(\d+)"/.exec(source);
    expect(match, "the BASE default moved — this assertion needs updating").not.toBeNull();
    expect(
      (match as RegExpExecArray)[1],
      "CLAUDE.md documents `npm run dev` on 3000; :3009 means an unset BASE fails at the " +
        "first navigation."
    ).toBe("3000");
  });

  it("never counts rows across every tenant at once", () => {
    // `db.user.count()` and `db.inviteToken.count()` with no `where` read every
    // workspace in the database. Unsound as a before/after comparison the moment
    // anything else is writing, and meaningless as context.
    //
    // An `exec` loop rather than `matchAll` in a `for…of`: tsconfig.json sets
    // `lib` and no `target`, so `tsc` defaults to ES5 and the iterator form is
    // TS2802 even though vitest transpiles it happily.
    const unscoped = /db\.(?:user|inviteToken|company|activity)\.count\(\s*\)/g;
    const found: string[] = [];
    let hit = unscoped.exec(code);
    while (hit !== null) {
      found.push(hit[0]);
      hit = unscoped.exec(code);
    }
    expect(found, "every count in a multi-tenant smoke needs a company scope").toEqual([]);
  });

  it("still cleans up the rows it created", () => {
    // The script hard-deletes its own throwaway User and InviteToken at the end.
    // Losing that is how a smoke leaves a permanent resident in the demo
    // workspace other agents and demos read.
    expect(source).toContain("db.user.delete(");
    expect(source).toContain("db.inviteToken.delete(");
  });

  it("is pinned to the local database, never a hosted one", () => {
    // CLAUDE.md: a bare `new PrismaClient()` in scripts/ resolves the root
    // `.env`. `localDb()` reads `.env.local` and throws on any non-loopback host.
    //
    // The property asserted is that the client is never CONSTRUCTED here, and
    // the check is on the import rather than on the phrase "new PrismaClient(":
    // this script's own header explains the hazard in those words, so a
    // substring check on it fails against a correct file. That mistake was made
    // in this very test and caught by running it.
    expect(source).toContain('from "./_local-db.mjs"');
    expect(source).toContain("localDb()");
    expect(source).not.toContain("@prisma/client");
  });
});
