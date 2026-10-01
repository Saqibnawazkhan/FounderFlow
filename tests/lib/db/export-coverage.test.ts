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

/**
 * rep-005 — the BUTTON must not promise what the file does not contain.
 *
 * The declaration above, the schema-derived coverage check and `meta.notIncluded`
 * all landed with data-integrity-008, and between them they close the "nobody
 * noticed the chat tables" half of this finding. What they cannot reach is the
 * sentence a customer actually reads before clicking, on /settings:
 *
 *   "Download a machine-readable JSON copy of EVERYTHING IN THIS WORKSPACE …"
 *
 * That is the promise the finding quotes, and it was still there — so the product
 * disclosed the omission inside a file the customer opens AFTER deciding to trust
 * the claim that there was nothing to disclose. A person exercising a portability
 * request, or leaving, reads the card, not the JSON.
 *
 * WHY THIS TEST LIVES HERE rather than with the i18n tests: the subject is the
 * same one the rest of this file is about — what the export contains and what it
 * says it contains — and the two have to be checked together or they drift again.
 * `EXPORT_EXCLUDED` growing by one entry is precisely the event that should force
 * someone to re-read this copy.
 */
describe("rep-005 — the settings copy matches what the export contains", () => {
  const STRINGS = join(ROOT, "lib", "i18n", "strings.ts");

  /** The value of `key` in each locale block, in source order: [en, ur]. */
  function copyFor(key: string): string[] {
    const source = readFileSync(STRINGS, "utf8");
    const out: string[] = [];
    // The value is a single string or a `+`-joined run of them, as the file
    // formats long copy. Comments are irrelevant here: a quoted string is the
    // only thing this pattern can match.
    const re = new RegExp(`\\b${key}:\\s*((?:"[^"]*"\\s*\\+?\\s*)+)`, "g");
    let m = re.exec(source);
    while (m !== null) {
      out.push(
        m[1]
          .replace(/"\s*\+\s*"/g, "")
          .replace(/^"|"$/g, "")
          .trim()
      );
      m = re.exec(source);
    }
    return out;
  }

  /** "everything", as each dictionary spells it. */
  const OVERCLAIM_EN = /\beverything\b/i;
  const OVERCLAIM_UR = "ہر چیز";

  it("finds the key in both dictionaries — guard the guard", () => {
    // `Strings = typeof en` makes a missing Urdu key a type error, so two hits is
    // the invariant. One hit would mean the regex broke and every assertion below
    // silently stopped checking the Urdu card.
    const copies = copyFor("exportWorkspaceDesc");
    expect(copies).toHaveLength(2);
    copies.forEach((c) => expect(c.length).toBeGreaterThan(40));
  });

  it("does not promise 'everything in this workspace', in either language", () => {
    const [en, ur] = copyFor("exportWorkspaceDesc");
    expect(en).not.toMatch(OVERCLAIM_EN);
    expect(ur).not.toContain(OVERCLAIM_UR);
  });

  it("still enumerates what IS in the file, so the card stays useful", () => {
    // The fix is a correction, not a retreat into vagueness: a card that says
    // "some of your data" tells a departing founder nothing.
    const [en] = copyFor("exportWorkspaceDesc");
    for (const table of ["projects", "tasks", "transactions", "budgets", "comments"]) {
      expect(en.toLowerCase()).toContain(table);
    }
  });

  it("names the chat omission the route declares", () => {
    // The one exclusion a customer would actually miss, and the one this finding
    // was filed about. `EXPORT_EXCLUDED` also excuses BillingEvent, which is our
    // own webhook-delivery ledger rather than the customer's data — naming that on
    // a settings card would be noise, and the invoices it stands in for come from
    // the LemonSqueezy portal linked two cards up.
    const [en] = copyFor("exportWorkspaceDesc");
    expect(en.toLowerCase()).toMatch(/chat|message/);
    // …and the route really does exclude it, so the copy is not describing a
    // decision that has since been reversed.
    expect(Array.from(declaredExclusions().keys())).toContain("Message");
  });

  it("keeps the password-hash assurance, which was already true", () => {
    const [en] = copyFor("exportWorkspaceDesc");
    expect(en.toLowerCase()).toContain("password");
  });
});
