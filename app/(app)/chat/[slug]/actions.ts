"use server";

/**
 * Pagination bridge for the message list.
 *
 * WHY THIS FILE EXISTS: `lib/queries/chat.ts` is server-only, so the client
 * island cannot call `getMessagesPage` directly, and the only server action the
 * timeline itself has is `markChannelReadAction` — nothing that hands back an
 * older page. (This read "the chat contract ships exactly one server action",
 * which stopped being true when the sidebar's unread badge grew a second one.)
 *
 * Rather than widen someone else's module, the route that needs the
 * capability owns the thin wrapper.
 *
 * WHY IT TAKES A SLUG, NOT A CHANNEL ID: a channelId arriving from the client
 * is attacker-controlled. Resolving the slug through `getChannelBySlug` first
 * reuses the exact authorization the page itself ran — if the caller cannot
 * see the channel the query returns null and we never reach the messages. A
 * missing channel returns the same generic error as a non-member, so the
 * response can't be used to probe which private channels exist.
 */

import {
  getChannelBySlug,
  getMessageLocation,
  getMessagesPage,
  getThread,
} from "@/lib/queries/chat";
import type { MessageClient } from "@/lib/queries/chat";
import { parseMessageAnchor } from "@/lib/chat/anchor";
import type { ActionResult } from "@/lib/actions/types";

type OlderPage = { messages: MessageClient[]; nextCursor: string | null };

export async function loadOlderMessagesAction(input: {
  slug: string;
  cursor: string;
}): Promise<ActionResult<OlderPage>> {
  try {
    const channel = await getChannelBySlug(input.slug);
    if (!channel) return { success: false, error: "Channel not found" };
    const page = await getMessagesPage(channel.id, input.cursor);
    return { success: true, data: page };
  } catch {
    return { success: false, error: "Couldn't load earlier messages" };
  }
}

type ThreadPage = { root: MessageClient; replies: MessageClient[] };

/**
 * Load one thread for the panel.
 *
 * Same slug-not-id reasoning as above: the root id still comes from the
 * client, so the channel is re-resolved first and the thread is only returned
 * once the caller has been shown to see that channel. A root belonging to a
 * different channel is refused with the same generic error, so this cannot be
 * used to read a private conversation by guessing message ids.
 *
 * `getThread` returns the root as element 0 with its replies after it; the
 * panel wants them separately, so the split happens here rather than in the
 * component.
 */
export async function loadThreadAction(input: {
  slug: string;
  rootId: string;
}): Promise<ActionResult<ThreadPage>> {
  try {
    const channel = await getChannelBySlug(input.slug);
    if (!channel) return { success: false, error: "Thread not found" };

    const rows = await getThread(input.rootId);
    const [root, ...replies] = rows;
    // A root from another channel, or one that no longer exists, is
    // indistinguishable from "no permission" on purpose.
    if (!root || root.channelId !== channel.id) {
      return { success: false, error: "Thread not found" };
    }
    return { success: true, data: { root, replies } };
  } catch {
    return { success: false, error: "Couldn't load that thread" };
  }
}

/**
 * Where does the message a `?message=<id>` link named actually live? (chat-010)
 *
 * Asked only when the id is NOT already in the page the reader has — see
 * `nextAnchorStep` in lib/chat/anchor.ts — so a mention from a minute ago costs
 * no round trip. It answers the one question the client cannot: whether to keep
 * paging the timeline backwards, or to open the thread panel because the target
 * is a reply the timeline excludes outright.
 *
 * Same slug-not-id reasoning as the two actions above: the channel is re-resolved
 * through `getChannelBySlug` so the authorization the page itself ran is the
 * authorization this uses, and a channel the caller cannot see is refused with
 * the same generic error as a message that does not exist.
 *
 * `parseMessageAnchor` is REUSED rather than restated. It is the same shape check
 * the client applies to the address bar, and it belongs here too because a server
 * action is a public endpoint whatever the client does — one spelling, both ends.
 */
export async function locateMessageAction(input: {
  slug: string;
  messageId: string;
}): Promise<ActionResult<{ rootId: string | null }>> {
  try {
    // READ INSIDE THE TRY, unlike the first draft. Both sibling endpoints in this
    // file touch `input` inside theirs, and this one did not: a null or undefined
    // payload to a public POST endpoint threw a TypeError on property access
    // instead of returning this file's ordinary refusal. Server actions are
    // reachable by anything that can post a body, so "the client always sends an
    // object" is not a property of the endpoint.
    const messageId = parseMessageAnchor(input?.messageId);
    if (!messageId) return { success: false, error: "That message is no longer here" };

    const channel = await getChannelBySlug(input.slug);
    if (!channel) return { success: false, error: "That message is no longer here" };

    const location = await getMessageLocation(channel.id, messageId);
    // One error for "deleted", "never existed" and "not yours", so this cannot be
    // used to probe which message ids are real.
    if (!location) return { success: false, error: "That message is no longer here" };

    return { success: true, data: { rootId: location.rootId } };
  } catch {
    return { success: false, error: "Couldn't find that message" };
  }
}
