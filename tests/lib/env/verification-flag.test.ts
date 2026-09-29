/**
 * auth-018 — `EMAIL_VERIFICATION_REQUIRED` is parsed and read by nothing.
 *
 * THE MEASUREMENT. The name is declared in `lib/env.ts`'s zod schema, threaded
 * into the parse, and exported on `env` as a boolean. A sweep of `app/`,
 * `components/` and `lib/` for a code reference to it returns zero hits (the
 * sweep is the last describe block below, and it keeps returning zero or this
 * file fails). `prisma/schema.prisma:92` and `FaultsAudit.md:88` both call it
 * "reserved for a future hard gate", and `CODEBASE-AUDIT.md:189` records a prior
 * audit deciding to keep the name rather than create a dangling reference. So it
 * is not an oversight — but none of those three files is the one an operator
 * reads when they set an environment variable, and the one they do read, the
 * schema in `lib/env.ts`, presented a live-looking boolean.
 *
 * WHY THIS IS NOT WIRED HERE, which is the substance of the finding. A hard gate
 * is a product decision with a customer-visible blast radius, not a bug fix:
 * nothing in this app has ever read `User.emailVerifiedAt` as a permission, so
 * every existing account that has not clicked its link is unverified, and
 * enforcing the flag locks all of them out on the next deploy with no migration
 * and no grace period. It is also not implementable from this file set — the
 * decision would have to live in `authorize()` and in the token claims
 * (`lib/auth.ts`), which belong to another agent in this wave.
 *
 * WHAT IS FIXED INSTEAD: the flag can no longer be set and believed. Setting it
 * to "true" now refuses the boot — and on Vercel that means the BUILD fails and
 * the previous deployment keeps serving, the same fail-closed posture the rest of
 * the env layer uses — with a message that names what does not exist. `false` and
 * unset are unchanged, so nobody's dev loop or deploy moves.
 *
 * The end state the brief asked for is "not a flag that looks like it works".
 * A flag that stops the boot and explains itself is the honest version of a
 * reservation; a silent one is the shape of defect this repo has paid for twice.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** Run `fn` with EMAIL_VERIFICATION_REQUIRED set to `value` and a fresh module graph. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.EMAIL_VERIFICATION_REQUIRED;
  if (value === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
  else process.env.EMAIL_VERIFICATION_REQUIRED = value;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
    else process.env.EMAIL_VERIFICATION_REQUIRED = previous;
    vi.resetModules();
  }
}

type Outcome = { threw: boolean; message: string; value: boolean | undefined };

async function loadEnv(value: string | undefined): Promise<Outcome> {
  // lib/env.ts console.errors before it throws, by design. Silence it so a
  // deliberate failure does not read as a broken suite.
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return await withFlag(value, async () => {
      try {
        const mod = await import("@/lib/env");
        return { threw: false, message: "", value: mod.env.EMAIL_VERIFICATION_REQUIRED };
      } catch (e) {
        return {
          threw: true,
          message: e instanceof Error ? e.message : String(e),
          value: undefined,
        };
      }
    });
  } finally {
    quiet.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── the operator who sets it and believes it ────────────────────────────── */

describe("auth-018 — EMAIL_VERIFICATION_REQUIRED cannot be set and believed", () => {
  it("refuses to boot when the flag is turned on", async () => {
    const outcome = await loadEnv("true");
    expect(
      outcome.threw,
      "setting EMAIL_VERIFICATION_REQUIRED=true booted normally and reported " +
        `EMAIL_VERIFICATION_REQUIRED=${String(outcome.value)}. Nothing in this app reads ` +
        "User.emailVerifiedAt as a permission, so the operator who set it now believes " +
        "unverified accounts are blocked and they are not — a false security belief on a " +
        "finance app, which is worse than the feature simply being absent"
    ).toBe(true);
  });

  it("says what is missing, not just that something is wrong", async () => {
    const outcome = await loadEnv("true");
    expect(outcome.message).toContain("EMAIL_VERIFICATION_REQUIRED");
    expect(
      outcome.message.toLowerCase().indexOf("emailverifiedat"),
      "the refusal has to name the thing that does not exist, or the operator's next move " +
        "is to grep for a bug that is not there"
    ).toBeGreaterThan(-1);
  });

  it("leaves the shipped soft gate alone — unset boots and blocks nobody", async () => {
    const outcome = await loadEnv(undefined);
    expect(
      outcome.threw,
      `unset EMAIL_VERIFICATION_REQUIRED failed to boot: ${outcome.message}`
    ).toBe(false);
    expect(outcome.value).toBe(false);
  });

  it('accepts an explicit "false" — the value the flag has always effectively had', async () => {
    const outcome = await loadEnv("false");
    expect(
      outcome.threw,
      `EMAIL_VERIFICATION_REQUIRED=false failed to boot: ${outcome.message}`
    ).toBe(false);
    expect(outcome.value).toBe(false);
  });
});

/* ── the pure decision, in the house style of productionAppUrlProblem ────── */

describe("emailVerificationFlagProblem", () => {
  async function problem(raw: string | undefined): Promise<string | null> {
    const mod = await import("@/lib/env");
    return mod.emailVerificationFlagProblem(raw);
  }

  it("objects to the on position and nothing else", async () => {
    expect(await problem("true")).not.toBeNull();
    expect(await problem("false")).toBeNull();
    expect(await problem(undefined)).toBeNull();
    expect(await problem("")).toBeNull();
    // Whitespace around a value pasted out of a dashboard still means "on".
    expect(await problem("  true ")).not.toBeNull();
  });

  it("tells the operator the cost of the thing they asked for", async () => {
    const message = (await problem("true")) ?? "";
    expect(message.toLowerCase()).toContain("lock");
  });
});

/* ── the guard expires itself the moment the gate is real ─────────────────── */

describe("auth-018 — the refusal lasts exactly as long as the flag is dead", () => {
  /**
   * The hazard with "refuse the flag" as a fix is that it outlives its reason:
   * somebody implements the gate and the refusal then blocks the feature it was
   * protecting people from believing in. So the two are tied together
   * mechanically — the same self-expiring design as the `NOT_YET_CONVERTED` map
   * in tests/lib/layout/rtl.test.ts and the raw-reader ceiling in
   * tests/lib/env/app-origin-call-sites.test.ts.
   *
   * A "reader" is a code reference — `env.EMAIL_VERIFICATION_REQUIRED` or
   * `process.env.EMAIL_VERIFICATION_REQUIRED` — under app/, components/ or lib/,
   * excluding lib/env.ts itself. Prose that merely names the flag does not count,
   * which is why the pattern requires the `env.` prefix.
   */
  const REFUSAL = "emailVerificationFlagProblem";
  const READER = /(?:process\.)?env\.EMAIL_VERIFICATION_REQUIRED/;

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, out);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return;
  }

  function readers(): string[] {
    const files: string[] = [];
    for (const top of ["app", "components", "lib"]) walk(join(ROOT, top), files);
    const envModule = join(ROOT, "lib", "env.ts");
    const hits: string[] = [];
    for (const file of files) {
      if (file === envModule) continue;
      if (READER.test(readFileSync(file, "utf8"))) hits.push(file.slice(ROOT.length + 1));
    }
    return hits;
  }

  it("still has zero readers, so the refusal must be in place", () => {
    const hits = readers();
    const refusalPresent = source("lib/env.ts").indexOf(REFUSAL) > -1;
    if (hits.length === 0) {
      expect(
        refusalPresent,
        "EMAIL_VERIFICATION_REQUIRED has no readers and lib/env.ts no longer refuses it, so " +
          "it is back to being a switch an operator can set, believe, and get nothing from"
      ).toBe(true);
    } else {
      expect(
        refusalPresent,
        `EMAIL_VERIFICATION_REQUIRED is now read by ${hits.join(", ")} — the gate exists, so ` +
          "the refusal in lib/env.ts is blocking the feature it was protecting people from " +
          "believing in. Delete emailVerificationFlagProblem and its call, and delete this " +
          "branch with it"
      ).toBe(false);
    }
  });
});
