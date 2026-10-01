/**
 * Structural guard: nothing under scripts/ may reach a database it was not
 * explicitly pointed at.
 *
 * THE INCIDENT THIS ENCODES (2026-09-25). `new PrismaClient()` resolves
 * DATABASE_URL by auto-loading the ROOT `.env`. Next.js reads `.env.local`
 * first; Prisma does not. The root `.env` names production Supabase. So six
 * smoke scripts and `wipe-data.mjs` — which runs unscoped `deleteMany()` over
 * every table with no confirmation prompt — were reading and writing the live
 * database from a developer laptop, and `npm run db:reset:local` would have
 * dropped the production schema without a prompt.
 *
 * None of that was visible in a diff, because the dangerous line is the one
 * that looks most ordinary: `const db = new PrismaClient()`.
 *
 * This file iterates the directory rather than naming files, so a script added
 * next month is covered the day it lands. A failure here is not a style nit.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../harness/source-scan";

const SCRIPTS = join(process.cwd(), "scripts");

/**
 * `_local-db.mjs` is the ONE place allowed to construct a client: it reads
 * `.env.local`, proves the host is loopback, and throws otherwise. Everything
 * else goes through it. This list is an allow-list of exactly one on purpose —
 * if it ever needs a second entry, that is the moment to ask why.
 */
const MAY_CONSTRUCT_A_CLIENT = new Set(["_local-db.mjs"]);

/**
 * `_local-psql.mjs` is the ONE place allowed to shell out to a Postgres CLI, for
 * the same reason and with the same shape: it pins the container, consults
 * `localDatabaseUrl()` so a `.env.local` repointed at hosted data refuses the
 * run, and takes nothing from the environment. One entry, on purpose.
 */
const MAY_SHELL_OUT_TO_SQL = new Set(["_local-psql.mjs"]);

/**
 * Scripts that still name a Postgres CLI beside a child-process import and are
 * not offenders.
 *
 * `qa-harness-auditor.mjs` is the auditor that FOUND this hole: it greps the
 * other scripts for `docker exec … psql` and reports what it finds. The pattern
 * it searches for is the pattern this rule searches for, so it matches itself.
 * It runs no SQL of its own.
 *
 * Staleness-guarded below, so an entry cannot outlive its reason.
 */
const NOT_YET_ROUTED = new Map<string, string>([
  [
    "qa-harness-auditor.mjs",
    "greps other scripts for the docker-exec/psql shape and reports it; issues no SQL itself",
  ],
]);

/**
 * The Postgres command-line tools. `psql` needs a word boundary either side or
 * it matches `psqlScalar` — which is the helper NAME, not an invocation, and
 * every converted script mentions it.
 */
const POSTGRES_CLI = /(?:^|[^\w-])(?:psql|pg_dump|pg_restore|pg_dumpall)(?![\w-])/;

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"));
}

// `stripComments` (comments blanked, string literals left INTACT) comes from
// tests/lib/harness/source-scan.ts. Strings have to survive here, because the
// hazards this file looks for are spelled inside them: the shell command that
// reaches the database is a string literal. The private copy that used to sit
// here carried audit A40 — it blanked block comments first, over text that
// still contained line comments, so a line comment mentioning a block opener
// blanked every line down to the next block terminator. A guard that stops
// reading part of a script is a guard that reports it clean.

describe("scripts/ database safety (the production-wipe guard)", () => {
  it("has scripts to check at all", () => {
    // Without this, every assertion below passes vacuously the day someone
    // renames the directory.
    expect(scriptFiles().length).toBeGreaterThan(5);
  });

  it("builds a Prisma client in exactly one place, and that place checks the host", () => {
    const offenders = scriptFiles().filter((file) => {
      if (MAY_CONSTRUCT_A_CLIENT.has(file)) return false;
      return /new\s+PrismaClient\s*\(/.test(
        stripComments(readFileSync(join(SCRIPTS, file), "utf8"))
      );
    });

    expect(
      offenders,
      `These scripts construct their own PrismaClient, which auto-loads the root .env ` +
        `and therefore talks to PRODUCTION. Import { localDb } from "./_local-db.mjs" instead.`
    ).toEqual([]);
  });

  it("keeps the loopback check in the one module that owns it", () => {
    const guard = readFileSync(join(SCRIPTS, "_local-db.mjs"), "utf8");
    // Not a spelling test — these three are the substance of the guard. If the
    // host check or the throw is removed, every other test here goes quiet
    // while the scripts start reaching production again.
    expect(guard).toContain("127.0.0.1");
    expect(guard).toMatch(/throw new Error/);
    expect(guard).toMatch(/\.env\.local/);
  });

  it("shells out to a database in exactly one place", () => {
    // AUDIT harness-004. The rule above only forbids CONSTRUCTING a client, and
    // for months that read as complete coverage while six smoke scripts reached
    // the same database down a second road: `execSync("docker exec -i
    // founderflow-postgres psql …")`, issuing UPDATE and DELETE against User
    // rows. `localDatabaseUrl()`'s loopback assertion — the thing standing
    // between a script and someone's real data — was never consulted on that
    // path. Today the hardcoded container name is what pins those scripts to
    // local, so the guard's coverage is exactly as wide as a container name.
    //
    // The detector pairs the two facts a real invocation needs: the file
    // imports a child-process API, and it names a Postgres CLI. Naming a CLI
    // without shelling out is prose (scripts/qa-cron-and-background.mjs
    // describes pg_dump in its own failure messages); shelling out without
    // naming one is every other script in the directory.
    const offenders = scriptFiles().filter((file) => {
      if (MAY_SHELL_OUT_TO_SQL.has(file) || NOT_YET_ROUTED.has(file)) return false;
      const code = stripComments(readFileSync(join(SCRIPTS, file), "utf8"));
      return /node:child_process/.test(code) && POSTGRES_CLI.test(code);
    });

    expect(
      offenders,
      `These scripts reach a database by shelling out to a Postgres CLI, which ` +
        `bypasses _local-db.mjs entirely — no host check, no loopback proof. ` +
        `Import { psqlExec, psqlScalar } from "./_local-psql.mjs" instead.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("keeps the container pin and the loopback proof in the one module that owns it", () => {
    const guard = readFileSync(join(SCRIPTS, "_local-psql.mjs"), "utf8");

    // The container name is what actually decides which database psql talks to,
    // so it must be a literal in this file and must not be assembled from the
    // environment. This is the substance of the guard, not its spelling.
    expect(guard).toContain("founderflow-postgres");
    expect(guard).toMatch(/localDatabaseUrl/);

    // And nothing here may take a host, a port, a database name or a container
    // from the environment — that is precisely the widening this rule exists to
    // refuse. (PGHOST etc. are read by psql itself only when it connects over
    // the network, which `docker exec` never does.)
    const code = stripComments(guard);
    expect(code).not.toMatch(/process\.env\.PG/);
    expect(code).not.toMatch(/process\.env\.(?:DATABASE_URL|DIRECT_URL)/);
    expect(code).not.toMatch(/process\.env\[/);
  });

  it("still finds a Postgres CLI in the module that is allowed one", () => {
    // Guard-the-guard: the two assertions above are "the offender list is
    // empty" and "the owner module says the right things". Both pass perfectly
    // if the detector has stopped matching anything at all.
    const owner = stripComments(readFileSync(join(SCRIPTS, "_local-psql.mjs"), "utf8"));
    expect(POSTGRES_CLI.test(owner), "the Postgres-CLI detector matches nothing any more").toBe(
      true
    );
    expect(/node:child_process/.test(owner)).toBe(true);
  });

  it("every not-yet-routed script still shells out, so the list cannot go stale", () => {
    const stale: string[] = [];
    Array.from(NOT_YET_ROUTED.entries()).forEach(([file, reason]) => {
      let code = "";
      try {
        code = stripComments(readFileSync(join(SCRIPTS, file), "utf8"));
      } catch {
        stale.push(`${file} is gone (listed as: ${reason})`);
        return;
      }
      if (!(/node:child_process/.test(code) && POSTGRES_CLI.test(code))) {
        stale.push(`${file} no longer matches (listed as: ${reason})`);
      }
    });

    expect(
      stale,
      `Delete these from NOT_YET_ROUTED — an exemption that outlives its reason is ` +
        `how the next one gets waved through:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("routes every local database npm script through the wrapper", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    // Iterate the db:* family rather than naming the three that exist today.
    const local = Object.entries(pkg.scripts).filter(
      ([name]) => name.startsWith("db:") && name.endsWith(":local")
    );
    expect(local.length).toBeGreaterThan(0);

    for (const [name, command] of local) {
      // `db:up` / `db:down` / `db:nuke` are docker, not Prisma — they never
      // resolve a connection string, so they are exempt by construction.
      if (!/prisma|tsx/.test(command)) continue;
      expect(
        command,
        `"${name}" shells out to Prisma without scripts/db-local.mjs. The Prisma CLI ` +
          `reads the root .env (production), not .env.local, and this Prisma version has ` +
          `no --env-file flag — so this command would run against production.`
      ).toContain("db-local.mjs");
    }
  });
});
