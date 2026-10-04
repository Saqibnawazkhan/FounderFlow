/**
 * `/chat/<slug>?message=<id>` — following a mention back to the message it was
 * about (chat-010).
 *
 * THE LINK ALREADY EXISTED AT BOTH ENDS BUT NOT IN THE MIDDLE.
 * `sendMessageAction` writes `/chat/${slug}?message=${created.id}` into every
 * mention notification and every DM notification, and `lib/queries/search.ts`
 * builds the same shape for a chat hit in the command palette. Nothing under
 * `app/(app)/chat/**` or `components/chat/**` read that parameter, so every one
 * of those links dropped the reader at the bottom of a busy room with nothing
 * anchored and left them to find the message by scrolling. `?taskId=` and
 * `?transactionId=` are both honoured on their own surfaces; this one was not.
 *
 * WHY A MODULE OF ITS OWN, AND WHY IT IS PURE. Three facts have to be combined
 * to decide what to do — whether the target is in the page the reader already
 * has, whether the server has been asked about it, and whether it turned out to
 * be a thread reply that is not in the timeline AT ALL. Written inline in
 * <ChatClient> that is an effect whose branches nothing can see, in a component
 * whose scroll position jsdom does not have. Here it is a function of its
 * inputs, `tests/lib/chat/anchor.test.ts` pins every branch, and the island
 * keeps only the plumbing.
 *
 * WHY THE TIMELINE IS NOT ENOUGH ON ITS OWN. `getMessagesPage` returns the
 * newest 50 ROOTS (`parentId: null`), so two kinds of target are missing from a
 * freshly loaded channel: a root older than that page, and — whatever the age —
 * any reply inside a thread, which the timeline excludes by design.
 *
 * THE FIRST IS NOW SERVED UPSTREAM, which is the one thing about this module
 * that has changed since it was written: `app/(app)/chat/[slug]/page.tsx` reads
 * the same `?message=` parameter and asks `getMessagesPageAnchoredAt` for the
 * window CONTAINING the anchor, so an old root arrives already in the page and
 * this module answers `highlight` for it. `not-loaded` survives as the fallback
 * for the server render and the client lookup disagreeing — see its own note
 * below, which says that rather than claiming to be the ordinary path.
 *
 * The second is not reachable from the timeline at ANY depth — no window can
 * contain a row the query filters out — which is why `open-thread` is a step of
 * its own rather than "keep looking".
 */

/**
 * The longest id this will carry, matching `MessageIdField` in
 * lib/schemas/chat.ts. A shape check, not an authorisation check: the server
 * re-resolves the id against the reader's own company either way.
 */
const MAX_ANCHOR_ID_LENGTH = 64;

/**
 * The id characters this system actually mints. `cuid()`, the chat migration's
 * `chmem_…` and the seed's `demo-ahmed` between them use letters, digits,
 * hyphen and underscore, and nothing else — so this is deliberately narrower
 * than "any string" and deliberately wider than `.cuid()`, which
 * lib/schemas/chat.ts explains at length broke every DM in the demo workspace.
 */
const ANCHOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Read the `message` search param into an id, or null.
 *
 * WHY IT SANITISES RATHER THAN TRUSTING. The value comes from the address bar,
 * and it is about to be compared against loaded ids, handed to a server action,
 * and written into a DOM `id` attribute. Rejecting anything that is not an id
 * shape here means none of those three has to think about it.
 *
 * A REPEATED PARAM IS REFUSED, not resolved to its first value.
 * `?message=a&message=b` names two messages and there is one viewport; picking
 * one silently would scroll to a message the link did not unambiguously ask for.
 * `URLSearchParams.get` already returns only the first, so this is about the
 * caller that passes an array — Next's `searchParams` hands `string[]` for a
 * repeated key.
 */
export function parseMessageAnchor(raw: string | string[] | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_ANCHOR_ID_LENGTH) return null;
  if (!ANCHOR_ID_PATTERN.test(id)) return null;
  return id;
}

/**
 * What the surface should do about the anchor.
 *
 * `idle` — there is no anchor.
 * `highlight` — the target is in the loaded timeline; mark it and scroll to it.
 * `locate` — ask the server where this id lives (a root, or a reply's root).
 * `open-thread` — it is a reply; the panel is the only place it renders.
 * `not-loaded` — it is a root that is not in the loaded page, and the server
 *                was supposed to have put it there.
 *
 * FOUR OF THE FIVE HAVE A CALLER IN <ChatClient>; `idle` does not, and saying
 * "every one of these does" was the defect this module's own next sentence is
 * about. <ChatClient> returns before calling this function unless `anchorId` is
 * truthy, and both call sites pass a non-null id, so the `idle` branch is reached
 * only by tests/lib/chat/anchor.test.ts. It is kept deliberately and not as an
 * oversight: this is a total function over `AnchorState`, `anchorId` is typed
 * nullable, and a pure decision that answers every input it accepts is worth more
 * than one that makes its callers pre-filter — the caller's guard can move, and
 * then the missing branch is a crash rather than an `idle`. What it must not do is
 * claim to be load-bearing when it is a base case.
 *
 * The rest of this paragraph is the part that stands: an
 * earlier version of this module also had a `load-older` step and a page cap, so
 * the island could walk backwards through history until the anchor appeared. It
 * was written and tested, and the effect that drove it hung the chat-client test
 * file whenever the earlier blocks in it had run first. Both the step and its
 * machinery were removed rather than left in as a branch nothing reaches — that is
 * this codebase's signature defect and not one to add to on purpose.
 *
 * WHAT CLOSED IT INSTEAD, and the reason the loop is not missed: the RSC fetches
 * the window containing the anchor ONCE, before this component exists
 * (`getMessagesPageAnchoredAt`). Same outcome, no client state machine, nothing
 * to wedge. `not-loaded` keeps the toast as the fallback for the two renders
 * disagreeing, and the next paragraph on `nextAnchorStep` says which of these
 * steps is a base case rather than letting the reader assume all five are hot.
 */
export type AnchorStep =
  | { kind: "idle" }
  | { kind: "highlight" }
  | { kind: "locate" }
  | { kind: "open-thread"; rootId: string }
  | { kind: "not-loaded" };

export type AnchorState = {
  /** The parsed anchor, or null. */
  anchorId: string | null;
  /** Ids currently in the timeline, oldest to newest. */
  loadedIds: readonly string[];
  /** Has the server already been asked where this id lives? */
  located: boolean;
  /** The thread root, when `locate` answered "it is a reply". */
  rootId: string | null;
};

/**
 * ORDER IS THE DESIGN HERE, not an implementation detail.
 *
 * `highlight` is tested BEFORE `locate`, so the overwhelmingly common case — a
 * mention from a minute ago, which is in the first page by definition — costs no
 * round trip at all.
 *
 * `open-thread` beats both, because a reply has `parentId != null` and
 * `getMessagesPage` filters those out: it is not in the timeline and no amount of
 * scrolling or paging will put it there.
 *
 * `not-loaded` is a RESULT, not a silent stop. Replacing "no anchor at all" with
 * "an anchor that quietly did nothing" would be the same dead end wearing a fix.
 * It is now a FALLBACK rather than the ordinary answer for an old root — the page
 * above arrives with the anchor's window already loaded — and it is kept for the
 * same reason `idle` is: this is a total function over `AnchorState`, and a
 * decision that answers every input it accepts beats one whose caller has to
 * pre-filter. What it must not do is read as the hot path for old messages. It
 * is not one.
 */
export function nextAnchorStep(state: AnchorState): AnchorStep {
  const { anchorId, loadedIds, located, rootId } = state;

  if (!anchorId) return { kind: "idle" };
  if (rootId) return { kind: "open-thread", rootId };
  if (loadedIds.indexOf(anchorId) !== -1) return { kind: "highlight" };
  if (!located) return { kind: "locate" };
  // Located, a root, and still not in the timeline — which the anchored page the
  // RSC serves is supposed to have prevented, so this is the two of them
  // disagreeing rather than the ordinary old-message case. Tombstones do not
  // land here either way: both the window and `getMessageLocation` return them,
  // so a deleted message is found and reads "This message was deleted."
  return { kind: "not-loaded" };
}
