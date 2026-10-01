/**
 * Structural guard: every authenticated page has a loading skeleton beside it.
 *
 * WHY THIS FILE EXISTS (audit harness-010). The only check on this was
 * `scripts/smoke-loading.mjs`, and it had a hand-written list of 9 of the 15
 * static authenticated routes. The list had stopped growing when the route tree
 * did, and it had drifted precisely onto the gap: /revenue had no `loading.tsx`
 * and was not in the list, so nothing in the suite noticed a route rendering a
 * blank frame during navigation.
 *
 * AN EARLIER VERSION OF THIS PARAGRAPH SAID the script "reported 9/9 routes
 * showed a skeleton". It cannot have, and the correction is worth keeping because
 * it is the same shape as the defect: the old list led with /expenses and
 * /investments (git show HEAD~1:scripts/smoke-loading.mjs), both children of the
 * collapsed FINANCE_GROUP, which have no `<a href>` in the rail at all — so the
 * old script failed to find their links and reported at most 7 of 9. A confident
 * number in a comment, never checked against the thing it describes.
 *
 * A hand-maintained list of routes is the mechanism, not the oversight. This file
 * walks the tree instead, so the next route is covered the day it lands, and it
 * needs no browser and no dev server — the smoke script's route list is now
 * derived the same way, and this test is what catches the case the browser
 * cannot reach.
 *
 * WHAT A MISSING SKELETON COSTS. Next.js suspends the route segment while the
 * page's async work runs. With a `loading.tsx` the user sees the shape of the
 * page; without one they see the previous page frozen, and then a jump. On the
 * money pages that is several hundred milliseconds of a stale balance still on
 * screen.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const APP_GROUP = join(ROOT, "app", "(app)");

/**
 * Pages with no sibling `loading.tsx`, each with the reason.
 *
 * `app/(app)/chat/[slug]` is the one entry and it is a real gap, not an
 * exemption: /chat/[slug] renders the message list, and navigating between
 * channels shows the previous channel's messages until the new ones arrive.
 * Adding the file is an `app/` change and belongs to whoever owns the chat
 * surface; it is recorded here so it is a known number rather than an absence.
 *
 * The staleness test below fails the moment one is added, so an entry cannot
 * outlive its reason.
 */
const NO_SKELETON_YET = new Map<string, string>([
  [
    "app/(app)/chat/[slug]",
    "no loading.tsx — switching channels holds the previous channel's messages on screen. Needs an app/ change by the chat owner.",
  ],
]);

function pageDirs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pageDirs(full, found);
    else if (entry.name === "page.tsx") found.push(dirname(full));
  }
  return found;
}

function rel(p: string): string {
  return relative(ROOT, p).split(sep).join("/");
}

describe("loading skeletons (audit harness-010)", () => {
  const dirs = pageDirs(APP_GROUP).map(rel).sort();

  it("found the pages at all", () => {
    // Guards the guard: both assertions below iterate this list, so an empty
    // walk is a green suite that inspected nothing. There were 17 pages in the
    // group when this was written.
    expect(dirs.length, "almost no page was found under app/(app)").toBeGreaterThan(12);
    expect(dirs).toContain("app/(app)/dashboard");
    // The two dynamic routes are the ones the browser smoke cannot reach, so
    // their presence here is the point of this file existing.
    expect(dirs).toContain("app/(app)/chat/[slug]");
    expect(dirs).toContain("app/(app)/projects/[id]");
  });

  it("every page has a sibling loading.tsx", () => {
    const missing = dirs
      .filter((d) => !NO_SKELETON_YET.has(d))
      .filter((d) => !existsSync(join(ROOT, d.split("/").join(sep), "loading.tsx")));
    expect(
      missing,
      "These routes render the previous page's content while they load, because " +
        "Next.js has no skeleton to suspend into:\n" +
        missing.join("\n")
    ).toEqual([]);
  });

  it("every exempted page is still missing its skeleton", () => {
    // Staleness guard. A loading.tsx that lands while its entry stays here means
    // the next reader believes a gap exists that does not.
    const stale: string[] = [];
    Array.from(NO_SKELETON_YET.entries()).forEach(([d, reason]) => {
      const dirPath = join(ROOT, d.split("/").join(sep));
      if (!existsSync(dirPath)) {
        stale.push(`${d} no longer exists (listed as: ${reason})`);
      } else if (existsSync(join(dirPath, "loading.tsx"))) {
        stale.push(`${d} has a loading.tsx now (listed as: ${reason})`);
      }
    });
    expect(
      stale,
      "Delete these from NO_SKELETON_YET — an exemption that outlives its reason is " +
        "how the next missing skeleton gets waved through:\n" +
        stale.join("\n")
    ).toEqual([]);
  });

  it("the smoke script derives its route list rather than hard-coding one", () => {
    // The other half of harness-010: the browser check had a hand-written list
    // of 9 routes. If it goes back to a literal array, this file's coverage says
    // nothing about what the browser actually visits.
    const smokePath = join(ROOT, "scripts", "smoke-loading.mjs");
    expect(existsSync(smokePath), "scripts/smoke-loading.mjs is gone").toBe(true);
    const src = readFileSync(smokePath, "utf8");
    expect(src, "smoke-loading.mjs no longer walks app/(app) for its routes").toMatch(
      /readdirSync/
    );
    expect(
      src,
      "smoke-loading.mjs counts `.animate-pulse` absolutely again — the shell loader " +
        "and the clock widget satisfy that without any loading.tsx rendering"
    ).toMatch(/baseline/);
  });
});
