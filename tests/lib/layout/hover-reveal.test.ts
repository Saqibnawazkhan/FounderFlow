import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Controls that are revealed by hover (audit resp-004).
 *
 * WHY THIS IS A SOURCE SWEEP AND NOT A RENDER TEST: jsdom has no layout engine,
 * does not resolve the Tailwind cascade, does not implement `:hover`,
 * `:focus-visible` or media queries, and `tests/setup.ts` stubs `matchMedia` to
 * answer `matches: false` for every query. A test that renders the card and
 * asserts "the delete button is invisible" would pass identically before and
 * after the fix, which is this repo's most recurrent defect. What IS
 * mechanically checkable is the class contract that decides the behaviour.
 *
 * THE CONTRACT. `opacity-0` hides a control without removing it from the tab
 * order or from the accessibility tree, so a control revealed by hover alone is
 *
 *   - invisible to a keyboard user who tabs onto it (it becomes
 *     document.activeElement while painting nothing — focus ring included,
 *     which reads as the focus indicator being broken), and
 *   - permanently invisible on a touch device, which fires no `:hover` at all.
 *
 * So any INTERACTIVE element that hides itself behind hover must also reveal
 * itself on focus, and must not depend on hover where there is none.
 *
 * Non-interactive reveals are deliberately out of scope: a hover-only timestamp
 * or a decorative gradient overlay cannot be focused and carries no action, so
 * there is nothing to make reachable.
 */

const SCANNED_ROOTS = [path.join(REPO_ROOT, "app"), path.join(REPO_ROOT, "components")];

/** `opacity-0` paired with a hover reveal — `hover:` or `group-hover:`. */
const HIDDEN = /\bopacity-0\b/;
const HOVER_REVEAL = /hover:opacity-100/;

/** Either satisfies "revealed on focus". */
const FOCUS_REVEAL = /(?:focus-visible|group-focus-within|focus-within|focus):opacity-100/;

/**
 * Either satisfies "does not depend on hover". `max-md:` is the existing house
 * spelling (components/chat/message-row.tsx) and covers the phone layouts;
 * `[@media(hover:none)]:` is the capability query, which also covers a touch
 * tablet sitting above the `md` breakpoint.
 */
const NO_HOVER_REVEAL = /max-(?:sm|md|lg):opacity-100|\[@media\(hover:none\)\]:opacity-100/;

/** Tags that are focusable and actionable on their own. */
const INTERACTIVE_TAGS = ["button", "a", "Link", "input", "select", "textarea", "summary"];

/** Attributes that make any tag actionable. */
const INTERACTIVE_ATTRS = /\bonClick=|\bhref=|\brole="button"/;

/** WCAG 2.2 SC 2.5.8 — the minimum target for a pointer, in CSS pixels. */
const MIN_TARGET_PX = 24;
/** Tailwind's spacing scale: 1 unit = 0.25rem = 4px at the default root size. */
const PX_PER_UNIT = 4;

function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function walk(dir: string, found: string[]): string[] {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
  });
  return found;
}

function scannedFiles(): string[] {
  const found: string[] = [];
  SCANNED_ROOTS.forEach((root) => walk(root, found));
  return found;
}

type RevealSite = {
  where: string;
  interactive: boolean;
  className: string;
  /** The smallest square pointer target this control offers, or null if it is not an icon-only control. */
  targetPx: number | null;
};

/**
 * Finds the opening tag a class string belongs to by walking back to the
 * nearest line that opens one. JSX arrow handlers put a `>` inside the
 * attribute list (`onClick={(e) => …}`), so a single `<tag[^>]*>` regex stops
 * at the wrong place — hence the line walk.
 */
function revealSites(file: string): RevealSite[] {
  const rel = relPath(file);
  const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
  const sites: RevealSite[] = [];

  lines.forEach((line, i) => {
    if (!HIDDEN.test(line) || !HOVER_REVEAL.test(line)) return;

    let tag = "";
    let openedAt = i;
    for (let back = i; back >= 0 && back > i - 20; back--) {
      const opener = /<([A-Za-z][\w.]*)/.exec(lines[back]);
      if (opener) {
        tag = opener[1];
        openedAt = back;
        break;
      }
    }

    const attrs = lines.slice(openedAt, i + 1).join("\n");
    const interactive =
      INTERACTIVE_TAGS.indexOf(tag) !== -1 || INTERACTIVE_ATTRS.test(attrs) || /button/i.test(tag);

    // Icon-only control: uniform padding plus a single square icon inside. The
    // pointer target is padding on both sides plus the icon box.
    const padding = /\bp-(\d+(?:\.\d+)?)\b/.exec(line);
    const body = lines.slice(i, i + 8).join("\n");
    const icon = /\bh-(\d+(?:\.\d+)?) w-\1\b/.exec(body);
    const targetPx =
      padding && icon ? (Number(padding[1]) * 2 + Number(icon[1])) * PX_PER_UNIT : null;

    sites.push({
      where: `${rel}:${i + 1}`,
      interactive,
      className: line.trim(),
      targetPx,
    });
  });

  return sites;
}

function allSites(): RevealSite[] {
  const sites: RevealSite[] = [];
  scannedFiles().forEach((file) => revealSites(file).forEach((s) => sites.push(s)));
  return sites;
}

describe("hover-revealed controls (resp-004)", () => {
  it("finds the hover-reveal pattern at all, so a silent rename cannot empty this suite", () => {
    // A sweep that matches nothing passes forever. This is the canary.
    expect(allSites().length).toBeGreaterThan(0);
  });

  it("reveals every interactive hover-only control on focus as well", () => {
    const offenders = allSites()
      .filter((s) => s.interactive && !FOCUS_REVEAL.test(s.className))
      .map((s) => `${s.where}\n    ${s.className}`);

    expect(
      offenders,
      `opacity-0 leaves these in the tab order while painting nothing, so a keyboard user focuses an invisible control:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("does not leave an interactive control behind hover on a device with no hover", () => {
    const offenders = allSites()
      .filter((s) => s.interactive && !NO_HOVER_REVEAL.test(s.className))
      .map((s) => `${s.where}\n    ${s.className}`);

    expect(
      offenders,
      `A touch device fires no :hover, so these controls never appear on a phone at all:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("gives every icon-only hover-revealed control a 24x24 pointer target", () => {
    // WCAG 2.2 SC 2.5.8. Computed from the classes rather than matched as a
    // string, so a plausible-looking `p-1` cannot pass by resembling the fix.
    const offenders = allSites()
      .filter((s) => s.interactive && s.targetPx !== null && s.targetPx < MIN_TARGET_PX)
      .map((s) => `${s.where} — ${s.targetPx}x${s.targetPx}px\n    ${s.className}`);

    expect(
      offenders,
      `Under the ${MIN_TARGET_PX}x${MIN_TARGET_PX}px minimum target size:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
