import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * REACHABILITY guard for i18n-004 — the locale-aware date helpers.
 *
 * ## Why a sweep and not more unit tests
 *
 * `formatDate` and `formatRelativeTime` in lib/utils.ts already take a `locale`
 * and already render Urdu correctly; tests/lib/utils/date-locale.test.ts proves
 * it. None of that reached a customer, because the parameter is OPTIONAL and
 * not one call site passed it — so with the interface in Urdu every date still
 * read "Sep 26, 2026". The finding was recorded as fixed while being fully
 * true for the user.
 *
 * That is this codebase's most recurrent defect (shipped, tested, unreachable —
 * ten documented instances, three in three consecutive waves), and a unit test
 * on the helper cannot catch it by construction: the helper is not the thing
 * that is wrong. The only assertion that can is one about the CALL SITES, so
 * that is what this file makes.
 *
 * ## The contract
 *
 * A rendered surface (anything under app/ or components/) must never reach
 * `formatDate` / `formatRelativeTime` through `@/lib/utils` directly. It goes
 * through `useDateFormat()` in lib/i18n/use-t.ts, which binds the helpers to
 * the locale in the Zustand store — the same arrangement as `useNumberFormat()`
 * and for the same reason stated there: no component ever names a locale tag,
 * so none can get it wrong, and none can forget.
 *
 * Importing the bare helper is therefore the hit, whether it is called or
 * merely referenced, because a reference is how it gets passed somewhere that
 * calls it without a locale. The line-level marker below is the way to keep one
 * deliberately.
 *
 * ## What this cannot prove
 *
 * That the rendered Urdu is idiomatic. It is CLDR's, not ours (see the argument
 * on `NAMED_DAY_AT_TIME` in lib/utils.ts), but "ICU says so" is not the same as
 * "a reader in Karachi finds it natural". Run scripts/smoke-i18n.mjs, switch to
 * اردو, and look at the notifications dropdown and the /team join dates.
 */

/** Recursively scanned roots. Every rendered surface the app serves. */
const SCANNED_ROOTS = [path.join(REPO_ROOT, "app"), path.join(REPO_ROOT, "components")];

/** The module the locale-blind helpers live in, and the names that matter. */
const HELPER_MODULE = "@/lib/utils";
const LOCALE_BLIND_HELPERS = ["formatDate", "formatRelativeTime"];

/** Where a rendered surface is supposed to get them from instead. */
const HOOK_MODULE = path.join(REPO_ROOT, "lib", "i18n", "use-t.ts");
const HOOK_NAME = "useDateFormat";

/**
 * Line-level escape hatch, written as a comment on the offending line or in the
 * comment block directly above it:
 *
 *   // locale-free-date-ok: why this one must stay English
 *
 * It exists for one real category, and it is the same category
 * `formatAmountForMessage` in lib/utils.ts exists for: a string that is written
 * once and read by everybody has no single viewer whose locale applies, and
 * localising only the date inside an English sentence half-translates it. The
 * live example is settings-client's billing notice, whose surrounding prose is
 * hardcoded English in lib/billing/plan.ts.
 *
 * `markers all still suppress something` below keeps this from rotting into a
 * mute button: a marker that no longer sits on a real hit fails.
 */
const LOCALE_FREE_MARKER = "locale-free-date-ok";

/**
 * Scanned files that are NOT wired yet, keyed by repo-relative path with the
 * reason and the owner.
 *
 * EMPTY on purpose: this wave converted all eight call sites rather than
 * excusing any. The mechanism stays because the alternative — deleting it and
 * re-inventing it under time pressure next time — is how the last allowlist got
 * written as a plain comment nobody could fail. `every excused file is still
 * unwired` below asserts each entry is still genuinely dirty, so an entry that
 * gets fixed fails the suite and tells the fixer to delete the line.
 */
const NOT_YET_WIRED = new Map<string, string>([]);

/**
 * Blanks out comments while preserving line numbering, so prose discussing
 * `formatDate` — which several of the scanned files do at length — cannot
 * masquerade as a call. The (?<!:) guard keeps https:// intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Repo-relative, forward-slashed — the shape NOT_YET_WIRED is keyed by. */
function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function walk(dir: string, found: string[]): string[] {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  });
  return found;
}

function scannedFiles(): string[] {
  const found: string[] = [];
  SCANNED_ROOTS.forEach((root) => walk(root, found));
  return found;
}

type Binding = {
  /** The name as exported by lib/utils.ts. */
  imported: string;
  /** The name as used in this file — `import { formatDate as fd }` aliases. */
  local: string;
  /** Line indices spanned by the import statement, which are not themselves hits. */
  importLines: number[];
};

/**
 * Every binding this file pulls out of `@/lib/utils` that we care about.
 *
 * Parsed from the import statement rather than assumed, so a file declaring its
 * own local `formatDate` (there is no such file today, and that is exactly the
 * kind of thing that changes) is not accused of importing one.
 */
function bindingsFrom(source: string, stripped: string): Binding[] {
  const bindings: Binding[] = [];
  // Indexed exec loop, not matchAll: tsconfig sets `lib` but no `target`, so
  // tsc emits ES5 and `for…of` over an iterator is this repo's standing trap.
  const importRe = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${HELPER_MODULE.replace("/", "\\/")}["']`,
    "g"
  );
  let match = importRe.exec(stripped);
  while (match !== null) {
    const startLine = stripped.slice(0, match.index).split("\n").length - 1;
    const endLine = startLine + match[0].split("\n").length - 1;
    const lines: number[] = [];
    for (let i = startLine; i <= endLine; i++) lines.push(i);

    match[1].split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s+as\s+/);
      const imported = parts[0].trim();
      if (LOCALE_BLIND_HELPERS.indexOf(imported) === -1) return;
      bindings.push({
        imported,
        local: (parts[1] ?? parts[0]).trim(),
        importLines: lines,
      });
    });
    match = importRe.exec(stripped);
  }
  // `source` is unused for parsing but keeps the signature honest about what
  // the caller holds; referencing it avoids an unused-parameter lint.
  void source;
  return bindings;
}

/**
 * For each line, the index of the `locale-free-date-ok` marker that exempts it,
 * or -1. A marker counts on its own line, or from a comment-only block sitting
 * directly above — "comment-only" meaning the line has raw text but nothing
 * survives stripComments, so a blank line or real code ends the block.
 */
function exemptionFor(rawLines: string[], strippedLines: string[]): number[] {
  return rawLines.map((raw, i) => {
    if (raw.includes(LOCALE_FREE_MARKER)) return i;
    for (let back = i - 1; back >= 0; back--) {
      const isCommentOnly =
        strippedLines[back].trim().length === 0 && rawLines[back].trim().length > 0;
      if (!isCommentOnly) return -1;
      if (rawLines[back].includes(LOCALE_FREE_MARKER)) return back;
    }
    return -1;
  });
}

type HitScan = {
  /** "path:line — name", marker-exempt lines removed. */
  hits: string[];
  /** Line indices carrying a marker that suppressed at least one hit. */
  usedMarkers: Set<number>;
  /** Line indices carrying a marker at all. */
  allMarkers: number[];
};

function scanFile(file: string): HitScan {
  const rel = relPath(file);
  const source = fs.readFileSync(file, "utf8");
  const stripped = stripComments(source);
  const rawLines = source.split("\n");
  const strippedLines = stripped.split("\n");
  const exemptions = exemptionFor(rawLines, strippedLines);

  const hits: string[] = [];
  const usedMarkers = new Set<number>();
  const allMarkers: number[] = [];
  rawLines.forEach((raw, i) => {
    if (raw.includes(LOCALE_FREE_MARKER)) allMarkers.push(i);
  });

  bindingsFrom(source, stripped).forEach((binding) => {
    const useRe = new RegExp(`(?<![A-Za-z0-9_$.])${binding.local}(?![A-Za-z0-9_$])`);
    strippedLines.forEach((line, i) => {
      if (binding.importLines.indexOf(i) !== -1) return;
      if (!useRe.test(line)) return;
      const hit = `${rel}:${i + 1} — ${binding.imported} from ${HELPER_MODULE}, no viewer locale (use ${HOOK_NAME}())`;
      if (exemptions[i] >= 0) usedMarkers.add(exemptions[i]);
      else hits.push(hit);
    });
  });

  return { hits, usedMarkers, allMarkers };
}

describe(`${HOOK_NAME} is actually reached (i18n-004)`, () => {
  it("is exported from lib/i18n/use-t.ts and threads the store locale into both helpers", () => {
    // The hook is the only thing standing between the tested helpers and the
    // dead end they were in. If it stops binding `useLocale()` the sweep below
    // still passes — every call site would be calling a hook that quietly
    // renders English — so the binding is asserted directly.
    const source = stripComments(fs.readFileSync(HOOK_MODULE, "utf8"));
    expect(source, `${HOOK_NAME} is not exported from lib/i18n/use-t.ts`).toMatch(
      new RegExp(`export function ${HOOK_NAME}\\s*\\(`)
    );
    expect(source, `${HOOK_NAME} does not read the active locale`).toMatch(/useLocale\(\)/);
    LOCALE_BLIND_HELPERS.forEach((helper) => {
      expect(source, `${HOOK_NAME} never passes a locale to ${helper}`).toMatch(
        new RegExp(`${helper}\\([^)]*,\\s*locale\\s*\\)`)
      );
    });
  });

  it("no rendered surface formats a date without the viewer's locale", () => {
    const offenders: string[] = [];

    scannedFiles().forEach((file) => {
      if (NOT_YET_WIRED.has(relPath(file))) return;
      scanFile(file).hits.forEach((hit) => offenders.push(hit));
    });

    expect(
      offenders,
      `These reach lib/utils' date helpers directly, so they render English on an Urdu screen — the whole of i18n-004 as a customer experiences it:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every excused file is still unwired", () => {
    const stale: string[] = [];

    Array.from(NOT_YET_WIRED.entries()).forEach(([rel, reason]) => {
      const file = path.join(REPO_ROOT, rel);
      // A deleted or renamed file is just as stale as a fixed one.
      if (!fs.existsSync(file) || scanFile(file).hits.length === 0) {
        stale.push(`${rel} (excused for ${reason})`);
      }
    });

    expect(
      stale,
      `These are wired now — delete them from NOT_YET_WIRED so the guard covers them:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("markers all still suppress something", () => {
    const stale: string[] = [];

    scannedFiles().forEach((file) => {
      const { usedMarkers, allMarkers } = scanFile(file);
      allMarkers.forEach((line) => {
        if (!usedMarkers.has(line)) stale.push(`${relPath(file)}:${line + 1}`);
      });
    });

    expect(
      stale,
      `A ${LOCALE_FREE_MARKER} comment no longer sits on a real hit. Delete it — an excuse that outlives its reason is how the next one gets waved through:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the optional locale parameter, so the persisted-string callers stay English", () => {
    // Not decoration. Making `locale` required would turn every server caller
    // into a compile error at once, and the fix under that pressure is to pass
    // "en" to silence it — which is right for lib/billing/billing-notify.ts and
    // wrong everywhere else, with nothing left to tell the two apart. The
    // default IS the decision for a row written once and read by everybody.
    const utils = stripComments(fs.readFileSync(path.join(REPO_ROOT, "lib", "utils.ts"), "utf8"));
    LOCALE_BLIND_HELPERS.forEach((helper) => {
      expect(utils, `${helper} no longer defaults its locale to English`).toMatch(
        new RegExp(`export function ${helper}\\([^)]*locale:\\s*Locale\\s*=\\s*"en"`)
      );
    });
  });
});
