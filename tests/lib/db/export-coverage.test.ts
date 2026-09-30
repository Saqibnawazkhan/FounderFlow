/**
 * data-integrity-008 — "the export leaves out every chat message" is NO LONGER
 * TRUE AS A DEFECT, and the guard it asked for is what is actually missing.
 *
 * The filing rests on the route's old header calling the file "every row this
 * workspace owns". That header now says the opposite, at length and for a sound
 * reason (findings sec-007 / rep-002): `Message` and `Channel` are absent ON
 * PURPOSE, because `lib/auth/channel-permissions.ts` refuses to give an admin a
 * back door into a private channel they were never invited to, and a
 * self-service download is not the "explicit, auditable, logged path" that
 * refusal names. The same review scoped `Notification` to the caller for exactly
 * this reason — chat fan-out stores a 140-character slice of the message body on
 * DM and mention pings, so a company-wide notification read was conversation
 * content wearing a portability label. `NotificationPreference` is already in
 * `scope=me`. So the omission is a privacy decision, not an oversight.
 *
 * WHAT IS STILL WRONG is the SHAPE of that decision: it lives only in prose. The
 * chat tables landed on 2026-09-24 and the export did not learn about them for
 * five days, during which nothing could tell "deliberately excluded" from
 * "nobody noticed". The filing's own second suggestion is the right one, so this
 * file implements it: every workspace-scoped model in prisma/schema.prisma must
 * be named in `app/api/export/route.ts` OR listed in a declared exclusion set
 * with a reason. The thirteenth table is then covered on the day it lands, by
 * nobody remembering anything — the same design as `PURGE_EXCLUDED` and
 * `tests/lib/db/purge-invariants.test.ts` next door.
 *
 * WHY SOURCE TEXT: `route.ts` is a Next.js Route Handler, so it cannot export a
 * constant for a test to import — Next validates route exports. Reading the file
 * is the only honest way to ask "does this handler name this table", and it is
 * what purge-invariants.test.ts already does for the nightly sweep.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const EXPORT_ROUTE = join(ROOT, "app", "api", "export", "route.ts");

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function schemaModels(): Array<{ name: string; body: string }> {
  const schema = readFileSync(SCHEMA, "utf8");
  const matches: Array<{ name: string; body: string }> = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m = re.exec(schema);
  while (m !== null) {
    matches.push({ name: m[1], body: codeOnly(m[2]) });
    m = re.exec(schema);
  }
  return matches;
}

/** Models that belong to a workspace by column — the customer's own data. */
function workspaceScopedModels(): string[] {
  return schemaModels()
    .filter(({ body }) => /^\s*companyId\s+String/m.test(body))
    .map(({ name }) => name);
}

function delegateFor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Read a declared exclusion list out of the route's source, with its reasons.
 *
 * A missing declaration FAILS rather than defaulting to "nothing is excluded": a
 * guard that reads a deleted list as an empty one can be switched off by deleting
 * a line. Same helper shape as purge-invariants.test.ts.
 */
function declaredExclusions(): Map<string, string> {
  const source = readFileSync(EXPORT_ROUTE, "utf8");
  const decl =
    /const\s+EXPORT_EXCLUDED\b[^=]*=\s*new Map<string,\s*string>\(\s*\[([\s\S]*?)\]\s*\)/;
  const found = decl.exec(source);
  expect(
    found,
    "EXPORT_EXCLUDED is not declared in app/api/export/route.ts. It is the only " +
      'sanctioned way to say "this workspace table is knowingly not exported"; ' +
      "without it this test cannot tell a deliberate privacy decision from an " +
      "oversight — which is exactly what happened when the four chat tables landed " +
      "on 2026-09-24 and nothing noticed for five days."
  ).not.toBeNull();
  const out = new Map<string, string>();
  const pair = /\[\s*"([^"]+)"\s*,\s*((?:"[^"]*"\s*\+?\s*)+),?\s*\]/g;
  let p = pair.exec(found?.[1] ?? "");
  while (p !== null) {
    const reason = p[2].replace(/"\s*\+\s*"/g, "").replace(/^"|"$/g, "");
    out.set(p[1], reason);
    p = pair.exec(found?.[1] ?? "");
  }
  return out;
}

describe("data-integrity-008 — every workspace table is exported or explicitly excused", () => {
  it("parses the schema and the route at all — guard the guard", () => {
    // Without this, a path or formatting change turns the loop below into a pass
    // over an empty list and the file reads as coverage of nothing.
    expect(schemaModels().length).toBeGreaterThan(10);
    expect(workspaceScopedModels().length).toBeGreaterThan(8);
    expect(readFileSync(EXPORT_ROUTE, "utf8").length).toBeGreaterThan(1000);
  });

  it("names every companyId-bearing model, or excuses it with a reason", () => {
    const body = codeOnly(readFileSync(EXPORT_ROUTE, "utf8"));
    const excluded = declaredExclusions();

    for (const model of workspaceScopedModels()) {
      if (excluded.has(model)) continue;
      const delegate = delegateFor(model);
      expect(
        new RegExp(`\\bdb\\.${delegate}\\.(?:findMany|findFirst)\\s*\\(`).test(body),
        `${model} carries companyId — it is this workspace's data — but the export ` +
          `route never reads db.${delegate}. A portability download that silently ` +
          `omits a whole product surface is worse than one that refuses: the customer ` +
          `cannot tell. Read it, or add "${model}" to EXPORT_EXCLUDED with a reason.`
      ).toBe(true);
    }
  });

  it("every exclusion names a real workspace model and carries a real reason", () => {
    // Stops the set being used as a dumping ground, and stops an entry outliving
    // the table it was written for.
    const models = workspaceScopedModels();
    const excluded = declaredExclusions();
    expect(excluded.size).toBeGreaterThan(0);
    for (const entry of Array.from(excluded.keys())) {
      expect(models, `EXPORT_EXCLUDED names "${entry}", which is not a workspace model`).toContain(
        entry
      );
      expect(
        (excluded.get(entry) ?? "").length,
        `EXPORT_EXCLUDED["${entry}"] has no usable reason. "Because we do not" is not one — ` +
          `say what a customer loses and why that is the right trade.`
      ).toBeGreaterThan(40);
    }
  });

  it("no exclusion is a lie — an excused table is really not read", () => {
    // The other direction, and the reason the placeholder that was briefly in this
    // Map had to come out. An entry for a table the route DOES read would be a
    // comment that contradicts the code, in the file whose whole job here is to
    // make the decision checkable.
    const body = codeOnly(readFileSync(EXPORT_ROUTE, "utf8"));
    for (const model of Array.from(declaredExclusions().keys())) {
      const delegate = delegateFor(model);
      expect(
        new RegExp(`\\bdb\\.${delegate}\\.(?:findMany|findFirst)\\s*\\(`).test(body),
        `EXPORT_EXCLUDED claims "${model}" is not exported, but the route reads ` +
          `db.${delegate}. Delete the entry — it is now a comment that contradicts ` +
          `the code, and meta.notIncluded is telling customers something untrue.`
      ).toBe(false);
    }
  });

  it("the chat tables are excused for the PRIVACY reason, not by omission", () => {
    // The specific decision this finding is about. If someone later adds chat to
    // the export, they have to delete these entries — which puts the
    // private-channel argument in front of them at the moment it matters.
    const excluded = declaredExclusions();
    for (const model of ["Channel", "Message"]) {
      expect(excluded.has(model), `${model} should be in EXPORT_EXCLUDED`).toBe(true);
      expect(excluded.get(model) ?? "").toMatch(/private|channel-permissions|audit/i);
    }
  });

  it("discloses the omission in the export file itself", () => {
    // A customer exercising a portability request is entitled to know what the
    // file does NOT contain. Silence is the part of this finding that was real.
    const body = codeOnly(readFileSync(EXPORT_ROUTE, "utf8"));
    expect(body).toMatch(/EXPORT_EXCLUDED/);
    expect(body).toMatch(/notIncluded|omitted/);
  });
});
