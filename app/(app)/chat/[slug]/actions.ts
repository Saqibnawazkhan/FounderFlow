"use server";

/**
 * Pagination bridge for the message list.
 *
 * WHY THIS FILE EXISTS: `lib/queries/chat.ts` is server-only, so the client
 * island cannot call `getMessagesPage` directly, and the chat contract ships
 * exactly one server action (`markChannelReadAction`) — nothing that hands
 * back an older page. Rather than widen someone else's module, the route that
 * needs the capability owns the thin wrapper.
 *
 * WHY IT TAKES A SLUG, NOT A CHANNEL ID: a channelId arriving from the client
 * is attacker-controlled. Resolving the slug through `getChannelBySlug` first
 * reuses the exact authorization the page itself ran — if the caller cannot
 * see the channel the query returns null and we never reach the messages. A
 * missing channel returns the same generic error as a non-member, so the
 * response can't be used to probe which private channels exist.
 */

import { getChannelBySlug, getMessagesPage, getThread } from "@/lib/queries/chat";
import type { MessageClient } from "@/lib/queries/chat";
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
