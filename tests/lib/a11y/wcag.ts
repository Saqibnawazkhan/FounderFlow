/**
 * WCAG contrast arithmetic + a token reader for app/globals.css.
 *
 * Not a test file (vitest only collects `*.test.ts`), just the shared machinery
 * the a11y tests in this directory are built on.
 *
 * WHY THE RATIO IS COMPUTED HERE RATHER THAN READ FROM A BROWSER: jsdom has no
 * cascade and no compiled Tailwind, so `getComputedStyle(el).color` in a
 * component test tells you nothing about what a browser paints — a test built
 * on it passes whatever the stylesheet says. What IS mechanically checkable is
 * the design-token layer that feeds the cascade: the triples in globals.css are
 * the only input to every colour in the product, so computing the real WCAG
 * ratio from them catches an unreadable pair before a browser ever renders it.
 * A plausible-looking hex cannot fool this; only a passing ratio can.
 */

import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const GLOBALS_CSS = path.join(REPO_ROOT, "app", "globals.css");
export const TAILWIND_CONFIG = path.join(REPO_ROOT, "tailwind.config.ts");

/** WCAG 2.1 AA floors. */
export const AA_TEXT = 4.5;
/** 1.4.11 Non-text Contrast — UI component state, e.g. a focus indicator. */
export const AA_NON_TEXT = 3;

export type Rgb = [number, number, number];

/** sRGB -> linear, per WCAG 2.x relative-luminance definition. */
function linearize(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio, 1..21. Order of arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * What the eye actually receives when a translucent foreground sits on an
 * opaque background. Tailwind's `/60` modifier does NOT dim the text the way a
 * filter would — it emits `rgb(var(--token) / 0.6)`, which the compositor
 * blends against whatever is behind it. So the contrast of `text-fg-muted/60`
 * is the contrast of the BLENDED colour, never of the token.
 */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function hex(rgb: Rgb): string {
  const part = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/* ------------------------------------------------------------------------- */
/* globals.css token reader                                                  */
/* ------------------------------------------------------------------------- */

export function readGlobalsCss(): string {
  return fs.readFileSync(GLOBALS_CSS, "utf8");
}

/**
 * Comments removed, so a rule-level parser can trust that whatever sits between
 * the previous `}` and the next `{` is a selector list. globals.css documents
 * nearly every rule with a block comment directly above it, and a comment is
 * brace-free, so without this step a selector match happily swallows the comment
 * above it and no selector ever compares equal to `:focus-visible`.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Text of the declaration block whose selector list starts with `startsWith`. */
function blockStartingWith(css: string, startsWith: string): string {
  const at = css.indexOf(startsWith);
  if (at === -1) throw new Error(`app/globals.css has no block starting with \`${startsWith}\``);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) {
    throw new Error(`app/globals.css: unterminated block for \`${startsWith}\``);
  }
  return css.slice(open + 1, close);
}

export type TokenMap = Record<string, Rgb>;

/** `--name: 12 34 56;` triples in one declaration block. */
function parseTriples(block: string): TokenMap {
  const out: TokenMap = {};
  // No named capture groups and no matchAll-in-for-of: tsconfig sets `lib` but
  // no `target`, so tsc defaults to ES5 and both fail typecheck while passing
  // vitest. An exec loop is the portable spelling.
  const re = /--([a-z][a-z0-9-]*)\s*:\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g;
  let m = re.exec(block);
  while (m !== null) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
    m = re.exec(block);
  }
  return out;
}

export type Themes = { light: TokenMap; dark: TokenMap };

/**
 * The two themes as a browser resolves them.
 *
 * Custom properties INHERIT, and `.dark` only redefines a subset — so the dark
 * theme is light's table with the `.dark` block layered on top. Modelling that
 * is the whole point: a11y-003 exists precisely because `.dark` redefines
 * `--danger-strong` and silently inherits `--danger` from `:root`, so red-600
 * (picked to carry white text on a solid fill) ends up painting error text on a
 * charcoal card.
 */
export function readThemes(css: string = readGlobalsCss()): Themes {
  const light = parseTriples(blockStartingWith(css, ":root,"));
  const darkOverrides = parseTriples(blockStartingWith(css, ".dark,"));
  return { light, dark: Object.assign({}, light, darkOverrides) };
}

export function token(theme: TokenMap, name: string): Rgb {
  const value = theme[name];
  if (!value) throw new Error(`app/globals.css defines no --${name}`);
  return value;
}

/* ------------------------------------------------------------------------- */
/* source sweep                                                              */
/* ------------------------------------------------------------------------- */

const SOURCE_DIRS = ["app", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Every authored component/route file, walked rather than listed, so a file
 *  added next month is covered the day it lands. */
export function collectSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  for (const dirName of SOURCE_DIRS) {
    const dir = path.join(REPO_ROOT, dirName);
    if (fs.existsSync(dir)) walk(dir);
  }
  return found;
}

export type Occurrence = { file: string; text: string };

/** All matches of `re` across app/ + components/, with the owning file. */
export function sweepSource(re: RegExp): Occurrence[] {
  const hits: Occurrence[] = [];
  for (const file of collectSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    const scoped = new RegExp(re.source, re.flags.indexOf("g") === -1 ? re.flags + "g" : re.flags);
    let m = scoped.exec(contents);
    while (m !== null) {
      hits.push({ file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"), text: m[0] });
      m = scoped.exec(contents);
    }
  }
  return hits;
}
