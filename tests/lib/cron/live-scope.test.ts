/**
 * cron-010, the structural half: the rule about tombstoned workspaces must be
 * inherited by the NEXT background job, not remembered.
 *
 * Two nightly jobs write to customer rows. The materializer filtered on
 * `company: { deletedAt: null }` and carried the reasoning in a comment; the
 * time sweep had no filter at all and spent the full 90-day recovery window
 * rewriting deleted workspaces' timesheets. One rule, stated in one of the two
 * places that needed it, is how the third job gets it wrong — so the rule now
 * lives in `lib/cron/live-scope.ts` and this file fails if a job stops using it.
 *
 * WHY SOURCE TEXT. These are Next.js route handlers and a plain cron body; a
 * route file cannot export a constant for a test to read, and driving the whole
 * handler proves nothing about the OTHER handler that will be added next month.
 * `tests/lib/db/purge-invariants.test.ts` and `tests/security/script-safety`
 * establish this shape in this repo. The behavioural half — that the filter
 * really changes which rows are touched — is
 * `tests/lib/time/sweep-live-scope.test.ts`, which drives the real function
 * against a fake that honours `where`.
 *
 * THE EXEMPTION IS NAMED, NOT ABSENT. `purge-soft-deleted` exists to erase
 * tombstoned workspaces, so the filter would make it a no-op. It is listed below
 * with that reason, which is the same discipline as `PURGE_EXCLUDED`: a
 * deliberate exclusion has to be written down to be told apart from an
 * oversight.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const CRON_DIR = join(ROOT, "app", "api", "cron");

/**
 * Cron routes that must NOT carry the live-workspace scope, and why.
 *
 * Keyed by directory name under app/api/cron. An entry here is a claim that the
 * job's whole purpose is tombstoned data.
 */
const EXEMPT: Record<string, string> = {
  "purge-soft-deleted":
    "It exists to erase tombstoned workspaces. Filtering them out makes it a no-op.",
};

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

/** Every file reachable from a cron route directory, including its imports' bodies. */
function cronRoutes(): Array<{ slug: string; src: string }> {
  return readdirSync(CRON_DIR)
    .filter((entry) => statSync(join(CRON_DIR, entry)).isDirectory())
    .map((slug) => ({
      slug,
      src: readFileSync(join(CRON_DIR, slug, "route.ts"), "utf8"),
    }));
}

/**
 * Every .ts file under lib/, so a job whose body was moved out of the route (as
 * the time sweep's was, to keep it off the Server Action graph — cron-001) is
 * still checked.
 */
function libSources(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.charAt(0) === ".") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry)) continue;
      out.push({
        path: relative(ROOT, full).split(sep).join("/"),
        src: readFileSync(full, "utf8"),
      });
    }
  };
  walk(join(ROOT, "lib"));
  return out;
}

const SCOPE_NAMES = /\bLIVE_(?:WORKSPACE|ROW_AND_WORKSPACE)_SCOPE\b/;

describe("the live-workspace rule is stated once", () => {
  it("indexes the cron routes at all — guard the guard", () => {
    // Without this, a path change turns every assertion below into a loop over
    // an empty array and the file goes green while checking nothing. That is the
    // exact defect class this repo keeps producing.
    const routes = cronRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes.map((r) => r.slug)).toContain("purge-soft-deleted");
    expect(libSources().length).toBeGreaterThan(50);
  });

  it("every exemption names a real cron route", () => {
    // An exemption for a job that no longer exists is a stale excuse, and it
    // would silently widen the allowance if that slug were ever reused.
    const slugs = cronRoutes().map((r) => r.slug);
    for (const slug of Object.keys(EXEMPT)) {
      expect(slugs, `EXEMPT names "${slug}", which is not a cron route`).toContain(slug);
      expect(EXEMPT[slug].length).toBeGreaterThan(20);
    }
  });

  it("no cron route hardcodes the filter instead of importing the rule", () => {
    // The literal is what the two jobs had before: one of them. A job that
    // writes its own copy cannot be found by the next person who changes the
    // rule, which is how the sweep ended up without it.
    for (const { slug, src } of cronRoutes()) {
      if (EXEMPT[slug]) continue;
      const code = codeOnly(src);
      if (!/company:\s*\{\s*deletedAt:\s*null\s*\}/.test(code)) continue;
      expect(
        SCOPE_NAMES.test(code),
        `app/api/cron/${slug}/route.ts writes { company: { deletedAt: null } } by hand. ` +
          `Import LIVE_WORKSPACE_SCOPE from @/lib/cron/live-scope instead, so the next ` +
          `job inherits the rule rather than needing to remember it.`
      ).toBe(true);
    }
  });

  it("the auto-close sweep uses the rule, with the row tombstone included", () => {
    // Named specifically because it is the job cron-010 was filed about, and
    // because TimeEntry is soft-deletable: the workspace-only scope would still
    // let the sweep rewrite an individually deleted entry.
    const sweep = codeOnly(readFileSync(join(ROOT, "lib", "time", "sweep.ts"), "utf8"));
    expect(sweep).toMatch(/LIVE_ROW_AND_WORKSPACE_SCOPE/);
  });

  it("the materializer uses the rule too — it is where the reasoning came from", () => {
    const route = codeOnly(
      readFileSync(join(CRON_DIR, "materialize-recurring", "route.ts"), "utf8")
    );
    expect(route).toMatch(SCOPE_NAMES);
  });

  it("the purge deliberately does NOT use it", () => {
    // The other direction. If a future edit "tidied" the purge into using the
    // shared scope, it would stop erasing anything at all and nothing else in
    // the suite would notice — the job would just report zero rows every night.
    const purge = codeOnly(readFileSync(join(CRON_DIR, "purge-soft-deleted", "route.ts"), "utf8"));
    expect(SCOPE_NAMES.test(purge)).toBe(false);
  });
});
