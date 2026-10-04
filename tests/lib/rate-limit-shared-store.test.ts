/**
 * sec-011 / prodready-013 — the SHARED-STORE gap, and the three claims the
 * codebase makes about it.
 *
 * WHAT THIS FILE IS NOT. It does not fix the gap. Every bucket in
 * `lib/rate-limit.ts` is a `Map` on `globalThis`, so on N warm lambdas the
 * advertised 5/min is 5×N and a cold start resets it to zero. Closing that
 * needs a provisioned shared store (an Upstash/KV instance plus credentials in
 * the Production scope — nothing in this repo can create one) and an async
 * refactor of every call site. It is recorded as FaultsAudit A37, owner-blocked.
 *
 * WHAT IT IS FOR. While a security gap stays open, the only thing standing
 * between it and the next person is the prose that describes it — and this
 * particular banner has now been wrong three times, by its own admission
 * ("the comment that used to sit here was wrong about it"). So the three claims
 * that matter are measured here instead of remembered:
 *
 *   1. The banner's CROSS-REFERENCES are true. It names the other modules that
 *      still carry the old "the swap is signature-preserving" promise, so a
 *      reader can go and correct them. A name that is no longer true sends
 *      someone to read a file that already agrees with them, and — worse —
 *      makes the whole banner look stale enough to skim.
 *   2. The banner does not UNDER-STATE the size of the task. It said "~40 call
 *      sites". An approximation is the wrong shape for this number: it can only
 *      be checked by counting, it grows every time a gated action is added, and
 *      an under-estimate of a security task is the specific failure the banner
 *      exists to prevent. A FLOOR ("more than N") is monotone in the safe
 *      direction — it stays true as the tree grows, and goes false only if the
 *      count collapses, which would mean gates were deleted.
 *   3. A shared store does not land WITHOUT A CALLER. This is the hazard the
 *      next person is most likely to produce: a correct, unit-tested Upstash
 *      backend that nothing imports, in a file whose name reads to the next
 *      auditor as a control that exists. That is the same defect shape as
 *      `tests/lib/auth/durable-login-counter.test.ts`'s "a security column with
 *      no reader", and this repo has ~10 prior instances of complete, tested,
 *      unreachable code.
 *
 * (3) passes vacuously today — there is no shared-store module at all — so the
 * detector behind it is pure and is driven by fixtures below, for the reason
 * `durable-login-counter.test.ts` states about its own scan: a detector that
 * never reports anything looks identical to a correctly-passing one.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();

/** Where product code lives. `tests/` and `scripts/` are deliberately absent. */
const PRODUCT_ROOTS = ["lib", "app", "components"];

/** The two banners that describe this gap and must agree about it. */
const BANNER_FILES = ["lib/rate-limit.ts", "lib/auth/login-throttle.ts"];

/**
 * The exact phrasings the old, false promise used — quoted by both banners, so
 * they are the strings to look for when checking whether a cross-referenced
 * file really does still carry it. Keyed on the promise itself rather than on
 * fuzzy wording, because `lib/email/quota.ts` now contains the words
 * "NOT signature-preserving" and a looser match would read that as a hit.
 */
const DROP_IN_PROMISE_PHRASES = ["signature stays the same", "only the storage changes"];

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

function productFiles(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  for (const root of PRODUCT_ROOTS) {
    for (const abs of sourceFiles(join(ROOT, root))) {
      out.push({ path: rel(abs), src: readFileSync(abs, "utf8") });
    }
  }
  return out;
}

/**
 * Drop comment lines, keeping code ones.
 *
 * A LINE heuristic rather than a tokeniser, and that is a deliberate trade: the
 * thing being counted is call sites, every comment in these files is either a
 * `//` line or a JSDoc body line starting with `*`, and both banners quote
 * `gateAuthAction({ kind: "login" })` in prose several times — so a scan that
 * counted comments would report the task as larger than it is, which is the
 * mirror image of the defect this file pins. If a future comment style defeats
 * the heuristic the count falls, and claim (2) below is asserted as a floor, so
 * it fails loudly rather than drifting.
 */
function codeLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
  });
}

/**
 * Every place a limiter verdict is obtained — i.e. every place that would need
 * an `await` if the store became shared.
 *
 * Conservative on purpose: it recognises the receivers this repo actually uses
 * (`limiters.*`, `authGates.*`, `…Limiter`) and the three gate functions, and
 * skips their own declarations. An under-count is safe here, because the claim
 * it feeds is a floor.
 */
const CALL_PATTERNS = [
  /\b(?:limiters|authGates)\.[A-Za-z_$][\w$]*\.(?:consume|check)\s*\(/g,
  /\b[A-Za-z_$][\w$]*[Ll]imiter\.(?:consume|check)\s*\(/g,
  /\b(?:gateAuthAction|gateLoginAttempt|recordLoginFailure)\s*\(/g,
];

function limiterCallSites(files: Array<{ path: string; src: string }>): {
  count: number;
  files: string[];
} {
  const touched = new Set<string>();
  let count = 0;
  for (const { path, src } of files) {
    for (const line of codeLines(src)) {
      // A declaration is not a call site.
      if (
        /\b(?:export\s+)?(?:async\s+)?function\s+(?:gateAuthAction|gateLoginAttempt|recordLoginFailure)\b/.test(
          line
        )
      )
        continue;
      let hits = 0;
      for (const pattern of CALL_PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        // exec loop, not matchAll: tsconfig sets no `target`, so tsc defaults
        // to ES5 and `for (const x of str.matchAll(...))` is a typecheck error
        // that vitest does not reproduce.
        while ((m = pattern.exec(line)) !== null) hits += 1;
      }
      if (hits > 0) {
        count += hits;
        touched.add(path);
      }
    }
  }
  return { count, files: Array.from(touched).sort() };
}

/* ───────────────── claim 1: the cross-references are true ─────────────────── */

/**
 * Comment text, as paragraphs.
 *
 * SCOPING THE SCAN TO A PARAGRAPH IS THE LOAD-BEARING PART. The first draft of
 * this file scanned whole files for "still" near a path and reported three
 * hits, two of them nonsense: `lib/rate-limit.ts` also says the
 * `destructiveUser` bucket's "name still says 'destructive' because the kind
 * `destructive` is what lib/actions/account.ts passes". That is a true sentence
 * about an unrelated subject. A guard that cries wolf about correct prose gets
 * switched off, so only paragraphs that actually quote the old promise are
 * searched for its cross-references.
 */
function commentParagraphs(src: string): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t === "" || t === "*" || t === "//" || t === "/**" || t === "*/") {
      if (cur.length > 0) paras.push(cur.join(" "));
      cur = [];
      continue;
    }
    cur.push(
      t
        .replace(/^\/\*\*?/, "")
        .replace(/^\*\s?/, "")
        .replace(/^\/\/\s?/, "")
    );
  }
  if (cur.length > 0) paras.push(cur.join(" "));
  return paras;
}

/**
 * Which `lib/…` paths a banner names as STILL carrying the drop-in promise.
 *
 * Only sentences containing "still", inside a paragraph that quotes the promise
 * itself, count. Both banners legitimately name files that have already been
 * corrected ("both corrected now"), and pointing at a corrected file is not a
 * claim about its present contents.
 */
export function staleDropInReferences(
  banner: string,
  readFile: (path: string) => string | null
): string[] {
  const stale: string[] = [];
  const dropInParagraphs = commentParagraphs(banner).filter((p) =>
    DROP_IN_PROMISE_PHRASES.some((phrase) => p.indexOf(phrase) !== -1)
  );
  for (const paragraph of dropInParagraphs) {
    for (const sentence of paragraph.split(/(?<=[.;)])\s+/)) {
      if (!/\bstill\b/.test(sentence)) continue;
      const pathPattern = /\b((?:lib|app|components)\/[\w./-]+?\.tsx?)\b/g;
      let m: RegExpExecArray | null;
      while ((m = pathPattern.exec(sentence)) !== null) {
        const src = readFile(m[1]);
        if (src === null) {
          stale.push(`${m[1]} (named as still carrying the promise, but does not exist)`);
          continue;
        }
        const carries = DROP_IN_PROMISE_PHRASES.some((p) => src.indexOf(p) !== -1);
        if (!carries) stale.push(m[1]);
      }
    }
  }
  return stale;
}

describe("prodready-013 — the banner's cross-references point at files that still carry the promise", () => {
  it("names no already-corrected file as still promising a signature-preserving swap", () => {
    const readFile = (path: string): string | null => {
      try {
        return readFileSync(join(ROOT, path), "utf8");
      } catch {
        return null;
      }
    };
    for (const bannerFile of BANNER_FILES) {
      const stale = staleDropInReferences(readFileSync(join(ROOT, bannerFile), "utf8"), readFile);
      expect(
        stale,
        `${bannerFile} says these files STILL promise the swap is signature-preserving, but ` +
          `none of them contains that promise any more. Correct the cross-reference in the ` +
          `same edit that corrected the file: ${stale.join(", ")}`
      ).toEqual([]);
    }
  });

  it("the detector reports a genuinely stale reference (fixture)", () => {
    const banner =
      "This file used to promise the signature stays the same; " +
      "lib/email/quota.ts still states it about its own counter.";
    expect(staleDropInReferences(banner, () => "this file says the upgrade is NOT a swap")).toEqual(
      ["lib/email/quota.ts"]
    );
    expect(
      staleDropInReferences(banner, () => "promises the consume() signature stays the same")
    ).toEqual([]);
  });

  it("the detector ignores a path named outside a 'still' sentence (fixture)", () => {
    const banner =
      "This file used to promise the signature stays the same, and " +
      "lib/auth/login-throttle.ts carried it too (both corrected now).";
    expect(staleDropInReferences(banner, () => "corrected")).toEqual([]);
  });

  it("the detector ignores a 'still' sentence in an unrelated paragraph (fixture)", () => {
    // The real false positive this scoping exists to suppress.
    const banner = [
      " * This file used to promise the signature stays the same (corrected now).",
      " *",
      ' * Its name still says "destructive" because lib/actions/account.ts passes it.',
    ].join("\n");
    expect(staleDropInReferences(banner, () => "no promise here")).toEqual([]);
  });
});

/* ──────────── claim 2: the size of the task is a floor, not a guess ───────── */

/**
 * The approximation forms that under-stated this number.
 *
 * `(?:[\w-]+\s+){0,2}` allows a HYPHENATED qualifier, and that detail already
 * mattered once: with a plain `\w+` this regex matched "all ~40 call sites" in
 * lib/rate-limit.ts but not "~40 server-action call sites" in
 * lib/auth/login-throttle.ts, so the second banner passed while carrying the
 * identical defect. A guard that only catches one of two copies of a claim is
 * the shape of bug this repo keeps filing against itself.
 */
const APPROXIMATE_FIGURE =
  /(?:~|about|approximately|roughly|around)\s*(\d+)\s*(?:[\w-]+\s+){0,2}call sites/i;

/** The floor form that replaces them. */
const FLOOR_FIGURE = /(?:more than|at least|over)\s*(\d+)\s*(?:[\w-]+\s+){0,2}call sites/i;

describe("prodready-013 — the banners state the size of the async refactor as a true floor", () => {
  const measured = limiterCallSites(productFiles());

  it("measures the real number of limiter call sites", () => {
    // Sanity on the scan itself: if this ever collapses, the floors below are
    // meaningless and the failure should say so here rather than there.
    expect(measured.files).toContain("lib/rate-limit.ts");
    expect(measured.files).toContain("lib/auth/login-throttle.ts");
    expect(measured.count).toBeGreaterThan(measured.files.length);
  });

  for (const bannerFile of BANNER_FILES) {
    it(`${bannerFile} does not approximate the count`, () => {
      const banner = readFileSync(join(ROOT, bannerFile), "utf8");
      const approx = APPROXIMATE_FIGURE.exec(banner);
      expect(
        approx === null ? null : approx[0],
        `${bannerFile} approximates the size of the shared-store refactor as "${approx?.[0]}", ` +
          `but the measured number of limiter call sites is ${measured.count} across ` +
          `${measured.files.length} files. An approximation of a security task's size can only ` +
          `be checked by counting, and this one under-states it. State a floor ("more than N ` +
          `call sites") instead: a floor stays true as the tree grows.`
      ).toBeNull();
    });

    it(`${bannerFile} states a floor the real count clears`, () => {
      const banner = readFileSync(join(ROOT, bannerFile), "utf8");
      const floor = FLOOR_FIGURE.exec(banner);
      expect(
        floor,
        `${bannerFile} states no floor for the number of limiter call sites a shared store ` +
          `would have to change. Measured: ${measured.count} across ${measured.files.length} files.`
      ).not.toBeNull();
      expect(
        measured.count,
        `${bannerFile} claims more than ${floor?.[1]} call sites, but only ${measured.count} ` +
          `were measured across ${measured.files.length} files: ${measured.files.join(", ")}. ` +
          `Either gates were deleted, or the scan in this file stopped seeing them.`
      ).toBeGreaterThan(Number(floor?.[1]));
    });
  }
});

/* ───────── claim 3: a shared store does not land without a caller ─────────── */

/**
 * The names a shared/remote rate-limit backend cannot avoid mentioning in CODE.
 * A comment mentioning Upstash is an aspiration, which is today's state and is
 * fine; a code reference is an implementation and must be reachable.
 */
const SHARED_STORE_MARKERS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "@upstash/",
  "@vercel/kv",
];

/**
 * Product modules that implement a shared store but that nothing else imports.
 *
 * Pure, and taking file CONTENTS rather than paths, so the fixtures below can
 * drive it — see the head of this file for why a vacuous scan needs that.
 */
export function unreachableSharedStores(files: Array<{ path: string; src: string }>): string[] {
  const implementers = files.filter(({ src }) =>
    codeLines(src).some((line) =>
      SHARED_STORE_MARKERS.some((marker) => line.indexOf(marker) !== -1)
    )
  );
  return implementers
    .filter(({ path }) => {
      // "foo/bar/baz.ts" is imported as ".../baz" or "@/foo/bar/baz".
      const moduleName = path.replace(/\.tsx?$/, "");
      const bare = moduleName.slice(moduleName.lastIndexOf("/") + 1);
      return !files.some(
        ({ path: other, src }) =>
          other !== path &&
          codeLines(src).some(
            (line) =>
              /\b(?:import|require|from)\b/.test(line) &&
              (line.indexOf(`@/${moduleName}`) !== -1 || line.indexOf(`/${bare}"`) !== -1)
          )
      );
    })
    .map(({ path }) => path);
}

describe("prodready-013 — a shared rate-limit store may not ship without a caller", () => {
  it("no product module implements one that nothing imports", () => {
    const orphans = unreachableSharedStores(productFiles());
    expect(
      orphans,
      `These modules reference a shared rate-limit backend in CODE but nothing imports them: ` +
        `${orphans.join(", ")}. A complete, tested, unreachable limiter backend reads to the ` +
        `next auditor as a control that exists — the same defect as a security column with no ` +
        `reader (tests/lib/auth/durable-login-counter.test.ts). Wire it, or do not land it.`
    ).toEqual([]);
  });

  it("the detector reports an unimported implementation (fixture)", () => {
    const files = [
      { path: "lib/rate-limit/upstash.ts", src: `const url = process.env.UPSTASH_REDIS_REST_URL;` },
      { path: "lib/rate-limit.ts", src: `export const limiters = {};` },
    ];
    expect(unreachableSharedStores(files)).toEqual(["lib/rate-limit/upstash.ts"]);
  });

  it("the detector accepts an imported implementation (fixture)", () => {
    const files = [
      { path: "lib/rate-limit/upstash.ts", src: `const url = process.env.UPSTASH_REDIS_REST_URL;` },
      {
        path: "lib/rate-limit.ts",
        src: `import { shared } from "@/lib/rate-limit/upstash";\nexport const limiters = { shared };`,
      },
    ];
    expect(unreachableSharedStores(files)).toEqual([]);
  });

  it("the detector treats a comment-only mention as an aspiration, not an implementation", () => {
    const files = [
      {
        path: "lib/rate-limit.ts",
        src: ` * Set UPSTASH_REDIS_REST_URL one day.\n// and @upstash/redis\nexport const x = 1;`,
      },
    ];
    expect(unreachableSharedStores(files)).toEqual([]);
  });
});
