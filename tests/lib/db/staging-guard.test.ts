import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The guard lives in a .mjs module so the Prisma CLI wrapper can import it
// without a build step; TS resolves it through allowJs.
import { decideStagingUrls } from "../../../scripts/_staging-db.mjs";

/**
 * `db:migrate:staging` was a bare `prisma migrate deploy` until 2026-09-26.
 * The Prisma CLI resolves DATABASE_URL from the root `.env`, which held the
 * PRODUCTION credentials — so a command named after an environment that has
 * never existed applied migrations straight to production. CLAUDE.md
 * simultaneously claimed scripts/db-local.mjs wrapped "every `db:*` npm
 * script"; it did not wrap this one.
 *
 * Two things are asserted here. First that the guard refuses every way this can
 * go wrong (against the REAL decision function — a test that reimplements the
 * rule proves only that the copy agrees with itself). Second, structurally,
 * that no future `db:*` script can go unwrapped, which is the class rather than
 * the instance.
 */

const ROOT = join(__dirname, "..", "..", "..");

const GOOD = {
  FF_ENV: "staging",
  DATABASE_URL:
    "postgresql://postgres.stagingref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
  DIRECT_URL: "postgresql://postgres:pw@db.stagingref.supabase.co:5432/postgres",
};

// The production host, as the root `.env` used to name it. Nothing about a
// URL's SHAPE distinguishes it from the staging one above — same provider,
// same port, same pooler domain — which is exactly why the guard cannot work
// by pattern-matching and needs the FF_ENV declaration plus this comparison.
const PROD_HOSTS = ["aws-1-ap-southeast-1.pooler.supabase.com"];

describe("staging guard — the happy path", () => {
  it("accepts a fully declared, fully filled staging env", () => {
    const out = decideStagingUrls(GOOD, PROD_HOSTS);
    expect(out.databaseUrl).toBe(GOOD.DATABASE_URL);
    expect(out.directUrl).toBe(GOOD.DIRECT_URL);
    expect(out.host).toBe("aws-0-ap-southeast-1.pooler.supabase.com");
  });

  it("does not confuse DIRECT_URL with DATABASE_URL", () => {
    // Locally these are the same container, so aliasing them looks harmless.
    // Against a real Supabase project it is not: DATABASE_URL is the pgbouncer
    // pooler, which cannot speak the migration protocol at all.
    const out = decideStagingUrls(GOOD, PROD_HOSTS);
    expect(out.directUrl).not.toBe(out.databaseUrl);
    expect(out.directUrl).toContain(":5432");
    expect(out.databaseUrl).toContain(":6543");
  });
});

describe("staging guard — every way this can go wrong", () => {
  it("refuses when .env.staging is absent, and never falls back to .env", () => {
    expect(() => decideStagingUrls(null, PROD_HOSTS)).toThrow(/no \.env\.staging/i);
    // The wording matters: the old failure mode was a SILENT fallback, so the
    // message has to say that not falling back is deliberate.
    expect(() => decideStagingUrls(null, PROD_HOSTS)).toThrow(/NOT falling back/i);
  });

  it("refuses when nobody declared FF_ENV=staging", () => {
    const { FF_ENV, ...noDeclaration } = GOOD;
    expect(() => decideStagingUrls(noDeclaration, PROD_HOSTS)).toThrow(/FF_ENV/);
  });

  it('refuses a declaration that is not exactly "staging"', () => {
    for (const value of ["production", "prod", "Staging", "STAGING", "", "true"]) {
      expect(() => decideStagingUrls({ ...GOOD, FF_ENV: value }, PROD_HOSTS)).toThrow(/FF_ENV/);
    }
  });

  it("refuses an unfilled placeholder left over from the example file", () => {
    // .env.staging.example ships `<staging-ref>` and `<password>`. Copying it
    // and filling in only one of the two URLs is the likeliest mistake.
    expect(() =>
      decideStagingUrls(
        {
          ...GOOD,
          DIRECT_URL: "postgresql://postgres:<password>@db.<staging-ref>.supabase.co:5432/postgres",
        },
        PROD_HOSTS
      )
    ).toThrow(/placeholder/i);
  });

  it("refuses a missing URL", () => {
    for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
      const partial: Record<string, string> = { ...GOOD };
      delete partial[key];
      expect(() => decideStagingUrls(partial, PROD_HOSTS)).toThrow(new RegExp(`no ${key}`));
    }
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => decideStagingUrls({ ...GOOD, DATABASE_URL: "not a url" }, PROD_HOSTS)).toThrow(
      /not a valid URL/i
    );
  });

  // THE ONE THAT MATTERS. A truthful-looking declaration plus the production
  // connection string is the accident this whole file exists to stop, and it is
  // the only case the FF_ENV check alone cannot catch.
  it("refuses a host the root .env also names, however it is declared", () => {
    const lying = {
      ...GOOD,
      DATABASE_URL: `postgresql://postgres.prodref:pw@${PROD_HOSTS[0]}:6543/postgres`,
    };
    expect(() => decideStagingUrls(lying, PROD_HOSTS)).toThrow(
      /That is production, whatever FF_ENV says/
    );
  });

  it("catches production pasted into DIRECT_URL only", () => {
    // The asymmetric case: migrations run through DIRECT_URL, so this is the
    // half that would actually have written to production.
    const lying = {
      ...GOOD,
      DIRECT_URL: `postgresql://postgres:pw@${PROD_HOSTS[0]}:5432/postgres`,
    };
    expect(() => decideStagingUrls(lying, PROD_HOSTS)).toThrow(/DIRECT_URL/);
  });

  it("is not fooled into passing when the root .env names nothing", () => {
    // `.env` is value-free today, so prodHosts is empty and the comparison is
    // vacuous. That must not be mistaken for safety: the FF_ENV declaration is
    // still required, and this asserts the guard does not soften without it.
    const { FF_ENV, ...noDeclaration } = GOOD;
    expect(() => decideStagingUrls(noDeclaration, [])).toThrow(/FF_ENV/);
  });
});

describe("no db:* script may reach a database unwrapped", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  // Docker lifecycle scripts touch a container, never a connection string.
  const CONTAINER_ONLY = ["db:up", "db:down", "db:nuke"];

  it("routes every data-touching db:* script through a guard wrapper", () => {
    const unwrapped: string[] = [];
    for (const name of Object.keys(pkg.scripts)) {
      if (!name.startsWith("db:")) continue;
      if (CONTAINER_ONLY.indexOf(name) !== -1) continue;
      const body = pkg.scripts[name];
      const guarded =
        body.includes("scripts/db-local.mjs") || body.includes("scripts/db-staging.mjs");
      if (!guarded) unwrapped.push(`${name} -> ${body}`);
    }
    expect(
      unwrapped,
      "a db:* script that shells out to prisma directly resolves DATABASE_URL from the root " +
        ".env, which is how db:migrate:staging came to apply migrations to production. Route it " +
        "through scripts/db-local.mjs or scripts/db-staging.mjs."
    ).toEqual([]);
  });

  it("knows about every db:* script, so a new one cannot be silently exempt", () => {
    // Guards the allow-list itself: if someone adds db:something that only
    // touches docker, they must say so here rather than the sweep above
    // quietly skipping it.
    const known = [
      ...CONTAINER_ONLY,
      "db:migrate:local",
      "db:seed:local",
      "db:reset:local",
      "db:migrate:staging",
    ];
    const actual = Object.keys(pkg.scripts).filter((n) => n.startsWith("db:"));
    expect(actual.slice().sort()).toEqual(known.slice().sort());
  });
});
