/**
 * The palette's query validator.
 *
 * WHY THIS FILE EXISTS: `SearchQuerySchema` is the only thing standing between
 * a type-ahead box and a full workspace scan per keystroke. Two rules carry
 * that weight — the trim runs BEFORE the length checks, and the floor is two
 * characters, not one — and both are invisible at the call site. A refactor
 * that reorders `.trim()` after `.min()` still type-checks, still passes every
 * hand test anyone would think to run, and quietly turns "   " into a
 * two-character term that matches every row in the company. So the order is
 * pinned here rather than trusted to zod's declaration semantics staying
 * obvious to the next reader.
 */

import { describe, expect, it } from "vitest";
import {
  SEARCH_GROUPS,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  SearchQuerySchema,
  type SearchGroup,
} from "@/lib/schemas/search";

/** The two groups a member never receives — see `canSeeFinances`. */
const FINANCE_GROUPS: SearchGroup[] = ["transaction", "budget"];

describe("SearchQuerySchema (the only validation a palette query gets)", () => {
  it("hands the query on with its surrounding whitespace removed", () => {
    const r = SearchQuerySchema.safeParse({ q: "   runway   " });
    expect(r.success).toBe(true);
    // Not merely "accepted": the PARSED value is what reaches ILIKE and
    // websearch_to_tsquery, and a leading space changes what both of them match.
    expect(r.success && r.data.q).toBe("runway");
  });

  it("rejects a one-character query", () => {
    // The whole point of the floor: one character matches a large fraction of
    // the workspace, costs five scans, and is nobody's actual search.
    expect(SearchQuerySchema.safeParse({ q: "b" }).success).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(SearchQuerySchema.safeParse({ q: "" }).success).toBe(false);
  });

  it("rejects a query that is only whitespace", () => {
    // Two spaces are two characters until the trim runs. If this passes, the
    // trim has moved after the length check and every keystroke-burst of
    // whitespace becomes a workspace-wide scan.
    expect(SearchQuerySchema.safeParse({ q: "  " }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "\t\n " }).success).toBe(false);
  });

  it("rejects a single character padded out to the minimum with spaces", () => {
    expect(SearchQuerySchema.safeParse({ q: " b " }).success).toBe(false);
  });

  it("accepts the shortest real query", () => {
    const shortest = "x".repeat(SEARCH_MIN_LENGTH);
    expect(SearchQuerySchema.safeParse({ q: shortest }).success).toBe(true);
  });

  it("accepts a term sitting exactly on the cap", () => {
    const atCap = "x".repeat(SEARCH_MAX_LENGTH);
    const r = SearchQuerySchema.safeParse({ q: atCap });
    expect(r.success).toBe(true);
    expect(r.success && r.data.q).toHaveLength(SEARCH_MAX_LENGTH);
  });

  it("rejects a term one character past the cap", () => {
    expect(SearchQuerySchema.safeParse({ q: "x".repeat(SEARCH_MAX_LENGTH + 1) }).success).toBe(
      false
    );
  });

  it("measures the cap against the trimmed term, not the raw one", () => {
    // A paste with trailing whitespace is a real search, not an over-length
    // one — the trim happens first, so the padding never counts.
    const padded = `  ${"x".repeat(SEARCH_MAX_LENGTH)}  `;
    expect(SearchQuerySchema.safeParse({ q: padded }).success).toBe(true);
  });

  it("rejects input that is not a query object at all", () => {
    // `searchAction` hands this `unknown` straight off the wire. A missing or
    // non-string `q` has to fail the parse rather than reach the query as
    // `undefined`, where `contains: undefined` would drop the filter entirely
    // and return the first five rows of every table.
    expect(SearchQuerySchema.safeParse({}).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: 42 }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: null }).success).toBe(false);
    expect(SearchQuerySchema.safeParse("runway").success).toBe(false);
  });
});

describe("SEARCH_GROUPS (the searchable content types, in render order)", () => {
  it("names each content type once", () => {
    // A duplicate would render the same section twice and number the palette's
    // keyboard sequence past the end of the list it is walking.
    expect(new Set(SEARCH_GROUPS).size).toBe(SEARCH_GROUPS.length);
  });

  it("orders the finance groups after every group a member can see", () => {
    const open = SEARCH_GROUPS.filter((g) => !FINANCE_GROUPS.includes(g));
    // Iterated rather than compared against a fixed tuple so a sixth content
    // type added tomorrow is covered without editing this test.
    for (const finance of FINANCE_GROUPS) {
      for (const other of open) {
        expect(SEARCH_GROUPS.indexOf(finance)).toBeGreaterThan(SEARCH_GROUPS.indexOf(other));
      }
    }
  });

  it("holds every group the finance gate is expected to withhold", () => {
    for (const finance of FINANCE_GROUPS) {
      expect(SEARCH_GROUPS).toContain(finance);
    }
  });
});
