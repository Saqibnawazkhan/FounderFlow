import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { COLOR_CLASSES } from "@/components/projects/project-card";
import { PROJECT_COLORS } from "@/lib/schemas/project";

const REPO_ROOT = path.resolve(__dirname, "../..");

// The pre-rebrand palette. These were baked into components as literals rather
// than read from a token, which is exactly why the rebrand needed a sweep: a
// stray one renders the old brand next to the new one and nobody notices until
// a customer screenshots it.
const RETIRED_HEXES = ["#b6f425", "#1E1B4B", "#312E81", "#14B8A6", "#2DD4BF"];

// Directories that hold authored source. Anything generated or vendored is
// skipped — a retired hex inside a dependency is not ours to fix.
const SOURCE_DIRS = ["app", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(path.join(dir, entry.name), found);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

describe("brand palette (the rebrand's one-way door)", () => {
  // Walks the tree rather than checking a fixed list of files, so a component
  // added after the rebrand is covered the day it lands. A failure means
  // someone reintroduced an old brand colour as a literal; the message names
  // the file and the hex so it is a one-line fix, not a hunt.
  it("no source file hardcodes a retired brand hex", () => {
    const offenders: string[] = [];

    for (const dirName of SOURCE_DIRS) {
      const dir = path.join(REPO_ROOT, dirName);
      if (!fs.existsSync(dir)) continue;

      for (const file of collectSourceFiles(dir)) {
        const contents = fs.readFileSync(file, "utf8").toLowerCase();
        for (const hex of RETIRED_HEXES) {
          if (contents.includes(hex.toLowerCase())) {
            offenders.push(`${path.relative(REPO_ROOT, file)} contains ${hex}`);
          }
        }
      }
    }

    expect(offenders, `retired brand hex found in:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("PROJECT_COLORS (the persisted project swatch palette)", () => {
  // Iterates the tuple instead of naming the five slugs, so adding a sixth
  // colour without a class mapping fails here rather than shipping a project
  // card with a blank stripe and a fallback accent.
  it("every PROJECT_COLORS slug has a class mapping", () => {
    const unmapped = PROJECT_COLORS.filter((slug) => COLOR_CLASSES[slug] === undefined);

    expect(
      unmapped,
      `PROJECT_COLORS slugs missing a COLOR_CLASSES entry: ${unmapped.join(", ")}`
    ).toEqual([]);

    for (const slug of PROJECT_COLORS) {
      const classes = COLOR_CLASSES[slug];
      expect(classes.stripe, `${slug} stripe class`).toBeTruthy();
      expect(classes.text, `${slug} text class`).toBeTruthy();
      expect(classes.chipBg, `${slug} chip background class`).toBeTruthy();
    }
  });

  // Guards the rebrand_project_colors migration. These slugs live in Postgres,
  // so if one creeps back into the tuple the migration's mapping no longer
  // covers everything the app can write and old and new slugs coexist in the
  // column.
  it("no retired colour slug survives in PROJECT_COLORS", () => {
    for (const retired of ["primary", "cyan", "pink", "info"]) {
      expect(PROJECT_COLORS, `retired slug "${retired}" is back in the palette`).not.toContain(
        retired
      );
    }
  });
});
