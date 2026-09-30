/**
 * The breadcrumb trail must not spell a direct message as its slug.
 *
 * A DM's `Channel.slug` is two user ids joined — `dm-<idA>_<idB>` — because
 * nobody named the conversation and nobody chose a URL for it. `Breadcrumbs`
 * derives its trail from the pathname alone and humanises any segment it has no
 * label for, so the trail read:
 *
 *     Chat > Dm-demo-ali_dmsmoke-ghost-816234
 *
 * That is the chat-008 class in a fifth surface, found by the agent that fixed
 * the other four and reported it as outside its file ownership. This component
 * has only a URL to go on — no `Channel.kind`, no membership rows — which is
 * exactly why the fix drops the crumb instead of relabelling it: the honest
 * label is the counterpart's name, and only the server knows who that is
 * relative to the viewer.
 *
 * WHY THERE IS NO getComputedStyle HERE. Nothing below asks jsdom about layout.
 * Every assertion reads text or ARIA out of the rendered DOM, which jsdom
 * answers correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/** Set per test, before render — the component reads it on every call. */
let pathname = "/chat";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const storeState = { currentUser: { role: "admin" }, locale: "en" as const };
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  useStoreHasHydrated: () => true,
}));

import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { dmSlugFor } from "@/lib/chat/dm";

/** The real thing, built by the module that owns the spelling. */
const DM_SLUG = dmSlugFor("cmdemoali0001:cmdemosaqib0002");

function trail(): string[] {
  // Every crumb is a list item, in document order. The FIRST is the permanent
  // Home link (an icon plus sr-only text), which is not derived from the
  // pathname and is not what any assertion here is about — so it is dropped
  // rather than written into every expectation, where it would read as part of
  // the trail under test.
  return screen
    .getAllByRole("listitem")
    .slice(1)
    .map((li) => (li.textContent ?? "").trim())
    .filter((s) => s.length > 0);
}

describe("Breadcrumbs on a direct message", () => {
  it("does not render the DM's slug anywhere in the trail", () => {
    pathname = `/chat/${DM_SLUG}`;
    render(<Breadcrumbs />);

    const text = document.body.textContent ?? "";

    // ASSERT ON THE IDS, NOT ON THE SLUG VERBATIM. This read
    // `not.toContain(DM_SLUG)` first, and that assertion PASSES against the
    // unfixed component: the humaniser upper-cases the first character, so the
    // rendered crumb is "Dm-cmdemoali0001_…" and does not contain the lowercase
    // "dm-…" it was built from. A `/^Dm-/m` check was no better — `textContent`
    // is one line, so `^` never matched. Both were found by disabling the fix
    // and watching which assertion actually went red, which is the only way to
    // tell a guard from a decoration. What matters to a customer is that neither
    // user id is on their screen, in any casing.
    expect(text, "a raw user id reached the breadcrumb trail").not.toMatch(/cmdemoali0001/i);
    expect(text).not.toMatch(/cmdemosaqib0002/i);
    expect(trail()).toEqual(["Chat"]);
  });

  it("marks Chat as the current page once the DM crumb is dropped", () => {
    // The bug this guards against is a trail that renders a separator and then
    // nothing, with no crumb carrying aria-current — which is what happens if
    // `isLast` is computed before the drop rather than after.
    pathname = `/chat/${DM_SLUG}`;
    render(<Breadcrumbs />);

    const current = screen.getByText("Chat", { selector: "[aria-current='page']" });
    expect(current).toBeInTheDocument();
  });

  it("still shows a NAMED channel's crumb, so the fix is not 'hide every chat leaf'", () => {
    pathname = "/chat/general";
    render(<Breadcrumbs />);

    expect(trail()).toEqual(["Chat", "General"]);
  });

  it("leaves a project id's generic crumb alone", () => {
    // The neighbouring branch in the same expression. If the DM filter is ever
    // widened carelessly, this is what notices.
    pathname = "/projects/clx123abc";
    render(<Breadcrumbs />);

    const crumbs = trail();
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toBe("Projects");
    expect(crumbs[1]).not.toContain("clx123abc");
  });
});
