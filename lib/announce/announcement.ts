/**
 * The one-time product announcement, stated once.
 *
 * TWO CHANNELS, ONE SOURCE. The dashboard banner
 * (app/(app)/dashboard/announcement-banner.tsx) and the push broadcast
 * (app/api/cron/announce-broadcast/route.ts) both read this object. They are
 * the same announcement delivered two ways, and a customer who sees the push
 * and then opens the app has to read the same words — two copies of the text
 * would drift the moment one of them was tweaked.
 *
 * `id` IS THE DISMISSAL NAMESPACE. The banner's localStorage key is derived
 * from it, so a future announcement that changes `id` is a different
 * announcement to every browser and shows again; one that reuses the id is the
 * same announcement and stays dismissed. That is the whole versioning story,
 * and it is why the id is a date-stamped slug rather than a bare counter.
 *
 * NO DATABASE. There is no Notification row, no read model and no per-user
 * state anywhere: the banner's dismissal is a per-browser flag and the push is
 * fire-and-forget. A durable per-user "seen" marker would be a write to every
 * existing customer's rows for a cosmetic banner, which is not a trade worth
 * making — and per-device dismissal is the honest scope for something that
 * lives in a browser anyway.
 *
 * PLAIN DATA, NO IMPORTS. The banner is a client component and the route is a
 * Node server module; anything pulled in here would end up in both graphs.
 *
 * ENGLISH ONLY, DELIBERATELY. Every other user-facing string in the shell goes
 * through lib/i18n/strings.ts, and this one does not. The headline is the
 * owner's own words, the body is a factual claim about two features, and the
 * product ships an Urdu locale whose coverage is still partial (see
 * `documentLangForLocale` in lib/i18n/strings.ts). Inventing Urdu marketing
 * copy that nobody can check, for a banner that retires after one announcement,
 * is a worse outcome than one consistently English banner — and a half-
 * translated one (English headline, Urdu dismiss label) is the worst of the
 * three. If a second announcement ever ships, that is the point at which these
 * strings earn dictionary entries.
 */

export interface Announcement {
  /** Dismissal namespace and push collapse key. Date-stamped, never reused. */
  id: string;
  /** The owner's words, verbatim. */
  title: string;
  /** One supporting sentence, and it has to stay TRUE — see below. */
  body: string;
  /** Where a tapped notification lands. The banner lives here too. */
  url: string;
}

export const ANNOUNCEMENT: Announcement = {
  id: "2026-10-cooler",
  title: "Your FounderFlow just got cooler!",
  /*
   * Both halves of this sentence are checked claims about shipped code, not
   * marketing:
   *
   *   "opens the exact message" — every chat notification's link is
   *   `/chat/<slug>?message=<id>` (lib/actions/chat.ts:451, :523, :1714) and
   *   `app/(app)/chat/[slug]/page.tsx` reads that parameter through
   *   `parseMessageAnchor`, then scrolls to and highlights that row
   *   (components/chat/message-list.tsx, message-row.tsx — chat-010).
   *
   *   "mute ... without leaving it" — `ChannelMember.mutedAt`, honoured by
   *   `sendMessageAction`'s recipient filter (lib/actions/chat.ts:404-409,
   *   :496). Muted means still a member and still able to read the channel,
   *   which is what makes "without leaving it" accurate rather than a flourish.
   *
   * Nothing here mentions the chart width or the project palette: that work is
   * in flight in another branch of the same tree as this file is written, and a
   * banner is a bad place to announce something that might not land.
   */
  body: "A chat notification now opens the exact message, and you can mute a noisy channel without leaving it.",
  url: "/dashboard",
};

/**
 * The banner's per-browser dismissal key.
 *
 * Derived, never hand-written: a key typed out separately in the component is
 * how a dismissal stops matching the announcement that wrote it.
 */
export const ANNOUNCEMENT_STORAGE_KEY = `ff-announcement-${ANNOUNCEMENT.id}`;

/**
 * The push payload's `tag`.
 *
 * It collapses repeat deliveries into one notification at the OS level, which
 * is worth having and is NOT an idempotency guarantee: a second send still
 * leaves the device, still costs the push service a delivery, and still
 * re-alerts a phone whose first copy the user had already swiped away. The
 * guarantee lives in lib/announce/broadcast-latch.ts, and its limits are
 * documented there.
 */
export const ANNOUNCEMENT_PUSH_TAG = `ff-announcement-${ANNOUNCEMENT.id}`;
