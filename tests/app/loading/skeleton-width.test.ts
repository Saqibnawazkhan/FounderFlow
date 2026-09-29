import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const APP_GROUP = path.join(REPO_ROOT, "app", "(app)");

/**
 * Layout-shift guard for the streaming skeletons (audit resp-005).
 *
 * THE BUG THIS EXISTS FOR: every route under app/(app) has a `loading.tsx`
 * that Next.js paints while the RSC awaits Prisma. Six of them were laid out
 * to a different maximum width than the page they stand in for, so the whole
 * column jumped sideways the instant data arrived — /expenses, /investments
 * and /reports snapped from a 1280px column to a 1600px one, /settings and
 * /notifications collapsed from 900px and 1100px to 768px, and /activities
 * shrank from 1280px to 896px. That is a large layout shift at exactly the
 * moment a reader starts reading numbers.
 *
 * WHY A STRUCTURAL TEST RATHER THAN SIX CORRECTED LITERALS: the width lives in
 * two files that nobody edits together. Fixing the six numbers by hand fixes
 * today and guarantees the same drift the next time a page's container moves.
 * Pairing each skeleton with its settled surface and comparing the token makes
 * the next drift fail here instead of in a browser nobody is measuring.
 *
 * WHAT THIS CAN PROVE: that the two files name the SAME Tailwind width token.
 * jsdom computes no boxes and does not compile Tailwind, so it cannot prove the
 * painted columns are equal — but an identical token is the input that decides
 * it, and a differing token is a guaranteed jump. Comparison is on the literal
 * token, not a pixel value, so `max-w-3xl` vs `max-w-[768px]` fails even though
 * they paint the same: one of them is about to be edited and the other is not.
 *
 * WHAT IT CANNOT PROVE, and is therefore a MANUAL CHECK: that the skeleton's
 * *contents* are the same height as the settled page. Equal width kills the
 * sideways jump; a vertical jump needs a browser and a real fetch.
 */

/** The container idiom used by every page shell in this app. */
const CENTERING_UTILITY = "mx-auto";
const WIDTH_PREFIX = "max-w-";
/** Printed when a surface is deliberately full-bleed (chat), so both sides read alike. */
const FULL_BLEED = "(no container)";

/**
 * Blanks out comments while preserving line numbering, so prose discussing a
 * width — which several of these files do, at length — cannot masquerade as a
 * class string. The (?<!:) guard keeps https:// intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * The width token of a file's outermost page container, or FULL_BLEED.
 *
 * Anchored on `mx-auto` rather than on `max-w-` alone: a bare `max-w-` is a
 * width somewhere inside the page (a prose column, a modal), while `mx-auto`
 * plus a width IS the page shell in this codebase, and it appears exactly once
 * per surface. Fails closed — a container moved into `cn()` or a template
 * literal stops being found, reads as FULL_BLEED, and the comparison goes red
 * rather than silently passing.
 */
function containerWidth(source: string): string {
  const stripped = stripComments(source);
  const quoted = /"([^"\\\n]*)"/g;
  let match = quoted.exec(stripped);
  while (match !== null) {
    const classes = match[1].split(/\s+/);
    if (classes.indexOf(CENTERING_UTILITY) !== -1) {
      const width = classes.find((c) => c.startsWith(WIDTH_PREFIX));
      if (width) return width;
    }
    match = quoted.exec(stripped);
  }
  return FULL_BLEED;
}

/** Repo-relative, forward-slashed, for readable failure output. */
function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Route label as a reader types it: "expenses", "projects/[id]", "chat". */
function routeOf(dir: string): string {
  const rel = path.relative(APP_GROUP, dir).split(path.sep).join("/");
  return rel === "" ? "/" : rel;
}

function dirsUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    out.push(dir);
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    });
  };
  walk(root);
  return out;
}

const ALL_DIRS = dirsUnder(APP_GROUP);

/** Every streaming fallback the app ships, sorted for stable output. */
const LOADING_FILES = ALL_DIRS.map((d) => path.join(d, "loading.tsx"))
  .filter((f) => fs.existsSync(f))
  .sort();

/** Every route that renders a surface. */
const PAGE_FILES = ALL_DIRS.map((d) => path.join(d, "page.tsx"))
  .filter((f) => fs.existsSync(f))
  .sort();

/**
 * The files that render the settled surface a skeleton is replaced by, nearest
 * first: the route's own `page.tsx` (which sometimes owns the shell itself, as
 * /activities does) and its `*-client.tsx`. A segment whose own directory holds
 * neither container — /chat, which only redirects — hands the job to the child
 * route the same `loading.tsx` also covers.
 */
function settledSources(dir: string): string[] {
  const here = (d: string): string[] => {
    const found: string[] = [];
    const page = path.join(d, "page.tsx");
    if (fs.existsSync(page)) found.push(page);
    fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith("-client.tsx"))
      .map((e) => path.join(d, e.name))
      .sort()
      .forEach((f) => found.push(f));
    return found;
  };

  const own = here(dir);
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort()
    .reduce<string[]>((acc, d) => acc.concat(here(d)), []);
  return own.concat(children);
}

/** The first settled source that declares a container, and the width it declares. */
function settledWidth(dir: string): { file: string | null; width: string } {
  const sources = settledSources(dir);
  for (let i = 0; i < sources.length; i++) {
    const width = containerWidth(fs.readFileSync(sources[i], "utf8"));
    if (width !== FULL_BLEED) return { file: sources[i], width };
  }
  return { file: sources.length > 0 ? sources[0] : null, width: FULL_BLEED };
}

describe("route skeletons match the page they stand in for (resp-005)", () => {
  it("finds a skeleton to check", () => {
    expect(LOADING_FILES.length).toBeGreaterThan(10);
  });

  it("pairs every skeleton with a surface, so a rename cannot silently disable this", () => {
    const orphans = LOADING_FILES.filter((f) => settledSources(path.dirname(f)).length === 0).map(
      relPath
    );
    expect(orphans).toEqual([]);
  });

  it("lays every skeleton out to the same container width as its page", () => {
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};

    LOADING_FILES.forEach((file) => {
      const dir = path.dirname(file);
      const settled = settledWidth(dir);
      const key = `${routeOf(dir)}  (${relPath(file)} vs ${
        settled.file ? relPath(settled.file) : "nothing"
      })`;
      actual[key] = containerWidth(fs.readFileSync(file, "utf8"));
      expected[key] = settled.width;
    });

    expect(actual).toEqual(expected);
  });

  it("gives every route a streaming fallback, so none falls back to a blank shell", () => {
    const uncovered = PAGE_FILES.filter((page) => {
      let dir = path.dirname(page);
      while (dir.startsWith(APP_GROUP)) {
        if (fs.existsSync(path.join(dir, "loading.tsx"))) return false;
        dir = path.dirname(dir);
      }
      return true;
    }).map((p) => routeOf(path.dirname(p)));

    expect(uncovered).toEqual([]);
  });
});
