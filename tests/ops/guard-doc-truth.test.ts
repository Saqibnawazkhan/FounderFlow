/**
 * Structural guard: the documents that DESCRIBE this repo's guards must not
 * describe them wrongly.
 *
 * WHY THIS FILE EXISTS. CLAUDE.md records two separate occasions where a stale
 * claim about a safety mechanism cost real damage — "`.env` no longer points at
 * production" (false for months, while `npx prisma migrate reset` pointed at the
 * live Supabase) and "`db-local.mjs` wraps every `db:*` script" (false, and
 * `db:migrate:staging` was migrating production). Both were fixed the same way:
 * by making the claim CHECKED instead of remembered. This file does that for the
 * four documents in the same family:
 *
 *   CLAUDE.md                            the build-time env gate
 *   scripts/qa-production-readiness.mjs  what a prod build is allowed to forget
 *   scripts/qa-auth-and-sessions.mjs     probe 9b, the invite-token surface
 *   prisma/schema.prisma                 BillingEvent.reason's vocabulary
 *
 * A document that says a guard is MISSING when it exists is worse than silence:
 * it sends the next reader off to build a second one, or — for a QA script — it
 * prints a failure nobody can act on, which is how people learn to skim a QA
 * report. So every assertion here derives the truth from the CODE and then
 * demands the prose agree.
 *
 * HOW, SPECIFICALLY. `productionEnvProblems` is pure and exported, so the
 * required/forbidden sets are obtained by DRIVING the real gate rather than by
 * trusting a comment. The one scrape (the FORBIDDEN_PROD_ENV key list, which is
 * not exported) is immediately re-checked against that behaviour, so a rename
 * fails a named assertion here instead of silently emptying the sweep.
 *
 * The QA scripts cannot be imported: both open a Prisma client, import
 * puppeteer-core and call `main()` at their top level. They are read as text,
 * which is the established pattern here (tests/lib/auth/login-throttle.test.ts
 * parses the same auth script's arithmetic; tests/lib/db/purge-invariants parses
 * prisma/schema.prisma).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { productionEnvProblems } from "@/scripts/vercel-build.mjs";

const ROOT = process.cwd();

function repoText(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const CLAUDE_MD = repoText("CLAUDE.md");
const QA_PRODREADY = repoText("scripts/qa-production-readiness.mjs");
const QA_AUTH = repoText("scripts/qa-auth-and-sessions.mjs");
const VERCEL_BUILD = repoText("scripts/vercel-build.mjs");
const SCHEMA = repoText("prisma/schema.prisma");
const TEAM_ACTION = repoText("lib/actions/team.ts");
const INVITE_PAGE = repoText("app/invite/[token]/page.tsx");
const LS_WEBHOOK = repoText("app/api/webhooks/lemonsqueezy/route.ts");

/**
 * The vars a production build refuses to proceed WITHOUT, read off the real
 * decision function rather than out of its source. An empty environment makes
 * every required var report itself.
 */
const REQUIRED_NAMES: string[] = (() => {
  const names: string[] = [];
  const problems = productionEnvProblems({}) as string[];
  for (let i = 0; i < problems.length; i++) {
    const m = /^([A-Z][A-Z0-9_]*) is not set/.exec(problems[i]);
    if (m) names.push(m[1]);
  }
  return names;
})();

/**
 * The vars a production build refuses to proceed WITH. Scraped, because
 * `FORBIDDEN_PROD_ENV` is not exported — and then verified below by driving the
 * gate with each name, so the scrape cannot go quietly stale.
 */
const FORBIDDEN_NAMES: string[] = (() => {
  const body = /const FORBIDDEN_PROD_ENV = \{([\s\S]*?)\n\};/.exec(VERCEL_BUILD);
  if (!body) return [];
  const names: string[] = [];
  const key = /^ {2}([A-Z][A-Z0-9_]*):/gm;
  let m = key.exec(body[1]);
  while (m !== null) {
    names.push(m[1]);
    m = key.exec(body[1]);
  }
  return names;
})();

/** Is `name` refused when it carries `value`? */
function refusedWith(name: string, value: string): boolean {
  const problems = productionEnvProblems({ [name]: value }) as string[];
  for (let i = 0; i < problems.length; i++) {
    if (problems[i].indexOf(`${name} is set`) === 0) return true;
  }
  return false;
}

/** The markdown section under `heading`, up to the next `### ` heading. */
function markdownSection(source: string, heading: string): string {
  const start = source.indexOf(heading);
  expect(start, `CLAUDE.md no longer has a "${heading}" heading`).toBeGreaterThan(-1);
  const rest = source.slice(start + heading.length);
  const end = rest.indexOf("\n### ");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The var names that have a markdown table ROW of their own in `section` — i.e.
 * the first cell is nothing but a backticked NAME_LIKE_THIS.
 *
 * Needed because a substring search over the section is satisfied by a mention
 * anywhere in the surrounding prose, and the prose is not what the section calls
 * "the list". See the row assertion below.
 */
function tableRowVars(section: string): string[] {
  const names: string[] = [];
  const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm;
  let m = row.exec(section);
  while (m !== null) {
    names.push(m[1]);
    m = row.exec(section);
  }
  return names;
}

const BUILD_SECTION = markdownSection(CLAUDE_MD, "### Production migrations run at BUILD time");

/* ══════════════════════════════════════════════════════════════════════════ */

describe("CLAUDE.md's build-time gate section matches scripts/vercel-build.mjs", () => {
  it("has a non-empty required list and forbidden list to check against", () => {
    // Guards every assertion below from passing because a parse found nothing.
    expect(REQUIRED_NAMES.length).toBeGreaterThanOrEqual(7);
    expect(
      FORBIDDEN_NAMES.length,
      "FORBIDDEN_PROD_ENV could not be read out of scripts/vercel-build.mjs — has it been " +
        "renamed or re-indented? Every forbidden-var assertion in this file depends on it."
    ).toBeGreaterThanOrEqual(2);
    // And the scrape really did find the forbidden list, not some other object:
    // each name must actually be refused by the gate.
    for (let i = 0; i < FORBIDDEN_NAMES.length; i++) {
      const name = FORBIDDEN_NAMES[i];
      expect(
        refusedWith(name, "true"),
        `${name} was scraped from FORBIDDEN_PROD_ENV but productionEnvProblems does not refuse it`
      ).toBe(true);
    }
  });

  it("names every var a production build refuses to ship without", () => {
    for (let i = 0; i < REQUIRED_NAMES.length; i++) {
      expect(
        BUILD_SECTION,
        `${REQUIRED_NAMES[i]} is in REQUIRED_PROD_ENV but CLAUDE.md's build-gate section ` +
          "never mentions it, so the table is no longer the list it claims to be"
      ).toContain(REQUIRED_NAMES[i]);
    }
  });

  /**
   * The ROW, not just the name — and the reason this is a second assertion
   * rather than a tightening of the one above.
   *
   * The test above is a substring search over the whole section, so a var that
   * appears only in the surrounding prose satisfies it. That is not theoretical:
   * when `AUTH_URL` was added on 2026-10-04 (prodready-023) it arrived as both a
   * table row AND a sentence in the paragraph under the table, and deleting the
   * ROW alone left this file green — the sentence carried the name. A reader
   * provisioning Vercel copies the TABLE, so the table is what has to be
   * complete; the prose explains it.
   *
   * Both assertions stay. This one is specific about where the name must be; the
   * looser one still catches a var documented in some other shape (a bullet, a
   * code fence) and says something useful about it.
   */
  it("gives every required var its own row in the Vercel-vars table", () => {
    const documented = tableRowVars(BUILD_SECTION);
    expect(
      documented.length,
      "no `VAR` table rows were found in CLAUDE.md's build-gate section at all — has the " +
        "table been reformatted? Every assertion in this test would otherwise pass vacuously"
    ).toBeGreaterThanOrEqual(REQUIRED_NAMES.length);
    for (let i = 0; i < REQUIRED_NAMES.length; i++) {
      expect(
        documented,
        `${REQUIRED_NAMES[i]} is in REQUIRED_PROD_ENV but has no row of its own in ` +
          "CLAUDE.md's Vercel-vars table. A mention in the prose is not the list — the table " +
          "is what gets copied into the dashboard, and an incomplete one reads as complete."
      ).toContain(REQUIRED_NAMES[i]);
    }
  });

  it("names every var a production build refuses to ship WITH", () => {
    for (let i = 0; i < FORBIDDEN_NAMES.length; i++) {
      expect(
        BUILD_SECTION,
        `${FORBIDDEN_NAMES[i]} is refused by scripts/vercel-build.mjs but CLAUDE.md's ` +
          "build-gate section does not say so. An incomplete list of the vars that switch a " +
          "control off reads as a complete one."
      ).toContain(FORBIDDEN_NAMES[i]);
    }
  });

  it("says so when a forbidden var is refused at ANY value, including 0", () => {
    // PASSWORD_RESET_RESPONSE_FLOOR_MS does its damage at "0", which no
    // truthiness check catches. A doc that says "refuses to proceed if it is
    // SET" is read as "if it is switched on", and 0 is the switch-off value.
    let checked = 0;
    for (let i = 0; i < FORBIDDEN_NAMES.length; i++) {
      const name = FORBIDDEN_NAMES[i];
      if (!refusedWith(name, "0")) continue; // truthy-mode entry, nothing to state
      checked += 1;
      const at = BUILD_SECTION.indexOf(name);
      expect(at, `${name} is absent from CLAUDE.md's build-gate section`).toBeGreaterThan(-1);
      expect(
        BUILD_SECTION.slice(Math.max(0, at - 400), at + 600),
        `${name} is refused at ANY value (0 included) but CLAUDE.md does not say so near it`
      ).toMatch(/any value/i);
    }
    expect(checked, "no forbidden var is refused at any value — has the refuse mode gone?").toBe(1);
  });

  it("names the two Sentry vars the build has an opinion about", () => {
    // Not required (no Sentry at all is a choice this project made out loud) but
    // HALF a Sentry configuration fails the build, and the absent case prints a
    // warning. A table that names neither leaves both surprises undocumented.
    expect(BUILD_SECTION).toContain("SENTRY_DSN");
    expect(BUILD_SECTION).toContain("NEXT_PUBLIC_SENTRY_DSN");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the QA scripts do not send the reader to build a guard that already exists", () => {
  const GUARDED = REQUIRED_NAMES.concat(FORBIDDEN_NAMES);
  const scripts: Array<[string, string]> = [
    ["scripts/qa-production-readiness.mjs", QA_PRODREADY],
    ["scripts/qa-auth-and-sessions.mjs", QA_AUTH],
  ];

  it("claims nothing in vercel-build.mjs covers a var it does cover", () => {
    const offences: string[] = [];
    for (let s = 0; s < scripts.length; s++) {
      const lines = scripts[s][1].split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("nothing in scripts/vercel-build.mjs") === -1) continue;
        for (let g = 0; g < GUARDED.length; g++) {
          if (lines[i].indexOf(GUARDED[g]) === -1) continue;
          offences.push(
            `${scripts[s][0]}:${i + 1} says vercel-build.mjs does not cover ${GUARDED[g]}`
          );
        }
      }
    }
    expect(
      offences,
      "a QA script tells its reader a build-time guard is missing for a var the build really " +
        "does guard. That is worse than silence: it sends them to build a second one."
    ).toEqual([]);
  });

  it("does not scrape scripts/vercel-build.mjs for an identifier that is not there", () => {
    // The original of this rule: section F matched `const requiredProdEnv = {`,
    // an identifier that has never existed (it is REQUIRED_PROD_ENV, keys at two
    // spaces, closing brace at column 0). The parse therefore yielded nothing,
    // printed "requires: (none parsed)", and reported five perfectly-configured
    // vars as omitted on every single run.
    const scrape = /const ([A-Za-z_][A-Za-z0-9_]*) = \\\{/g;
    for (let s = 0; s < scripts.length; s++) {
      scrape.lastIndex = 0;
      let m = scrape.exec(scripts[s][1]);
      while (m !== null) {
        expect(
          VERCEL_BUILD,
          `${scripts[s][0]} greps scripts/vercel-build.mjs for "const ${m[1]} = {", which is not ` +
            "in it. A scrape that matches nothing fails open and invents failures."
        ).toContain(`const ${m[1]} = {`);
        m = scrape.exec(scripts[s][1]);
      }
    }
  });

  it("derives the required-var list from the exported decision, not from its source text", () => {
    expect(
      QA_PRODREADY,
      "section F must import productionEnvProblems from ./vercel-build.mjs. Importing it cannot " +
        "start a build (isDirectInvocation only matches vercel-build.mjs's own filename), and a " +
        "function call cannot be defeated by re-indenting an object literal."
    ).toMatch(/from "\.\/vercel-build\.mjs"/);
    expect(QA_PRODREADY, "the old regex scrape of the build script is still here").not.toMatch(
      /buildScript\.match\(/
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("qa-auth-and-sessions probe 9b — the invite surface IS metered, on both halves", () => {
  const PROBE_9B = (/\/\/ 9b\.[\s\S]*?\/\/ 9c\./.exec(QA_AUTH) ?? ["", ""])[0];

  it("is looking at a surface that really does carry two gates", () => {
    // The premise. If either of these ever stops being true, the probe's old
    // message becomes correct again and the assertions below are wrong.
    expect(TEAM_ACTION).toMatch(/gateAuthAction\(\{\s*kind:\s*"tokenRedeem"/);
    expect(INVITE_PAGE).toMatch(/gateAuthAction\(\{\s*kind:\s*"invitePageView"/);
    expect(PROBE_9B.length, "probe 9b could not be located in the script").toBeGreaterThan(200);
  });

  it("does not tell the reader acceptInviteAction calls no limiter", () => {
    expect(QA_AUTH).not.toMatch(/calls no\s+limiter/);
    expect(QA_AUTH).not.toMatch(/nothing at all prices a guess/);
  });

  it("does not call the invite surface unthrottled", () => {
    // The "unauthenticated" half of the old title is deliberate and
    // test-ratified (an invite link is the credential); only the throttling
    // half was ever the finding, and it is closed.
    expect(QA_AUTH).not.toContain("unauthenticated AND unthrottled");
  });

  it("names both buckets in its failure message, so a real firing is diagnosable", () => {
    expect(PROBE_9B).toContain("invitePageView");
    expect(PROBE_9B).toContain("tokenRedeem");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("prisma/schema.prisma — BillingEvent.reason's comment covers what it can hold", () => {
  /** The comment block immediately above `reason  String?`. */
  const REASON_COMMENT = (() => {
    const at = SCHEMA.indexOf("\n  reason  String?");
    expect(at, "BillingEvent.reason is no longer declared as `reason  String?`").toBeGreaterThan(
      -1
    );
    return SCHEMA.slice(Math.max(0, at - 1400), at);
  })();

  /** The reason string an APPLIED delivery can carry, read from the webhook. */
  const APPLIED_REASON = (() => {
    const m = /const appliedReason = [\s\S]{0,160}?\? "([a-z0-9-]+)"/.exec(LS_WEBHOOK);
    expect(
      m,
      'no `const appliedReason = … ? "…"` in the LemonSqueezy webhook — has the bill-010 ' +
        "drop-recording changed shape?"
    ).not.toBe(null);
    return (m as RegExpExecArray)[1];
  })();

  it("names the reason an applied row can carry", () => {
    // bill-010: a delivery that APPLIED but had to drop an unreadable period end
    // writes outcome "applied" WITH a reason. A comment that says reason is the
    // reason behind a "non-applied outcome" understates a billing audit column,
    // which is the one place understatement is not harmless.
    expect(
      REASON_COMMENT,
      `app/api/webhooks/lemonsqueezy/route.ts writes reason "${APPLIED_REASON}" on an APPLIED ` +
        "row, and BillingEvent.reason's comment does not mention it"
    ).toContain(APPLIED_REASON);
  });

  it("no longer claims an applied row always has a null reason", () => {
    expect(REASON_COMMENT).not.toMatch(/NULL for a plain application/);
  });
});
