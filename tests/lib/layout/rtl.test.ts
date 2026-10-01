import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SUPPORTED_LOCALES } from "@/lib/i18n/strings";
import { dialectFor, stripComments } from "../harness/source-scan";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * RTL guard for the whole rendered product (audit S20 + i18n-003).
 *
 * WHAT THIS CAN PROVE: jsdom has no layout engine — it never computes a box, so
 * no test here can assert that the sidebar actually lands on the right in Urdu.
 * What IS mechanically checkable is the input to that layout: whether a surface
 * is written in logical properties (start/end) or physical ones (left/right). A
 * physical utility is a guaranteed mirror failure, so catching it statically
 * catches the bug before a browser ever sees it.
 *
 * WHAT IT CANNOT PROVE, and is therefore a MANUAL CHECK: that the mirrored
 * result is actually usable — overlap between the rail and the content, icons
 * that read backwards, dropdowns clipped by the viewport edge, and the
 * bidirectional runs you get when an English workspace name sits inside an Urdu
 * sentence. Run scripts/smoke-i18n.mjs, switch to اردو, and look at it.
 *
 * ORIGINALLY this scanned components/layout + components/chat + three shell
 * files, which is how i18n-003 happened: the chrome mirrored and the pages
 * inside it did not, so an Urdu user got search icons, money columns and
 * calendar rules pinned to the wrong edge inside a correctly flipped shell.
 * The scan now walks app/ and components/ in full, and it walks DIRECTORIES
 * rather than naming files, so a page added next month is covered the day it
 * lands.
 */

/** Recursively scanned roots. Every rendered surface the app serves. */
const SCANNED_ROOTS = [path.join(REPO_ROOT, "app"), path.join(REPO_ROOT, "components")];

/**
 * Files outside the scanned roots that still emit class strings.
 *
 * EMPTY, and deliberately so. `lib/i18n/strings.ts` was listed here on the
 * stated ground that "one entry carries markup". It does not — the file holds
 * no `className`, no JSX and no class string anywhere. The only thing the sweep
 * ever found in it was the English phrase "left-to-right" inside the language
 * picker's description of the English option, which `left-/right-` matches as
 * prose.
 *
 * A copy file cannot contain a Tailwind utility, so scanning one can only ever
 * produce false positives, and the pressure that creates is to reword correct
 * customer-facing copy to satisfy a regex. Add a file here only if it genuinely
 * emits class strings.
 */
const EXTRA_SCANNED_FILES: string[] = [];

/**
 * The marketing surface, excluded on purpose and NOT an oversight.
 *
 * `app/page.tsx` and everything it pulls from `components/landing` render
 * inside a `data-marketing data-theme="light"` root: a single fixed-direction
 * brochure page that is not localised, is not reachable from the Urdu app
 * shell, and whose physical utilities (corner glows, a decorative quote mark, a
 * centered lamp) are art direction rather than reading order. Converting them
 * would be churn with no reader.
 *
 * The exclusion is held honest by `marketing surface` below: if that root ever
 * stops declaring itself marketing, the exclusion fails instead of quietly
 * covering a localised page.
 */
const MARKETING_PAGE = "app/page.tsx";
const MARKETING_DIR = "components/landing/";

/**
 * Physical utilities and the logical utility that replaces each. Tailwind 3.4
 * (see package.json) ships every logical variant named here — ms/me and ps/pe
 * since v3.0, start/end, border-s/border-e and text-start/text-end since v3.3 —
 * so there is no polyfill gap to justify a physical class.
 */
const PHYSICAL_UTILITIES: { physical: string; logical: string; pattern: RegExp }[] = [
  { physical: "ml-/mr-", logical: "ms-/me-", pattern: /(?<![a-zA-Z0-9-])-?(?:ml|mr)-/ },
  { physical: "pl-/pr-", logical: "ps-/pe-", pattern: /(?<![a-zA-Z0-9-])-?(?:pl|pr)-/ },
  {
    physical: "left-/right-",
    logical: "start-/end-",
    pattern: /(?<![a-zA-Z0-9-])-?(?:left|right)-/,
  },
  { physical: "border-l/border-r", logical: "border-s/border-e", pattern: /border-[lr](?![a-z])/ },
  {
    physical: "text-left/text-right",
    logical: "text-start/text-end",
    pattern: /text-(?:left|right)(?![a-z])/,
  },
];

/**
 * Line-level escape hatch, written as a comment on the offending line or in the
 * comment block directly above it:
 *
 *   {* rtl-physical-ok: why this edge is physical *}
 *
 * It exists for ONE real category, and the category is a trap rather than a
 * preference: `left-1/2 … -translate-x-1/2` is the horizontal-centering idiom,
 * and it already centres correctly in both directions because both halves are
 * physical and cancel. Convert only the first half and the element lands a full
 * width off-centre in Urdu — a regression invisible in every locale anyone
 * looks at. The same holds for any `left-*`/`right-*` bound to a transform, or
 * paired with its own opposite (`left-0 right-0` is `inset-x-0`, not a guess).
 *
 * `markers all still suppress something` below keeps this from rotting into a
 * mute button: a marker that no longer sits on a physical utility fails.
 */
const PHYSICAL_OK_MARKER = "rtl-physical-ok";

/**
 * Scanned files that are NOT converted yet, keyed by repo-relative path. Each
 * belongs to a different row of the audit and a different owner, so no single
 * agent could touch them.
 *
 * Keyed by PATH, not basename: two scanned directories can hold the same
 * filename, and a basename key would silently excuse both.
 *
 * This is not a mute button: the second test asserts every entry is still
 * dirty, so the moment someone converts one the suite fails and tells them to
 * delete the line. An allowlist that outlives its reason rots into decoration.
 */
const NOT_YET_CONVERTED = new Map<string, string>([
  ["components/layout/command-palette.tsx", "text-left on the result rows, unmirrored ArrowRight"],
  ["components/layout/verify-email-banner.tsx", "pl-7 sm:pl-0 on the action cluster"],
  ["components/chat/message-composer.tsx", "left-0 right-0 mention popover, text-left rows"],
  ["components/chat/message-list.tsx", "left-1/2 on the jump-to-latest pill"],
  ["components/chat/message-row.tsx", "text-right timestamp, ml-1 edited marker"],
  ["components/chat/new-channel-modal.tsx", "text-left on the kind picker"],
  ["components/chat/new-dm-modal.tsx", "text-left on the teammate rows"],
  ["components/chat/reaction-bar.tsx", "left-0 on the emoji popover"],
]);

// `stripComments` blanks comments while preserving line numbering, so prose
// discussing left-0 or border-r — which this file and the components it scans
// both do — cannot masquerade as a class. It comes from
// tests/lib/harness/source-scan.ts, shared with eight other structural guards;
// the two-regex copy that used to sit here carried audit A40, and the URL
// carve-out it spelled with a lookbehind lives in the shared scanner now.
//
// `dialectFor` matters because this sweep walks `.css` as well as `.tsx`, and a
// stylesheet has no line comments and no regex literals: reading the slash in
// `calc(100% / 3)` as the start of one would skip real text.

/** Repo-relative, forward-slashed — the shape NOT_YET_CONVERTED is keyed by. */
function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function isMarketing(rel: string): boolean {
  return rel === MARKETING_PAGE || rel.startsWith(MARKETING_DIR);
}

function walk(dir: string, found: string[]): string[] {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (entry.isFile() && /\.(tsx?|css)$/.test(entry.name)) {
      found.push(full);
    }
  });
  return found;
}

/** Every scanned file, marketing excluded. */
function scannedFiles(): string[] {
  const found: string[] = [];
  SCANNED_ROOTS.forEach((root) => walk(root, found));
  return found.concat(EXTRA_SCANNED_FILES).filter((file) => !isMarketing(relPath(file)));
}

/**
 * For each line, the index of the `rtl-physical-ok` marker that exempts it, or
 * -1. A marker counts on its own line, or from a comment-only block sitting
 * directly above — "comment-only" meaning the line has raw text but nothing
 * survives stripComments, so a blank line or real code ends the block.
 */
function exemptionFor(rawLines: string[], strippedLines: string[]): number[] {
  return rawLines.map((raw, i) => {
    if (raw.includes(PHYSICAL_OK_MARKER)) return i;
    for (let back = i - 1; back >= 0; back--) {
      const isCommentOnly =
        strippedLines[back].trim().length === 0 && rawLines[back].trim().length > 0;
      if (!isCommentOnly) return -1;
      if (rawLines[back].includes(PHYSICAL_OK_MARKER)) return back;
    }
    return -1;
  });
}

type HitScan = {
  /** "path:line — physical (use logical)", marker-exempt lines removed. */
  hits: string[];
  /** Same, ignoring markers entirely. */
  hitsIgnoringMarkers: string[];
  /** Line indices carrying a marker that suppressed at least one hit. */
  usedMarkers: Set<number>;
  /** Line indices carrying a marker at all. */
  allMarkers: number[];
};

function scanFile(file: string): HitScan {
  const rel = relPath(file);
  const source = fs.readFileSync(file, "utf8");
  const rawLines = source.split("\n");
  const strippedLines = stripComments(source, dialectFor(file)).split("\n");
  const exemptions = exemptionFor(rawLines, strippedLines);

  const hits: string[] = [];
  const hitsIgnoringMarkers: string[] = [];
  const usedMarkers = new Set<number>();
  const allMarkers: number[] = [];

  rawLines.forEach((raw, i) => {
    if (raw.includes(PHYSICAL_OK_MARKER)) allMarkers.push(i);
  });

  strippedLines.forEach((line, i) => {
    PHYSICAL_UTILITIES.forEach(({ physical, logical, pattern }) => {
      if (!pattern.test(line)) return;
      const hit = `${rel}:${i + 1} — ${physical} (use ${logical})`;
      hitsIgnoringMarkers.push(hit);
      if (exemptions[i] >= 0) usedMarkers.add(exemptions[i]);
      else hits.push(hit);
    });
  });

  return { hits, hitsIgnoringMarkers, usedMarkers, allMarkers };
}

describe("the RTL mirror (shell and pages alike)", () => {
  it("uses no physical direction utilities in any rendered surface", () => {
    const offenders: string[] = [];

    scannedFiles().forEach((file) => {
      if (NOT_YET_CONVERTED.has(relPath(file))) return;
      scanFile(file).hits.forEach((hit) => offenders.push(hit));
    });

    expect(
      offenders,
      `Physical direction utilities pin these to one side, so the page does not mirror for Urdu:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("still finds an unconverted utility in every file the allowlist excuses", () => {
    const stale: string[] = [];

    Array.from(NOT_YET_CONVERTED.entries()).forEach(([rel, reason]) => {
      const file = path.join(REPO_ROOT, rel);
      // A deleted or renamed file is just as stale as a cleaned one.
      if (!fs.existsSync(file) || scanFile(file).hits.length === 0) {
        stale.push(`${rel} (allowlisted for ${reason})`);
      }
    });

    expect(
      stale,
      `These are clean now — delete them from NOT_YET_CONVERTED so the guard covers them:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("markers all still suppress something", () => {
    const stale: string[] = [];

    scannedFiles().forEach((file) => {
      const { usedMarkers, allMarkers } = scanFile(file);
      allMarkers.forEach((line) => {
        if (!usedMarkers.has(line)) {
          stale.push(`${relPath(file)}:${line + 1}`);
        }
      });
    });

    expect(
      stale,
      `A ${PHYSICAL_OK_MARKER} comment no longer sits on a physical utility. Delete it — an excuse that outlives its reason is how the next one gets waved through:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the marketing exclusion tied to an actual marketing surface", () => {
    // The only reason app/page.tsx and components/landing are out of scope is
    // that they are one fixed-direction brochure. If that stops being true the
    // exclusion has to fail loudly, not keep an Urdu-facing page unwatched.
    const landing = fs.readFileSync(path.join(REPO_ROOT, MARKETING_PAGE), "utf8");
    expect(landing, `${MARKETING_PAGE} no longer declares itself a marketing surface`).toMatch(
      /data-marketing/
    );
    expect(landing, `${MARKETING_PAGE} no longer pins its own theme`).toMatch(/data-theme="light"/);
    expect(fs.existsSync(path.join(REPO_ROOT, MARKETING_DIR)), `${MARKETING_DIR} is gone`).toBe(
      true
    );
  });

  it("mirrors every horizontal chevron and arrow", () => {
    // A chevron pointing along the axis of travel is direction-of-travel
    // signage, not decoration: unrotated, it points back the way you came in
    // RTL. Vertical chevrons (ChevronDown on the Finance group) are excluded
    // because an up/down glyph means the same thing either way, and the logo is
    // excluded for the opposite reason — mirroring it renders the brand
    // backwards.
    //
    // Arrow{Left,Right} is the same bug wearing a different glyph — the chat
    // header's mobile "Back to channels" arrow has to point at the rail, and
    // the rail moves; so does the "Next month" chevron on the task calendar and
    // the "Continue" arrow on every auth CTA. Icons that DEPICT something
    // rather than point at it (Hash, Lock, an Avatar) are correctly absent from
    // this pattern: a backwards padlock reads as a rendering fault, not as
    // direction.
    const unmirrored: string[] = [];

    scannedFiles().forEach((file) => {
      // The allowlist excuses the same files here that it excuses above — they
      // are unconverted as a whole, glyphs included, and each names its arrows
      // in its reason string.
      if (NOT_YET_CONVERTED.has(relPath(file))) return;
      const source = stripComments(fs.readFileSync(file, "utf8"), dialectFor(file));
      const tags = source.match(/<(?:Chevrons?|Arrow)(?:Left|Right)\b[^>]*>/g) ?? [];
      tags.forEach((tag) => {
        if (!tag.includes("rtl:rotate-180")) {
          unmirrored.push(`${relPath(file)} — ${tag.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      });
    });

    expect(
      unmirrored,
      `Horizontal chevrons and arrows need rtl:rotate-180 or they point the wrong way in Urdu:\n${unmirrored.join("\n")}`
    ).toEqual([]);
  });
});

describe("the comment stripper this guard reads through (audit A40)", () => {
  /**
   * This guard can only report what its stripper leaves visible, so the
   * stripper is part of the guard and gets its own test.
   *
   * The two-regex shape it used to carry blanked BLOCK comments first, over text
   * that still contained line comments. A line comment that merely mentioned a
   * block-comment opener therefore opened a block, which the pattern closed at
   * the next block-comment closer — blanking every line in between and every
   * class string on them. Measured in the tree at ONE site, not the two an
   * earlier version of this comment claimed: lib/auth/channel-permissions.ts:98
   * mentions a glob containing a block-comment opener, and the next closer is at :115, so :98-:115 went
   * blank — eighteen lines, six of them real code, and those six are
   * `visibleChannelWhere`'s own `return`. lib/actions/team.ts was named too and
   * is not affected: its only unpaired opener has no closer after it anywhere, so
   * the lazy pattern never matched. See tests/lib/harness/source-scan.ts.
   *
   * Driven end-to-end through scanFile() on a real temporary file rather than
   * against the stripper alone, because the thing at risk is this guard's hit
   * list, not a helper's return value.
   */
  it("still reports a physical utility below a line comment that mentions a block opener", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-rtl-strip-"));
    const file = path.join(dir, "sample.tsx");
    fs.writeFileSync(
      file,
      [
        "export function Sample() {",
        "  // the opener /* in this sentence never closes on this line",
        '  return <div className="ml-4" />;',
        "}",
        "/* and this closer sits further down the file */",
        "",
      ].join("\n"),
      "utf8"
    );
    try {
      expect(scanFile(file).hitsIgnoringMarkers.join("\n")).toContain("ml-/mr-");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let prose about a class count as a class", () => {
    // The other direction, and the reason the stripper exists at all: this very
    // file discusses left-0 and border-r in its own comments.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-rtl-prose-"));
    const file = path.join(dir, "sample.tsx");
    fs.writeFileSync(
      file,
      [
        "/** Prose mentioning ml-4 and text-left and border-r. */",
        "export function Sample() {",
        "  // and a line comment mentioning pl-2",
        '  return <div className="ps-2" />;',
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    try {
      expect(scanFile(file).hitsIgnoringMarkers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shellBootstrap (pre-paint direction)", () => {
  const rootLayout = fs.readFileSync(path.join(REPO_ROOT, "app", "layout.tsx"), "utf8");

  it("pins an explicit dir on the html element", () => {
    // Without this the server emits direction-ambiguous HTML and an RTL user
    // gets a full left-to-right first paint before the bootstrap corrects it.
    expect(rootLayout).toMatch(/<html[^>]*\sdir="ltr"/);
  });

  it("carries the same rtl locales as the dictionary", () => {
    // The <head> script cannot import, so it restates the RTL set. Parse its
    // literal back out and hold it against the real source of truth: adding a
    // third locale without updating the bootstrap fails here rather than
    // shipping an Arabic workspace that renders left-to-right until hydration.
    const declared = rootLayout.match(/var RTL_LOCALES = \[([^\]]*)\]/);
    expect(declared, "shellBootstrap no longer declares var RTL_LOCALES = [...]").toBeTruthy();

    const bootstrapLocales = (declared?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter((entry) => entry.length > 0);

    const dictionaryLocales = SUPPORTED_LOCALES.filter((l) => l.dir === "rtl").map((l) => l.code);

    // Iterate both directions rather than comparing lengths, so a failure names
    // the locale that drifted instead of a count.
    dictionaryLocales.forEach((code) => {
      expect(bootstrapLocales, `SUPPORTED_LOCALES marks "${code}" rtl`).toContain(code);
    });
    bootstrapLocales.forEach((code) => {
      expect(dictionaryLocales, `shellBootstrap treats "${code}" as rtl`).toContain(code);
    });
  });
});
