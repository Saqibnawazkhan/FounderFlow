/**
 * Structural guard: a row that can be tombstoned must also be reachable by the
 * thing that erases tombstones, and by the thing that creates them.
 *
 * THE INCIDENT THIS ENCODES (2026-09-24 → 2026-09-25). The chat rollout added
 * four tables, one of which — Message — became the SEVENTH soft-delete table.
 * Two sweeps that are supposed to know every such table did not learn about it:
 *
 *   - `purgeCompany` in app/api/cron/purge-soft-deleted/route.ts names its
 *     tables one by one, and named eleven. The chat rows still disappeared,
 *     because every chat FK is `onDelete: Cascade` — so nothing threw, nothing
 *     jammed, and the only visible symptom was a number: the returned row
 *     count, which feeds `warnBulkMutation`. The canary that exists to shout
 *     when a purge is unexpectedly large was being handed an undercount.
 *   - `softDeleteWorkspace` in lib/actions/account.ts tombstoned six tables and
 *     left every Message in a "deleted" workspace with `deletedAt: null`.
 *
 * Both are the same failure: a list of table names maintained by hand, in a
 * schema that grows. So these tests do not hold a list. They PARSE
 * prisma/schema.prisma, derive the models that must be covered, and check the
 * two functions' source against it. The eighth soft-delete table is covered on
 * the day it is added, by nobody remembering anything.
 *
 * Why source text rather than importing the modules: `route.ts` is a Next.js
 * route handler and `account.ts` is a `"use server"` module, so neither can
 * export a plain constant for a test to read (Next validates route exports;
 * "use server" files may only export async functions). Reading the file is not
 * a workaround here — it is the only honest way to ask "does this function
 * mention this table", and it is what tests/lib/db/script-safety.test.ts
 * already does for the production-wipe guard next door.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const PURGE_ROUTE = join(ROOT, "app", "api", "cron", "purge-soft-deleted", "route.ts");
const ACCOUNT_ACTIONS = join(ROOT, "lib", "actions", "account.ts");

/** Strip comments so a file that *mentions* a table isn't credited with sweeping it. */
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

/**
 * Every `model X { ... }` block in the schema, comments stripped. Prisma always
 * closes a model with `}` in column zero, which is what makes this parseable
 * without a real parser.
 */
function schemaModels(): Array<{ name: string; body: string }> {
  const schema = readFileSync(SCHEMA, "utf8");
  const matches = Array.from(schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm));
  return matches.map((m) => ({ name: m[1], body: codeOnly(m[2]) }));
}

/** Models declaring the Tier 3 tombstone column — the list nobody may hardcode. */
function softDeletableModels(): string[] {
  return schemaModels()
    .filter(({ body }) => /^\s*deletedAt\s+DateTime\?/m.test(body))
    .map(({ name }) => name);
}

/** Models that belong to a workspace by column, so a workspace erasure must reach them. */
function workspaceScopedModels(): string[] {
  return schemaModels()
    .filter(({ body }) => /^\s*companyId\s+String/m.test(body))
    .map(({ name }) => name);
}

/** Prisma's delegate for a model is its name with a lowercased first letter. */
function delegateFor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * The body of one top-level `async function`, up to its column-zero `}`.
 * Slicing matters: `deleteAccountAction` also calls `db.user.update`, and
 * crediting `softDeleteWorkspace` for a write in a different function is
 * exactly the kind of false pass that makes a guard worthless.
 */
function functionBody(file: string, name: string): string {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`async function ${name}`);
  expect(
    start,
    `${name}() is gone from ${file}. Every assertion below reads its body, so a ` +
      `rename here silently disables this whole file — fix the name, don't delete the test.`
  ).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `Could not find the closing brace of ${name}().`).toBeGreaterThan(start);
  return codeOnly(source.slice(start, end));
}

/**
 * Read a declared exclusion list out of a module's source. Both sweeps keep one
 * so that "this table is deliberately not covered" has to be written down, in
 * the file, next to a reason — instead of being expressed as an absence, which
 * is precisely how the chat tables went missing for a day.
 *
 * A missing declaration fails rather than defaulting to "nothing is excluded":
 * a guard that quietly treats a deleted list as an empty one is a guard that
 * can be switched off by deleting a line.
 */
function declaredExclusions(file: string, constName: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const decl = new RegExp(
    `const\\s+${constName}\\b[^=]*=\\s*(?:new Set<string>\\()?\\s*\\[([^\\]]*)\\]`
  );
  const found = decl.exec(source);
  expect(
    found,
    `${constName} is not declared in ${file}. It is the only sanctioned way to say ` +
      `"this table is knowingly not swept"; without it the tests below cannot tell a ` +
      `deliberate exclusion from an oversight.`
  ).not.toBeNull();
  const names = Array.from((found?.[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)).map((m) => m[1]);
  return new Set(names);
}

describe("prisma schema parsing (the list nobody is allowed to hardcode)", () => {
  it("finds models in the schema at all", () => {
    // Without this, a change to Prisma's formatting turns every assertion in
    // this file into a loop over an empty array, and the suite goes green.
    expect(schemaModels().length).toBeGreaterThan(10);
  });

  it("tells soft-deletable models apart from the rest", () => {
    const all = schemaModels().map((m) => m.name);
    const soft = softDeletableModels();
    // Both directions matter. If the field regex matched everything, the
    // second assertion catches it; if it matched nothing, the first does.
    expect(soft.length).toBeGreaterThan(1);
    expect(soft.length).toBeLessThan(all.length);
  });
});

describe("purgeCompany (the nightly hard-delete sweep)", () => {
  it("every model carrying deletedAt is swept or explicitly excluded by the purge cron", () => {
    // THE regression test for 2026-09-24: the moment `Message.deletedAt`
    // landed in the schema, this assertion would have gone red, naming Message,
    // before the cron ever ran with an undercounted row total.
    const body = functionBody(PURGE_ROUTE, "purgeCompany");
    const excluded = declaredExclusions(PURGE_ROUTE, "PURGE_EXCLUDED");

    for (const model of softDeletableModels()) {
      if (excluded.has(model)) continue;
      const delegate = delegateFor(model);
      expect(
        new RegExp(`\\b(?:tx|db)\\.${delegate}\\.delete(?:Many)?\\s*\\(`).test(body),
        `${model} carries a deletedAt tombstone but purgeCompany() never names ` +
          `tx.${delegate}. If its rows vanish anyway via onDelete: Cascade, they are ` +
          `still missing from the returned count — which is what warnBulkMutation ` +
          `thresholds on — and the next person to change that FK to Restrict jams ` +
          `this transaction on a table that appears nowhere in the file. Delete it ` +
          `by name, or add "${model}" to PURGE_EXCLUDED with a reason.`
      ).toBe(true);
    }
  });

  it("every workspace-scoped model is named in the purge transaction", () => {
    // Broader than the tombstone rule above, and older: Channel has no
    // deletedAt column, so only this assertion would have caught it on
    // 2026-09-24. Anything carrying companyId is workspace data, and a
    // workspace erasure that doesn't name it is trusting a cascade it claims
    // in its own doc comment not to rely on.
    const body = functionBody(PURGE_ROUTE, "purgeCompany");
    const excluded = declaredExclusions(PURGE_ROUTE, "PURGE_EXCLUDED");

    for (const model of workspaceScopedModels()) {
      if (excluded.has(model)) continue;
      const delegate = delegateFor(model);
      expect(
        new RegExp(`\\b(?:tx|db)\\.${delegate}\\.delete(?:Many)?\\s*\\(`).test(body),
        `${model} carries companyId — it is workspace data — but purgeCompany() ` +
          `never deletes tx.${delegate} by name. Add it in dependency order ` +
          `(children before parents), or add "${model}" to PURGE_EXCLUDED with a reason.`
      ).toBe(true);
    }
  });

  it("removes the company row itself, not only its children", () => {
    // Company has no companyId of its own, so neither loop above covers it,
    // and a sweep that leaves the parent row behind is not an erasure.
    const body = functionBody(PURGE_ROUTE, "purgeCompany");
    expect(body).toMatch(/\btx\.company\.delete\s*\(/);
  });
});

describe("softDeleteWorkspace (the tombstone sweep behind both danger-zone actions)", () => {
  it("tombstones every soft-deletable model when a workspace is deleted", () => {
    // Same schema-derived list, other end of the lifecycle. This is the
    // assertion that would have caught a "deleted" workspace still holding
    // chat messages with deletedAt: null for the full 90-day window.
    const body = functionBody(ACCOUNT_ACTIONS, "softDeleteWorkspace");
    const excluded = declaredExclusions(ACCOUNT_ACTIONS, "SOFT_DELETE_EXCLUDED");

    for (const model of softDeletableModels()) {
      if (excluded.has(model)) continue;
      const delegate = delegateFor(model);
      expect(
        new RegExp(`\\bdb\\.${delegate}\\.update(?:Many)?\\s*\\(`).test(body),
        `${model} carries a deletedAt tombstone but softDeleteWorkspace() never ` +
          `writes db.${delegate}. Its rows survive a workspace delete with ` +
          `deletedAt: null, so anything that trusts the tombstone rather than the ` +
          `session — an export, a support query, the GDPR anonymization pass — ` +
          `reads them as live. Tombstone it, or add "${model}" to ` +
          `SOFT_DELETE_EXCLUDED with a reason.`
      ).toBe(true);
    }
  });

  it("writes every tombstone in one transaction", () => {
    // A partial failure that tombstones the Company but not its Messages is
    // the same defect as forgetting the table, arrived at by a different road.
    const body = functionBody(ACCOUNT_ACTIONS, "softDeleteWorkspace");
    expect(body).toMatch(/db\.\$transaction\s*\(/);
  });

  it("counts every row it tombstones, because the canary thresholds on that number", () => {
    // Each updateMany in the transaction must reach the returned sum. Derived
    // from the destructured names, so adding a table without adding it to the
    // total is caught the same way a missing table is.
    const body = functionBody(ACCOUNT_ACTIONS, "softDeleteWorkspace");
    const destructure = /const\s*\[([^\]]+)\]\s*=\s*await\s+db\.\$transaction/.exec(body);
    expect(
      destructure,
      "softDeleteWorkspace() no longer destructures its transaction result."
    ).not.toBeNull();

    const names = (destructure?.[1] ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(1);

    const returned = body.slice(body.indexOf("return", body.indexOf("$transaction")));
    for (const name of names) {
      expect(
        new RegExp(`\\b${name}\\b`).test(returned),
        `softDeleteWorkspace() tombstones "${name}" but never adds it to the returned ` +
          `count. warnBulkMutation() thresholds on that number, so the rows are erased ` +
          `from the alert, not from the database.`
      ).toBe(true);
    }
  });
});
