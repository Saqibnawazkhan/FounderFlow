/**
 * lib/chat/anchor.ts — following a mention notification back to its message
 * (chat-010).
 *
 * `sendMessageAction` has always written `/chat/<slug>?message=<id>` into every
 * mention and DM notification, and `lib/queries/search.ts` writes the same shape
 * for a chat hit in the command palette. Nothing in the chat surface read the
 * parameter, so all of them dropped the reader at the bottom of a busy room with
 * nothing anchored.
 *
 * The decision is pinned here rather than in a browser for two reasons: it
 * combines three facts no single component owns — is the target on screen, has
 * the server been asked, did it turn out to be a thread reply the timeline
 * excludes outright — and the thing a browserless test cannot see is precisely
 * the scroll position that would otherwise be the only evidence.
 *
 * RED FIRST, HONESTLY: this module did not exist when this file was written, so
 * its first run failed at the import rather than on an assertion, and the module
 * was written before the assertions rather than after. The two things that make
 * this file worth trusting anyway are elsewhere: the behavioural red for chat-010
 * is in tests/components/chat-client.test.tsx and
 * tests/components/message-list.test.tsx, which were run against the surface as
 * it shipped and failed there; and these cases were themselves proved to fire by
 * reordering the branches in `nextAnchorStep` and watching three of them go red.
 */

import { describe, it, expect } from "vitest";
import { nextAnchorStep, parseMessageAnchor } from "@/lib/chat/anchor";
import type { AnchorState } from "@/lib/chat/anchor";

const ANCHOR = "cjld2cjxh0000qzrmn831i7rn";

function state(over: Partial<AnchorState> = {}): AnchorState {
  return {
    anchorId: ANCHOR,
    loadedIds: [],
    located: false,
    rootId: null,
    ...over,
  };
}

describe("parseMessageAnchor (what the address bar is allowed to say)", () => {
  it("takes an id through unchanged", () => {
    expect(parseMessageAnchor(ANCHOR)).toBe(ANCHOR);
  });

  it("accepts every id shape this system actually mints", () => {
    // lib/schemas/chat.ts refuses to use `.cuid()` for exactly this reason: the
    // app mints cuids, the chat migration's `chmem_…` and the seed's
    // `demo-ahmed`, and asserting one shape broke every DM in the demo
    // workspace.
    for (const id of [ANCHOR, "chmem_01H9", "demo-ahmed", "m1"]) {
      expect(parseMessageAnchor(id)).toBe(id);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(parseMessageAnchor(`  ${ANCHOR}  `)).toBe(ANCHOR);
  });

  it("refuses an absent, empty or whitespace-only param", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(parseMessageAnchor(raw)).toBeNull();
    }
  });

  it("refuses anything that is not an id shape", () => {
    // This value is about to be compared against loaded ids, sent to a server
    // action and written into a DOM id attribute. Rejecting it once here is why
    // none of those three has to think about it.
    for (const raw of [
      "../../etc/passwd",
      '" onmouseover="alert(1)',
      "m1 m2",
      "m1#frag",
      "m1?x=1",
      "<script>",
    ]) {
      expect(parseMessageAnchor(raw)).toBeNull();
    }
  });

  it("refuses an id longer than the schema's own bound", () => {
    expect(parseMessageAnchor("a".repeat(64))).toBe("a".repeat(64));
    expect(parseMessageAnchor("a".repeat(65))).toBeNull();
  });

  it("refuses a REPEATED param instead of silently picking one", () => {
    // `?message=a&message=b` names two messages and there is one viewport.
    // Next hands `string[]` for a repeated key.
    expect(parseMessageAnchor(["m1", "m2"])).toBeNull();
    expect(parseMessageAnchor(["m1"])).toBeNull();
  });
});

describe("nextAnchorStep (what to do about the anchor)", () => {
  it("does nothing when there is no anchor", () => {
    expect(nextAnchorStep(state({ anchorId: null }))).toEqual({ kind: "idle" });
  });

  it("highlights straight away when the message is already on screen", () => {
    // The overwhelmingly common case — a mention from a minute ago is in the
    // first page by definition — and it must cost no round trip.
    expect(nextAnchorStep(state({ loadedIds: ["m_old", ANCHOR, "m_new"] }))).toEqual({
      kind: "highlight",
    });
  });

  it("asks the server where an unknown id lives", () => {
    expect(nextAnchorStep(state({ loadedIds: ["m_other"] }))).toEqual({ kind: "locate" });
  });

  it("never asks twice: once located, the answer is the answer", () => {
    // The caller latches per anchor id, and this is the half of that contract the
    // function owns — a `locate` returned after `located: true` would put the
    // island in a loop.
    expect(nextAnchorStep(state({ loadedIds: ["m_other"], located: true }))).not.toEqual({
      kind: "locate",
    });
  });

  it("opens the thread panel for a reply", () => {
    // `getMessagesPage` excludes `parentId != null`, so a reply is not in the
    // timeline and no amount of scrolling or paging would put it there. This is
    // the case that could not work at all before.
    expect(nextAnchorStep(state({ located: true, rootId: "m_root" }))).toEqual({
      kind: "open-thread",
      rootId: "m_root",
    });
  });

  it("prefers the thread panel even if the reply's id somehow appears loaded", () => {
    // Defensive: if a future timeline query stopped filtering replies out,
    // "scroll to it" and "open the thread it belongs to" would both be arguable,
    // and the panel is the one that shows the conversation the notification was
    // about.
    expect(nextAnchorStep(state({ loadedIds: [ANCHOR], rootId: "m_root" }))).toEqual({
      kind: "open-thread",
      rootId: "m_root",
    });
  });

  it("reports a root that is further back than the loaded page", () => {
    // Not `idle`. A link that lands somewhere and says nothing is the bug being
    // closed, so this has to be a result the reader can be told about — the
    // "Load earlier messages" control is the thing to point them at.
    expect(nextAnchorStep(state({ loadedIds: ["m_other"], located: true }))).toEqual({
      kind: "not-loaded",
    });
  });

  it("highlights once a page of history has brought the message in", () => {
    // The reader pressing "Load earlier messages" is the same input as any other
    // page landing, so the answer has to flip on the loaded set alone.
    const before = state({ loadedIds: ["m_other"], located: true });
    expect(nextAnchorStep(before)).toEqual({ kind: "not-loaded" });
    expect(nextAnchorStep({ ...before, loadedIds: [ANCHOR, "m_other"] })).toEqual({
      kind: "highlight",
    });
  });
});
