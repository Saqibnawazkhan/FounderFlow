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

const SCRIPTS = join(process.cwd(), "scripts");

/**
 * `_local-db.mjs` is the ONE place allowed to construct a client: it reads
 * `.env.local`, proves the host is loopback, and throws otherwise. Everything
 * else goes through it. This list is an allow-list of exactly one on purpose —
 * if it ever needs a second entry, that is the moment to ask why.
 */
const MAY_CONSTRUCT_A_CLIENT = new Set(["_local-db.mjs"]);

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"));
}

/** Strip comments so a file that *mentions* the hazard isn't reported as one. */
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

describe("scripts/ database safety (the production-wipe guard)", () => {
  it("has scripts to check at all", () => {
    // Without this, every assertion below passes vacuously the day someone
    // renames the directory.
    expect(scriptFiles().length).toBeGreaterThan(5);
  });

  it("builds a Prisma client in exactly one place, and that place checks the host", () => {
    const offenders = scriptFiles().filter((file) => {
      if (MAY_CONSTRUCT_A_CLIENT.has(file)) return false;
      return /new\s+PrismaClient\s*\(/.test(codeOnly(readFileSync(join(SCRIPTS, file), "utf8")));
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
