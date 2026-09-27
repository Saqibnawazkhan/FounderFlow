/**
 * Structural guard: no local env file may hold a PRODUCTION database credential.
 *
 * THE INCIDENT THIS ENCODES (prodready-001, 2026-09-26). The root `.env` held
 * the live Supabase `DATABASE_URL` / `DIRECT_URL` — password and all, with the
 * password additionally spelled out in cleartext in a comment above it. That
 * file is gitignored, so it never reached git history, and it was therefore
 * easy to treat as harmless. It was not harmless: `.env` is the file the
 * Prisma CLI and every bare `new PrismaClient()` resolve BY DEFAULT.
 * `.env.local` — which Next.js prefers, and which points at the docker
 * Postgres on 127.0.0.1:5433 — is a Next.js convention that Prisma knows
 * nothing about. That asymmetry is the whole mechanism behind the earlier
 * near-miss where `npm run db:reset:local` would have dropped the production
 * schema with no prompt.
 *
 * `tests/lib/db/script-safety.test.ts` guards the other half of the same
 * hazard: that no script constructs its own client. This file guards the
 * ammunition — if there is no production connection string on disk, a
 * mistake at the Prisma CLI fails closed with "Environment variable not
 * found" instead of connecting to live customer data.
 *
 * Scope, deliberately:
 *   • every `.env*` file in the tree, EXCEPT `*.example` templates (those are
 *     committed documentation and must stay readable);
 *   • `supabase.co` / `supabase.com` in any form — hosted Postgres means
 *     hosted data;
 *   • any postgres:// URL carrying a password whose host is not loopback.
 *
 * Rotation of the values that were exposed is tracked in SECRET-ROTATION.md.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();

/** Directories that never hold our env files but do hold thousands of files. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "dist",
  "build",
  ".vercel",
]);

/** Hosts that cannot be a hosted database: a mistake here hits only this box. */
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|0\.0\.0\.0|\[::1\]|::1)$/i;

/**
 * Find every env file that is NOT a committed `.example` template.
 * Walks the tree so an env file added in a subpackage is covered the day it
 * lands, rather than the day someone remembers to extend a hardcoded list.
 */
function envFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.name.startsWith(".env")) continue;
      if (entry.name.endsWith(".example")) continue;
      found.push(join(dir, entry.name));
    }
  };

  walk(root);
  return found;
}

/**
 * Every reason this file must not exist as-is, in plain language. Empty array
 * means clean. Returning reasons rather than a boolean is what makes a
 * failure message tell you which line to go delete.
 */
export function productionCredentialFindings(source: string): string[] {
  const findings: string[] = [];

  // NOTE ON STYLE: exec loops and numbered capture groups, not `matchAll` and
  // `(?<name>…)`. tsconfig.json sets no `target`, so tsc defaults to ES5,
  // where both of those are compile errors (TS2802 / TS1503). Not a
  // preference — `npm run typecheck` is part of the pre-push gate.

  // 1. Hosted Supabase, in a URL or a comment or a stray note. There is no
  //    such thing as a local supabase.co host, so any hit is a hosted project.
  const hosted = /[A-Za-z0-9_.-]*supabase\.com?\b/gi;
  let hit: RegExpExecArray | null;
  while ((hit = hosted.exec(source)) !== null) {
    findings.push(`references hosted Supabase: "${hit[0]}"`);
  }

  // 2. A postgres URL carrying a password, pointed at anything but loopback.
  //    Catches non-Supabase hosted Postgres (RDS, Neon, a staging box) too.
  //    Groups: 1 = user, 2 = password, 3 = host.
  const urls = /postgres(?:ql)?:\/\/([^\s:/@]+):([^\s@]+)@(\[[^\]\s]+\]|[^\s:/?]+)/gi;
  let url: RegExpExecArray | null;
  while ((url = urls.exec(source)) !== null) {
    const host = url[3] ?? "";
    if (LOOPBACK.test(host)) continue;
    findings.push(`postgres URL with a password on non-loopback host "${host}"`);
  }

  return findings;
}

describe("the detector itself (so a passing suite is never a vacuous one)", () => {
  /**
   * These two blocks model the `.env` as it actually was on 2026-09-26, with
   * fake refs and fake passwords. Keeping them here means the guard can still
   * be seen to fail on a clean tree, where `.env` is gitignored and may not
   * exist at all (CI, a fresh clone). Without this, the real-tree assertion
   * below would pass for the wrong reason.
   */
  const OLD_ENV_SHAPE = [
    "# Note: `@` in passwords MUST be URL-encoded as %40 — DB password is",
    '# "FakePw@2026" -> "FakePw%402026" in the URL.',
    'DATABASE_URL="postgresql://postgres.fakeprojectref:FakePw%402026@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"',
    'DIRECT_URL="postgresql://postgres.fakeprojectref:FakePw%402026@db.fakeprojectref.supabase.co:5432/postgres"',
  ].join("\n");

  const LOCAL_ENV_SHAPE = [
    'DATABASE_URL="postgresql://founderflow:founderflow_local@127.0.0.1:5433/founderflow?schema=public"',
    'DIRECT_URL="postgresql://founderflow:founderflow_local@localhost:5433/founderflow?schema=public"',
    'AUTH_SECRET="local-dev-secret"',
  ].join("\n");

  it("flags a hosted Supabase pooler URL", () => {
    const findings = productionCredentialFindings(OLD_ENV_SHAPE);
    expect(findings.join(" | ")).toMatch(/hosted Supabase/);
    expect(findings.join(" | ")).toMatch(/non-loopback host/);
  });

  it("passes a loopback-only local env file", () => {
    expect(productionCredentialFindings(LOCAL_ENV_SHAPE)).toEqual([]);
  });

  it("walks real directories and skips *.example templates", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-env-guard-"));
    writeFileSync(join(dir, ".env"), LOCAL_ENV_SHAPE);
    writeFileSync(join(dir, ".env.example"), OLD_ENV_SHAPE);
    writeFileSync(join(dir, "notes.txt"), OLD_ENV_SHAPE);

    // Only `.env`: the template and the non-env file are out of scope.
    expect(envFiles(dir).map((p) => p.slice(dir.length + 1))).toEqual([".env"]);
  });
});

describe("no production credentials in any local env file", () => {
  const files = envFiles(REPO_ROOT);

  it("scans the repo root, where Prisma and Next resolve env files", () => {
    // Not a count assertion — `.env*` is gitignored, so a fresh clone
    // legitimately has none. This pins the scanner to the right tree.
    expect(REPO_ROOT).toMatch(/[\\/]/);
    expect(() => envFiles(REPO_ROOT)).not.toThrow();
  });

  // `.env.staging` is handled separately, below. It is the ONE local env file
  // that must legitimately name a hosted database, and the reason is the same
  // reason this whole test exists: the hazard is AUTO-LOADING. Prisma auto-loads
  // the root `.env`; Next auto-loads `.env.local`. NOTHING auto-loads
  // `.env.staging` — only scripts/db-staging.mjs reads it, explicitly, after
  // proving the file declares itself staging. So a hosted URL there cannot be
  // picked up by a stray `npx prisma`, which is the accident this guards.
  //
  // Added 2026-09-28, when staging was finally provisioned and this test went
  // red for the right rule and the wrong reason. Narrowing it was the fix;
  // deleting the assertion would not have been.
  const STAGING = join(REPO_ROOT, ".env.staging");
  const generalFiles = files.filter((f) => f !== STAGING);

  it.each(generalFiles.length ? generalFiles : [["<no env files on disk>"]].flat())(
    "%s holds no production credential",
    (file) => {
      if (file === "<no env files on disk>") return;

      const findings = productionCredentialFindings(readFileSync(file, "utf8"));

      expect(
        findings,
        `${file} contains a production credential.\n` +
          findings.map((f) => `  • ${f}`).join("\n") +
          `\n\nWhy this matters: the Prisma CLI and a bare new PrismaClient() auto-load ` +
          `the ROOT .env — NOT .env.local, which is a Next.js convention. A hosted ` +
          `connection string here means "prisma migrate reset" can drop a live schema.\n` +
          `Fix: move the value into Vercel's env-var UI, keep only loopback URLs on ` +
          `disk, and follow SECRET-ROTATION.md to rotate what was exposed.`
      ).toEqual([]);
    }
  );

  it("keeps .env itself inert rather than merely tidy", () => {
    const dotEnv = join(REPO_ROOT, ".env");
    let source: string;
    try {
      source = readFileSync(dotEnv, "utf8");
    } catch {
      return; // No `.env` at all is the safest possible state.
    }

    // Anything assigned a non-empty value in `.env` is a value Prisma will
    // resolve. The file is allowed to exist as a signpost; it is not allowed
    // to carry connection or secret material.
    const assignment = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/gm;
    const assigned: string[] = [];
    let line: RegExpExecArray | null;
    while ((line = assignment.exec(source)) !== null) {
      const value = (line[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) assigned.push(line[1]);
    }

    expect(
      assigned,
      `.env should assign nothing. Prisma reads this file by default, so every ` +
        `value here is a value a stray "npx prisma" command will connect with. ` +
        `Local values belong in .env.local; production values belong in Vercel.`
    ).toEqual([]);
  });
});

/**
 * `.env.staging` is exempt from the hosted-host rule, so these assertions are
 * what make the exemption safe. Three conditions, each closing one way the
 * exemption could become the very leak this file exists to prevent.
 */
describe(".env.staging may name a hosted database, but only on these terms", () => {
  const STAGING_PATH = join(REPO_ROOT, ".env.staging");
  const exists = (() => {
    try {
      return statSync(STAGING_PATH).isFile();
    } catch {
      return false;
    }
  })();

  /** Hostnames any postgres URL in a file names. */
  const hostsIn = (text: string): string[] => {
    const out: string[] = [];
    const rx = /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]+@(\[[^\]\s]+\]|[^\s:/?]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const h = (m[1] ?? "").toLowerCase();
      if (h && out.indexOf(h) === -1) out.push(h);
    }
    return out;
  };

  it("declares FF_ENV=staging, which is what earns it the exemption", () => {
    if (!exists) return; // not provisioned on this machine; nothing to exempt
    const text = readFileSync(STAGING_PATH, "utf8");
    expect(
      /^[ 	]*FF_ENV[ 	]*=[ 	]*["']?staging["']?[ 	]*$/m.test(text),
      '.env.staging names a hosted database but does not declare FF_ENV="staging". ' +
        "That declaration is the only thing separating it from a production env file — " +
        "staging and production are both *.pooler.supabase.com on the same ports, so " +
        "nothing about the URL can tell them apart. See scripts/_staging-db.mjs."
    ).toBe(true);
  });

  it("names no host that .env or .env.local also names", () => {
    if (!exists) return;
    const stagingHosts = hostsIn(readFileSync(STAGING_PATH, "utf8"));
    for (const sibling of [".env", ".env.local"]) {
      let text = "";
      try {
        text = readFileSync(join(REPO_ROOT, sibling), "utf8");
      } catch {
        continue;
      }
      const shared = hostsIn(text).filter((h) => stagingHosts.indexOf(h) !== -1);
      expect(
        shared,
        `.env.staging and ${sibling} both name ${shared.join(", ")}. Whatever FF_ENV ` +
          "says, that is not a separate database — the point of staging is that a " +
          "migration tried there cannot touch anything real."
      ).toEqual([]);
    }
  });

  it("is gitignored, so the exemption cannot become a committed credential", () => {
    if (!exists) return;
    let ignored: boolean;
    try {
      execFileSync("git", ["check-ignore", "-q", ".env.staging"], { cwd: REPO_ROOT });
      ignored = true;
    } catch (err) {
      // `git check-ignore -q` exits 1 for "not ignored" and 128 if git is
      // unavailable. Only the first is a failure of this assertion.
      const status = (err as { status?: number }).status;
      if (status === 1) ignored = false;
      else return; // no git here; this assertion cannot be evaluated
    }
    expect(
      ignored,
      ".env.staging is NOT gitignored. It holds a live database password, and the " +
        "hosted-host exemption above assumes the file never leaves this machine."
    ).toBe(true);
  });
});
