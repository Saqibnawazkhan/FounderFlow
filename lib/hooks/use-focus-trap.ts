"use client";

/**
 * useFocusTrap — the three things `aria-modal="true"` actually promises.
 *
 * A dialog that declares `role="dialog" aria-modal="true"` has told every
 * assistive technology that nothing outside it exists until it closes. The
 * attribute is a claim, not a mechanism; this hook is the mechanism. It does
 * exactly three things, and each one is a bug we shipped:
 *
 *  1. TAB CANNOT LEAVE. Tab and Shift-Tab cycle the dialog's own tab stops.
 *     Without it, Tab walks out of the sheet and down the page behind — silently,
 *     because the page behind is under a backdrop and the user cannot see where
 *     the caret went.
 *  2. THE PAGE BEHIND IS GONE FROM THE ACCESSIBILITY TREE. Everything that is
 *     not an ancestor or a descendant of the container is marked `aria-hidden`
 *     (the universally supported contract, and what `aria-modal` is asking for)
 *     AND `inert` (which in a supporting browser also removes those subtrees
 *     from the tab order and from pointer events, so the keyboard trap above is
 *     a second line of defence rather than the only one). Both are restored to
 *     their exact previous values on close, so a decorative `aria-hidden` that
 *     was already there stays there.
 *  3. FOCUS COMES BACK. Whatever was focused when the dialog opened — the button
 *     that opened it, nearly always — is focused again when it closes. This is
 *     the part implementations usually miss and the part keyboard users feel
 *     most: without it, focus resets to the top of the document and they start
 *     their journey again.
 *
 * WHY NOT RADIX. `@radix-ui/react-dialog` brings all three (see
 * components/ui/modal.tsx, which is the right answer for a normal modal). The
 * command palette is a combobox whose popup is the dialog, with its own
 * `aria-activedescendant` sequence, its own Escape/Arrow/Enter handler and its
 * own backdrop paint order; wrapping it in Radix means either fighting Radix's
 * auto-focus and dismiss layers or rebuilding the palette around them. This hook
 * is the smaller change, and it leaves the palette's keyboard model — the thing
 * that is already tested — untouched.
 *
 * WHY NO VISIBILITY FILTER in `focusableWithin`. jsdom reports no layout at all
 * (`offsetParent` is null for every element, every rect is 0×0), so a filter on
 * visibility would return an empty list under test and the trap would silently
 * do nothing in exactly the place we verify it. An invisible tab stop inside an
 * open dialog is a bug in the dialog, not something to paper over here.
 */

import { useEffect } from "react";

/**
 * Candidate tab stops. `[tabindex]` is matched broadly and `-1` filtered out
 * below rather than excluded in the selector, so that the one place that decides
 * what "not a tab stop" means is the filter, not a selector string.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

/**
 * Tags that carry no semantics and no focus, so marking them would be noise.
 * An array with `indexOf` rather than a `Set`: tsconfig sets no `target`, so
 * `tsc` compiles to ES5 and iterating a Set is a typecheck error the test suite
 * would not catch.
 */
const NOT_BACKGROUND = ["SCRIPT", "STYLE", "LINK", "META", "TITLE", "BASE", "TEMPLATE"];

/** A ref-shaped argument, structurally — React 18 and 19 type `RefObject` differently. */
type ContainerRef = { readonly current: HTMLElement | null };

/** Every tab stop inside `root`, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const stops: HTMLElement[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.getAttribute("tabindex") === "-1") continue;
    if (el.hasAttribute("disabled")) continue;
    if (el.hasAttribute("hidden")) continue;
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") continue;
    // A subtree the dialog itself hides from assistive tech is not a tab stop.
    if (el.closest('[aria-hidden="true"]')) continue;
    stops.push(el);
  }
  return stops;
}

/**
 * Which stop this Tab press should land on — pure, so the wrap-around is
 * testable without a DOM event.
 *
 * Every press is answered, not just the ones at the ends: the browser's own Tab
 * is right in the middle of the list and wrong at both edges, and one rule is
 * easier to hold in the head than two. `current` outside the list (focus on the
 * page behind, or nowhere at all) pulls focus back in at the near end.
 */
export function nextTrapStop(
  stops: HTMLElement[],
  current: Element | null,
  backwards: boolean
): HTMLElement | null {
  if (stops.length === 0) return null;
  const at = current ? stops.indexOf(current as HTMLElement) : -1;
  if (at === -1) return backwards ? stops[stops.length - 1] : stops[0];
  const target = backwards ? at - 1 + stops.length : at + 1;
  return stops[target % stops.length];
}

/**
 * Hide every subtree that is neither an ancestor nor a descendant of
 * `container` from assistive tech, and return the undo.
 *
 * Walks up to `<body>` marking siblings at each level, rather than marking one
 * known wrapper: the command palette renders inside the topbar, so the sidebar's
 * seventeen links, the topbar's own controls and the page content sit at three
 * different depths, and `#main` alone — the obvious single target — covers only
 * the last of the three.
 */
export function hideBackgroundFrom(container: Element): () => void {
  const undo: Array<() => void> = [];
  let node: Element = container;
  while (node.parentElement && node !== document.body) {
    const siblings = node.parentElement.children;
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === node) continue;
      if (NOT_BACKGROUND.indexOf(sibling.tagName) !== -1) continue;
      undo.push(markHidden(sibling as HTMLElement));
    }
    node = node.parentElement;
  }
  return function restoreBackground() {
    for (let i = 0; i < undo.length; i++) undo[i]();
  };
}

/** Mark one element, remembering precisely what was there before. */
function markHidden(el: HTMLElement): () => void {
  const priorAriaHidden = el.getAttribute("aria-hidden");
  const priorInert = el.getAttribute("inert");
  el.setAttribute("aria-hidden", "true");
  // Empty string, not "true": `inert` is a boolean attribute, and React 18 has
  // no prop for it, which is why this is set on the DOM node directly.
  el.setAttribute("inert", "");
  return () => {
    if (priorAriaHidden === null) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", priorAriaHidden);
    if (priorInert === null) el.removeAttribute("inert");
    else el.setAttribute("inert", priorInert);
  };
}

/**
 * Trap focus inside `containerRef` while `active`, hide the rest of the page
 * from assistive tech, and restore focus to the opener when it deactivates.
 *
 * Escape is deliberately NOT handled here: a dialog decides for itself what
 * Escape means (the palette already closes on it, alongside its arrow keys), and
 * a second listener would fight the first.
 */
export function useFocusTrap(active: boolean, containerRef: ContainerRef): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    // Captured before anything moves focus: this is where focus goes back to.
    const returnTo = document.activeElement as HTMLElement | null;
    const restoreBackground = hideBackgroundFrom(container);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      const next = nextTrapStop(focusableWithin(container!), document.activeElement, e.shiftKey);
      e.preventDefault();
      if (next) next.focus();
    }

    // Capture phase, on the document: a control inside the dialog that stops Tab
    // from bubbling must not be able to switch the trap off.
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Attributes first, focus second: `inert` on an ancestor of `returnTo`
      // would refuse the focus() below.
      restoreBackground();
      if (returnTo && typeof returnTo.focus === "function" && document.contains(returnTo)) {
        returnTo.focus();
      }
    };
  }, [active, containerRef]);
}
