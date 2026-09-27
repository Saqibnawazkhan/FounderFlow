import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_LOCALES } from "@/lib/i18n/strings";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * RTL guard for the app shell (audit S20).
 *
 * WHAT THIS CAN PROVE: jsdom has no layout engine — it never computes a box, so
 * no test here can assert that the sidebar actually lands on the right in Urdu.
 * What IS mechanically checkable is the input to that layout: whether the shell
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
 * The scan walks DIRECTORIES rather than naming files, so a component added
 * next month is covered the day it lands.
 */

/**
 * components/chat joins components/layout because the chat rail is shell in
 * everything but folder: it is a fixed-width column the conversation is
 * offset against, so a physical utility in it mirrors exactly as badly as one
 * in the sidebar — the rail ends up overlaying the messages in Urdu.
 */
const SCANNED_DIRS = [
  path.join(REPO_ROOT, "components", "layout"),
  path.join(REPO_ROOT, "components", "chat"),
];

/** Shell files that live outside the scanned dirs but frame every page. */
const EXTRA_SHELL_FILES = [
  path.join(REPO_ROOT, "app", "layout.tsx"),
  path.join(REPO_ROOT, "app", "globals.css"),
  // The authenticated shell. It reserves the gutter the fixed sidebar occupies,
  // so its offset and the sidebar's `start-0` have to name the same edge or the
  // two land on opposite sides of the viewport.
  path.join(REPO_ROOT, "app", "(app)", "layout.tsx"),
];

/**
 * Physical utilities and the logical utility that replaces each. Tailwind 3.4
 * (see package.json) ships every logical variant named here — ms/me and ps/pe
 * since v3.0, start/end, border-s/border-e and text-start/text-end since v3.3 —
 * so there is no polyfill gap to justify a physical class in the shell.
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
 * Scanned files that are NOT converted yet, keyed by repo-relative path. Each
 * belongs to a different row of the audit and a different owner, so no single
 * S20 agent could touch them.
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

/**
 * Blanks out comments while preserving line numbering, so prose discussing
 * left-0 or border-r — which this file and the components it scans both do —
 * cannot masquerade as a class. The (?<!:) guard keeps https:// intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Repo-relative, forward-slashed — the shape NOT_YET_CONVERTED is keyed by. */
function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function shellFiles(): string[] {
  const found: string[] = [];
  SCANNED_DIRS.forEach((dir) => {
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(tsx?|css)$/.test(e.name))
      .forEach((e) => found.push(path.join(dir, e.name)));
  });
  return found.concat(EXTRA_SHELL_FILES);
}

/** Every physical-utility hit in a file, as "path:line — physical (use logical)". */
function physicalHits(file: string): string[] {
  const rel = relPath(file);
  const hits: string[] = [];
  stripComments(fs.readFileSync(file, "utf8"))
    .split("\n")
    .forEach((line, i) => {
      PHYSICAL_UTILITIES.forEach(({ physical, logical, pattern }) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1} — ${physical} (use ${logical})`);
      });
    });
  return hits;
}

describe("app shell chrome (the RTL mirror)", () => {
  it("uses no physical direction utilities in the app shell", () => {
    const offenders: string[] = [];

    shellFiles().forEach((file) => {
      if (NOT_YET_CONVERTED.has(relPath(file))) return;
      physicalHits(file).forEach((hit) => offenders.push(hit));
    });

    expect(
      offenders,
      `Physical direction utilities pin these to one side, so the shell does not mirror for Urdu:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("still finds an unconverted utility in every file the allowlist excuses", () => {
    const stale: string[] = [];

    Array.from(NOT_YET_CONVERTED.entries()).forEach(([rel, reason]) => {
      const file = path.join(REPO_ROOT, rel);
      // A deleted or renamed file is just as stale as a cleaned one.
      if (!fs.existsSync(file) || physicalHits(file).length === 0) {
        stale.push(`${rel} (allowlisted for ${reason})`);
      }
    });

    expect(
      stale,
      `These are clean now — delete them from NOT_YET_CONVERTED so the guard covers them:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("mirrors every horizontal chevron and arrow in the shell", () => {
    // A chevron pointing along the axis of travel is direction-of-travel
    // signage, not decoration: unrotated, it points back the way you came in
    // RTL. Vertical chevrons (ChevronDown on the Finance group) are excluded
    // because an up/down glyph means the same thing either way, and the logo is
    // excluded for the opposite reason — mirroring it renders the brand
    // backwards.
    //
    // Arrow{Left,Right} is the same bug wearing a different glyph — the chat
    // header's mobile "Back to channels" arrow has to point at the rail, and
    // the rail moves. Icons that DEPICT something rather than point at it
    // (Hash, Lock, an Avatar) are correctly absent from this pattern: a
    // backwards padlock reads as a rendering fault, not as direction.
    const unmirrored: string[] = [];

    shellFiles().forEach((file) => {
      // The allowlist excuses the same files here that it excuses above — they
      // are unconverted as a whole, glyphs included, and each names its arrows
      // in its reason string.
      if (NOT_YET_CONVERTED.has(relPath(file))) return;
      const source = stripComments(fs.readFileSync(file, "utf8"));
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
