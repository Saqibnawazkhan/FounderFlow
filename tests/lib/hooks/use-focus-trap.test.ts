/**
 * The two pure decisions behind the command palette's focus trap.
 *
 * HONESTY NOTE (this repo's rule 3): these were written AFTER the hook, so
 * unlike tests/components/command-palette.test.tsx's dialog block — which failed
 * red against the unfixed palette — they are regression guards rather than
 * evidence of a fix. They exist because the palette itself has exactly ONE tab
 * stop (the combobox; the result rows are `tabindex="-1"` by design), so the
 * component test cannot exercise the wrap-around across several stops, and the
 * next dialog to use this hook will depend on it.
 */

import { describe, it, expect } from "vitest";
import { focusableWithin, nextTrapStop, hideBackgroundFrom } from "@/lib/hooks/use-focus-trap";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("focusableWithin", () => {
  it("keeps real tab stops and drops the ones the dialog has taken out of the order", () => {
    const root = mount(`
      <button id="first">a</button>
      <button id="opt" tabindex="-1">row</button>
      <button id="off" disabled>disabled</button>
      <input id="hidden" type="hidden" />
      <div aria-hidden="true"><button id="behind">hidden subtree</button></div>
      <a id="link" href="/x">link</a>
      <a id="nohref">not a stop</a>
      <input id="last" />
    `);

    expect(focusableWithin(root).map((el) => el.id)).toEqual(["first", "link", "last"]);
  });
});

describe("nextTrapStop", () => {
  const stops = [
    document.createElement("button"),
    document.createElement("input"),
    document.createElement("a"),
  ];

  it("wraps forwards off the end and backwards off the front", () => {
    expect(nextTrapStop(stops, stops[0], false)).toBe(stops[1]);
    expect(nextTrapStop(stops, stops[2], false)).toBe(stops[0]);
    expect(nextTrapStop(stops, stops[0], true)).toBe(stops[2]);
    expect(nextTrapStop(stops, stops[1], true)).toBe(stops[0]);
  });

  it("pulls focus back in when it is currently outside the dialog", () => {
    // `document.body` is where focus sits after a click on the backdrop, and
    // null is what a detached element leaves behind.
    expect(nextTrapStop(stops, document.body, false)).toBe(stops[0]);
    expect(nextTrapStop(stops, null, true)).toBe(stops[2]);
  });

  it("answers nothing rather than throwing when the dialog has no tab stops", () => {
    expect(nextTrapStop([], null, false)).toBeNull();
  });
});

describe("hideBackgroundFrom", () => {
  it("hides every subtree beside the dialog at every depth, and restores exactly what was there", () => {
    const root = mount(`
      <div id="sidebar"><a href="/x">nav</a></div>
      <div id="column">
        <header id="topbar" aria-hidden="true">decorative already</header>
        <main id="main">page</main>
        <div id="dialog"><input /></div>
      </div>
    `);
    const dialog = root.querySelector("#dialog") as HTMLElement;

    const restore = hideBackgroundFrom(dialog);

    // A sibling one level up, and two at three levels up: `#main` alone — the
    // single obvious target — would have left the sidebar's links reachable.
    for (const id of ["sidebar", "topbar", "main"]) {
      const el = root.querySelector(`#${id}`) as HTMLElement;
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.hasAttribute("inert")).toBe(true);
    }
    // Ancestors of the dialog are not marked — marking one would hide the dialog.
    expect((root.querySelector("#column") as HTMLElement).hasAttribute("aria-hidden")).toBe(false);
    expect(dialog.hasAttribute("aria-hidden")).toBe(false);

    restore();

    // The topbar's own decorative aria-hidden survives the round trip; the two
    // that had none end up with none.
    expect(root.querySelector("#topbar")).toHaveAttribute("aria-hidden", "true");
    expect((root.querySelector("#topbar") as HTMLElement).hasAttribute("inert")).toBe(false);
    for (const id of ["sidebar", "main"]) {
      const el = root.querySelector(`#${id}`) as HTMLElement;
      expect(el.hasAttribute("aria-hidden")).toBe(false);
      expect(el.hasAttribute("inert")).toBe(false);
    }
  });
});
