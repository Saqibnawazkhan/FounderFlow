/**
 * sec-011, the durable half: the storage contract for the login throttle's
 * per-account failure budget.
 *
 * WHAT THIS FILE IS FOR. `20260928000100_add_failed_login_counter` added
 * `User.failedLoginCount` and `User.failedLoginWindowStartedAt` so the
 * per-account failure budget could survive a cold start and be shared between
 * concurrent lambdas without adding Redis. The columns landed. Nothing ever
 * read or wrote them. That migration runs at build time on the next production
 * deploy, so two unused columns are queued for a live customer database, and a
 * column named `failedLoginCount` reads to the next person who greps for
 * brute-force defence as a control that exists.
 *
 * A security column with no reader is the same defect as a comment that
 * overstates a safety mechanism — this repo's most recurrent failure, and the
 * reason `.env` emptiness and the staging guard are both enforced by a test
 * rather than remembered. So this file enforces the contract instead of
 * asserting it in prose:
 *
 *   1. every `failedLogin*` field on `User` is read or written by product code;
 *   2. the per-account failure budget refuses a CORRECT password while it is
 *      spent (so making it durable is a denial-of-service decision, not a
 *      storage decision), and
 *   3. it self-heals on a sliding window with no operator — which is the only
 *      reason (1) may honestly be resolved by deleting the columns.
 *
 * (1) is currently RED. It is satisfied by either resolution: delete the two
 * columns, or give them a reader in `lib/`, `app/` or `components/`. It must
 * not be satisfied by a third option — writing them and never reading them.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { gateLoginAttempt, recordLoginFailure } from "@/lib/auth/login-throttle";

const ROOT = process.cwd();

/**
 * Where a reader may live. `tests/` and `scripts/` are absent on purpose: a
 * test that exercises a column no product code touches is exactly the state
 * sec-011 is in, and crediting it would make this file agree with the bug.
 * `prisma/` is absent for the same reason — the seed writes data, it is not a
 * consumer of a security control.
 */
const PRODUCT_ROOTS = ["lib", "app", "components"];

/** These mirror lib/rate-limit.ts `limiters.credentialsEmail`. */
const EMAIL_FAILURE_LIMIT = 10;
const EMAIL_WINDOW_MS = 15 * 60_000;

/**
 * Blank out comment bodies, preserving length so nothing else shifts.
 *
 * THIS IS THE LOAD-BEARING PART OF THE SCAN, and without it this file passes
 * while proving nothing. Both `lib/auth/login-throttle.ts` and
 * `lib/rate-limit.ts` name `failedLoginCount` in their follow-up comments —
 * they are where the columns were proposed. A scan that counts comments finds
 * two "readers" in `lib/` and reports the control as wired.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      // Strings are kept: a Prisma `select` uses bare identifiers, but a raw
      // query would name the column inside a string and that IS a real read.
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // inside a string literal
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (
      (mode === "single" && c === "'") ||
      (mode === "double" && c === '"') ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    i += 1;
  }
  return out.join("");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, acc);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function rel(abs: string): string {
  return abs
    .slice(ROOT.length + 1)
    .split(sep)
    .join("/");
}

/**
 * Which of `declared` no source in `sources` reads or writes.
 *
 * Pure, and taking file CONTENTS rather than paths, purely so the fixtures at
 * the bottom of this file can drive it. The assertion over the real tree can
 * only ever report a list, and a detector that always returns everything looks
 * identical to a correctly-failing one — see the same note in
 * tests/lib/actions/reachability.test.ts.
 */
function findOrphans(declared: string[], sources: Array<{ path: string; src: string }>): string[] {
  return declared.filter((name) =>
    sources.every(({ src }) => stripComments(src).indexOf(name) === -1)
  );
}

/**
 * The `failedLogin*` field names declared on `User` in the Prisma schema.
 *
 * Read out of the schema rather than hard-coded, so renaming a column does not
 * quietly make this guard vacuous.
 */
function declaredFailedLoginFields(): string[] {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  const userBlock = /model\s+User\s*\{([\s\S]*?)\n\}/.exec(schema);
  if (!userBlock) throw new Error("could not locate `model User` in prisma/schema.prisma");
  const names: string[] = [];
  const field = /^\s*(failedLogin\w*)\s+/gm;
  let m: RegExpExecArray | null;
  // exec loop, not matchAll: tsconfig sets no `target`, so tsc defaults to ES5
  // and `for (const x of str.matchAll(...))` fails typecheck while passing here.
  while ((m = field.exec(userBlock[1])) !== null) names.push(m[1]);
  return names;
}

describe("sec-011 — the durable per-account counter has a reader, or does not exist", () => {
  it("every failedLogin* column on User is read or written by product code", () => {
    const declared = declaredFailedLoginFields();
    if (declared.length === 0) return; // resolved by deletion — nothing to wire.

    const files = PRODUCT_ROOTS.flatMap((r) => sourceFiles(join(ROOT, r)));
    expect(files.length).toBeGreaterThan(50); // the scan itself is not vacuous

    const sources = files.map((file) => ({
      path: rel(file),
      src: readFileSync(file, "utf8"),
    }));
    const orphans = findOrphans(declared, sources);
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `These User columns exist in prisma/schema.prisma and in the committed migration ` +
            `20260928000100_add_failed_login_counter, and NO code in lib/ app/ components/ ` +
            `reads or writes them: ${orphans.join(", ")}.\n\n` +
            `That migration runs at build time on the next production deploy, so this ships ` +
            `unused columns to a live customer database and leaves a column named ` +
            `failedLoginCount reading as a brute-force control that does not exist.\n\n` +
            `Resolve it one of two ways — NOT by writing the column without reading it:\n` +
            `  (a) drop the columns from prisma/schema.prisma and delete the migration ` +
            `(recommended: see the FOLLOW-UP note at the bottom of lib/auth/login-throttle.ts ` +
            `for why a durable per-ACCOUNT block is a lockout primitive), or\n` +
            `  (b) give them a reader on the login path, and accept the lockout that the ` +
            `second test in this file demonstrates.`
    ).toEqual([]);
  });
});

describe("sec-011 — why durability here is a lockout decision, not a storage decision", () => {
  beforeEach(() => {
    // rateLimiter() short-circuits to allowed:true when RATE_LIMIT_DISABLED is
    // "true". If that reached the test env every assertion below would go
    // vacuous while staying green. Pin it off rather than trusting the ambient
    // environment.
    vi.stubEnv("RATE_LIMIT_DISABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("a spent per-account failure budget refuses the owner's CORRECT password too", () => {
    // The whole argument for and against the durable counter, in one assertion.
    //
    // `gateLoginAttempt` runs BEFORE the lookup and before bcrypt — it has to,
    // because refusing an attempt after the compare would save no work and
    // limit no guesses. So it cannot know the password is right. Ten failures
    // an attacker can send for free therefore refuse the real owner as well.
    //
    // That is already true today and is a documented, accepted tradeoff
    // (lib/rate-limit.ts, `credentialsEmail`), and it is survivable ONLY
    // because the counter is per-instance and evaporates. Moving it onto the
    // User row does not change this shape; it makes it reliable, fleet-wide and
    // deploy-proof. Any change that makes this refusal durable is a decision
    // about denial of service, and must be argued as one.
    const email = "durable-lockout@example.com";

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      recordLoginFailure(email);
    }

    // A fresh address, so the per-IP bucket cannot be what refuses this.
    const verdict = gateLoginAttempt("198.51.100.240", email);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.scope).toBe("email");
  });

  it("and it self-heals on a sliding window with no operator", () => {
    // The property that makes the tradeoff above shippable, and the reason the
    // orphan columns may honestly be deleted rather than wired: the founder an
    // attacker locked out gets back in by waiting, not by emailing support.
    // There is no admin unlock in this product, so if this ever became a sticky
    // counter there would be no way out at all.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T09:00:00Z"));
    const email = "durable-selfheal@example.com";

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      recordLoginFailure(email);
    }
    expect(gateLoginAttempt("198.51.100.241", email).allowed).toBe(false);

    vi.advanceTimersByTime(EMAIL_WINDOW_MS + 1_000);

    // Fresh address again: the per-IP minute is irrelevant to what is being
    // pinned, and reusing one would let the IP bucket answer for the email one.
    expect(gateLoginAttempt("198.51.100.242", email).allowed).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* the detector, driven over synthetic sources                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("findOrphans (the guard above is only as good as this)", () => {
  // The assertion over the real tree reports a list, so a detector that
  // returned every field unconditionally would look exactly like the genuine
  // failure it currently reports. These fixtures are what separate the two, and
  // in particular they prove the guard GOES GREEN when the columns are deleted
  // rather than being permanently red.
  const FIELDS = ["failedLoginCount", "failedLoginWindowStartedAt"];

  it("reports nothing when there are no fields left to wire (the recommended resolution)", () => {
    expect(findOrphans([], [{ path: "lib/auth.ts", src: "export const x = 1;" }])).toEqual([]);
  });

  it("clears a field that real code selects", () => {
    const src = `const u = await db.user.findFirst({
      select: { failedLoginCount: true, failedLoginWindowStartedAt: true },
    });`;
    expect(findOrphans(FIELDS, [{ path: "lib/auth.ts", src }])).toEqual([]);
  });

  it("does NOT clear a field that is only named in a comment", () => {
    // Trap 1, and the one that would have made this whole file vacuous:
    // lib/auth/login-throttle.ts and lib/rate-limit.ts are both in `lib/` and
    // both name failedLoginCount in prose, because they are where the columns
    // were proposed and then rejected. Counting comments finds two readers.
    const line = `// TODO: read failedLoginCount and failedLoginWindowStartedAt here\n`;
    const block = `/**\n * failedLoginCount + failedLoginWindowStartedAt, which the\n * migration adds.\n */\n`;
    expect(findOrphans(FIELDS, [{ path: "lib/rate-limit.ts", src: line + block }])).toEqual(FIELDS);
  });

  it("still sees a field named inside a string, e.g. a raw query", () => {
    // Strings are deliberately NOT stripped: `$queryRaw` naming the column is a
    // real read, and treating it as prose would report a wired column as an
    // orphan and push someone into deleting a live one.
    const src = 'await db.$executeRaw(`UPDATE "User" SET "failedLoginCount" = 0`);';
    expect(findOrphans(["failedLoginCount"], [{ path: "lib/auth.ts", src }])).toEqual([]);
  });

  it("reports one orphan while its sibling is wired, rather than all-or-nothing", () => {
    const src = "data: { failedLoginCount: { increment: 1 } },";
    expect(findOrphans(FIELDS, [{ path: "lib/auth.ts", src }])).toEqual([
      "failedLoginWindowStartedAt",
    ]);
  });
});
