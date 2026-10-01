// @vitest-environment jsdom
/**
 * rep-012 — /reports' loading skeleton must approximate the page it stands in for.
 *
 * WHAT WENT WRONG. `app/(app)/reports/loading.tsx` painted a `StatGridSkeleton
 * count={4}` and a 2:1 chart grid. The settled page
 * (app/(app)/reports/reports-client.tsx) has NO stat cards at all, and lays out
 * one FULL-WIDTH chart section, then a 1:1 pair of chart sections, then a table.
 * So every navigation to Reports painted four KPI cards that never arrive,
 * implying numbers the page does not have, and then reflowed the whole column
 * when the real sections replaced them.
 *
 * The container width was the OTHER half of this finding and it is already fixed:
 * both files are `max-w-[1600px]`, and tests/app/loading/skeleton-width.test.ts
 * pairs them so they cannot drift again. Equal width kills the sideways jump;
 * this file is about the vertical one and about the phantom cards.
 *
 * WHAT A TEST CAN AND CANNOT PROVE HERE (house rule 15). jsdom computes no boxes
 * and does not compile Tailwind, so nothing here can prove the two paints are the
 * same height — that needs a browser. What it CAN prove is the structural input
 * that decides it: how many chart blocks, how many columns the grid declares,
 * whether a table placeholder exists, and whether a stat grid is present. Those
 * are counts and class tokens, read off real rendered DOM, and a wrong one is a
 * guaranteed reflow. Colours are deliberately not asserted this way.
 *
 * The class tokens below are the signatures of components/ui/skeleton.tsx:
 *   StatGridSkeleton count={4} → a grid declaring `lg:grid-cols-4`
 *   ChartSkeleton              → `h-72`
 *   TableSkeleton              → a `divide-y` row stack
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ReportsLoading from "@/app/(app)/reports/loading";

function renderLoading(): HTMLElement {
  const { container } = render(<ReportsLoading />);
  return container;
}

/** Elements whose class list contains `token`, escaped for a CSS selector. */
function byToken(root: HTMLElement, token: string): Element[] {
  return Array.from(root.querySelectorAll(`[class~="${token}"]`));
}

describe("the skeleton renders at all — guard the guard", () => {
  it("produces DOM with pulsing placeholders in it", () => {
    // Without this, every "there is no stat grid" assertion below would pass
    // against an empty render and the file would read as coverage of nothing.
    const container = renderLoading();
    expect(byToken(container, "animate-pulse").length).toBeGreaterThan(5);
  });
});

describe("rep-012 — no phantom metric cards", () => {
  it("renders no stat-card grid, because the settled page has no stat cards", () => {
    const container = renderLoading();
    expect(byToken(container, "lg:grid-cols-4")).toHaveLength(0);
  });

  it("does not import or render StatGridSkeleton", () => {
    // The behavioural case above is the contract; this stops the component being
    // re-imported with a different `count` and slipping through on a token.
    //
    // Comments are stripped first, and that is not a convenience: the file's own
    // header explains why the stat grid is gone, and an assertion over raw text
    // made naming the mistake in prose indistinguishable from making it. Same
    // `stripComments` reasoning as tests/app/loading/skeleton-width.test.ts.
    const source = readFileSync(
      join(process.cwd(), "app", "(app)", "reports", "loading.tsx"),
      "utf8"
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .map((line) => {
        const i = line.indexOf("//");
        return i === -1 ? line : line.slice(0, i);
      })
      .join("\n");
    expect(code).not.toMatch(/StatGridSkeleton/);
  });
});

describe("rep-012 — the section shapes match the settled page", () => {
  it("opens with a full-width chart block, outside any column grid", () => {
    const container = renderLoading();
    const charts = byToken(container, "h-72");
    expect(charts.length).toBeGreaterThan(0);
    const first = charts[0];
    // The settled page's cash-flow section is a full-width <section>; a chart
    // placeholder nested in a multi-column grid would paint at half width.
    expect(first.closest('[class~="lg:grid-cols-2"]')).toBeNull();
  });

  it("follows it with a 1:1 pair of chart blocks, not a 2:1 split", () => {
    const container = renderLoading();
    const grids = byToken(container, "lg:grid-cols-2");
    expect(grids).toHaveLength(1);
    // A 2:1 split is expressed as lg:grid-cols-3 + lg:col-span-2 — the shape this
    // finding is about. Neither token may survive.
    expect(byToken(container, "lg:grid-cols-3")).toHaveLength(0);
    expect(byToken(container, "lg:col-span-2")).toHaveLength(0);
    const pair = grids[0];
    expect(Array.from(pair.querySelectorAll('[class~="h-72"]'))).toHaveLength(2);
  });

  it("ends with a table placeholder for the founder-wise breakdown", () => {
    const container = renderLoading();
    // TableSkeleton's row stack. The settled page's last section is a full-width
    // <table>, and the skeleton previously stopped at the charts — so the table's
    // whole height arrived as a jump.
    expect(byToken(container, "divide-y").length).toBeGreaterThan(0);
  });

  it("has exactly three chart blocks: one wide, then the pair", () => {
    const container = renderLoading();
    expect(byToken(container, "h-72")).toHaveLength(3);
  });
});

describe("the settled page really has the shape being matched", () => {
  const SETTLED = readFileSync(
    join(process.cwd(), "app", "(app)", "reports", "reports-client.tsx"),
    "utf8"
  );

  it("lays out one lg:grid-cols-2 pair and no stat grid", () => {
    // The pairing that makes the assertions above meaningful rather than
    // arbitrary. If /reports gains stat cards, this goes red and whoever added
    // them is pointed at the skeleton.
    expect(SETTLED).toMatch(/lg:grid-cols-2/);
    expect(SETTLED).not.toMatch(/StatGridSkeleton|DashboardStat/);
  });

  it("ends in a table", () => {
    expect(SETTLED).toMatch(/<table\b/);
  });
});
