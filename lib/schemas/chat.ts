/**
 * Zod schemas for chat mutations. Server actions parse() these and trust the
 * result; the composer + channel forms use the same schemas via zodResolver so
 * client and server validation stay in lock step.
 *
 * These tuples are also the source of truth for the String columns on Channel /
 * Message / MessageReaction — prisma/schema.prisma deliberately stores them as
 * plain strings and defers the union to this file, the same way every other
 * status/kind/role column in the schema does.
 */

import { z } from "zod";

// Channel kinds.
//   public  — every company member can read and post, joined or not
//   private — invite-only; membership IS the permission (an admin does not
//             get a back door — see lib/auth/channel-permissions.ts)
//   dm      — a private channel for exactly two people, keyed by dmKeyFor()
export const CHANNEL_KINDS = ["public", "private", "dm"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

// Per-channel membership role, independent of the company-level Role in
// lib/auth/role-gates.ts. The owner can rename/archive their own channel
// without being a company admin.
export const CHANNEL_ROLES = ["owner", "member"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

// Message kinds. "card" carries a structured, versioned JSON payload (a Runway
// snapshot); "text" is a plain body and leaves payload NULL.
export const MESSAGE_KINDS = ["text", "card"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

// A fixed allow-list, NOT a picker library — the landing mock shows chips, not
// a picker. Keeping the set closed means the reaction rail has a known width,
// the column can't accumulate arbitrary user input, and every stored emoji is
// guaranteed renderable. Add to this list to widen the rail.
export const REACTION_EMOJI = ["👍", "🎉", "👀", "🚀", "❤️", "😄", "🙏", "✅"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/**
 * An id, validated the way the rest of this repo validates ids.
 *
 * THIS USED TO BE `z.string().cuid()`, ON THE STATED GROUND THAT "ids are
 * cuids (Prisma @default(cuid()))". That premise is false, and it shipped a
 * bug: opening a direct message with any seeded teammate failed with "Pick a
 * teammate" before the action ever ran, because the demo workspace's users are
 * `demo-ahmed`, `demo-fatima` and so on — hyphenated, human-readable ids that
 * zod's cuid regex (`/^c[^\s-]{8,}$/i`) rejects outright.
 *
 * The system produces at least three id shapes and only one of them is a cuid:
 *   - `cmugkfd560001v21ss2bd76dw` — Prisma `@default(cuid())`, the common case
 *   - `chgen_…` / `chmem_…`      — deterministic ids minted by the chat
 *                                   migration's backfill, which pass the cuid
 *                                   regex only by accident (they happen to
 *                                   start with "c" and carry no hyphen)
 *   - `demo-nimbus`, `demo-ahmed` — fixed ids from prisma/seed.ts
 *
 * So the validator was asserting a guarantee the schema never made. Every
 * other schema in lib/schemas (budget, comment, project, recurring, task,
 * time) uses `z.string().min(1)`; chat was the lone outlier, and being the
 * outlier is what broke it.
 *
 * Bounded rather than bare `min(1)`: an id is a lookup key, and there is no
 * legitimate id of ten thousand characters — capping it keeps an absurd
 * payload out of a database round trip. Validating the SHAPE beyond that is
 * the job of the query that resolves it, which already has to handle
 * "well-formed but not yours".
 */
const IdField = (message: string) => z.string().trim().min(1, message).max(64, message);

const ChannelIdField = IdField("Pick a channel");
const MessageIdField = IdField("Pick a message");

const ChannelNameField = z
  .string()
  .trim()
  .min(1, "Channel name is required")
  .max(60, "Channel name is too long");

const TopicField = z
  .string()
  .trim()
  .max(200, "Topic is too long")
  .optional()
  // Coerce empty string to undefined so an empty input round-trips to SQL NULL
  // instead of a stored empty string — same treatment as Project.description.
  .transform((v) => (v && v.length > 0 ? v : undefined));

// DMs are never created through the new-channel form: they're opened on demand
// by openDmAction, which derives the dmKey from the pair. Allowing "dm" here
// would let a caller hand-craft a DM with no second participant.
export const CREATABLE_CHANNEL_KINDS = ["public", "private"] as const;

const CreatableKindField = z.enum(CREATABLE_CHANNEL_KINDS, {
  errorMap: () => ({ message: "Pick a channel type" }),
});

const BodyField = z
  .string()
  .trim()
  .min(1, "Message can't be empty")
  .max(4000, "Keep it under 4,000 characters");

const EmojiField = z.enum(REACTION_EMOJI, {
  errorMap: () => ({ message: "Pick one of the available reactions" }),
});

export const NewChannelSchema = z.object({
  name: ChannelNameField,
  kind: CreatableKindField,
  topic: TopicField,
});
export type NewChannelInput = z.infer<typeof NewChannelSchema>;

export const SendMessageSchema = z.object({
  channelId: ChannelIdField,
  body: BodyField,
  // Present = this is a threaded reply and parentId is the thread root.
  // Absent = a new root in the channel timeline.
  parentId: MessageIdField.optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const ToggleReactionSchema = z.object({
  messageId: MessageIdField,
  emoji: EmojiField,
});
export type ToggleReactionInput = z.infer<typeof ToggleReactionSchema>;

export const MarkChannelReadSchema = z.object({
  channelId: ChannelIdField,
});
export type MarkChannelReadInput = z.infer<typeof MarkChannelReadSchema>;

export const DeleteMessageSchema = z.object({
  messageId: MessageIdField,
});
export type DeleteMessageInput = z.infer<typeof DeleteMessageSchema>;

// Opening a direct message names ONE person. The other half of the pair is the
// session user, and the pair's identity is derived server-side by dmKeyFor()
// in lib/auth/channel-permissions.ts from the session id + this one. A schema
// carrying both ids would let a caller name two OTHER people and open — then
// read — a conversation they are not in; the only id a client is trusted with
// here is the one it is addressing.
//
// Shape-validated like every other id in this file, so a malformed id is a
// form error at the boundary instead of a "teammate not found" further in.
// Well-shaped is not authorised: the action still re-verifies the id against
// its own companyId before writing anything.
export const OpenDmSchema = z.object({
  userId: IdField("Pick a teammate"),
});
export type OpenDmInput = z.infer<typeof OpenDmSchema>;

/* ── Runway card ──────────────────────────────────────────────────────────
 *
 * A Runway card is a message with `kind: "card"` whose figures live in
 * `Message.payload` as versioned JSON. It is a SNAPSHOT, frozen at post time:
 * the card renders the numbers as they stood when someone posted them into the
 * conversation, and never recomputes on read. That is the point of the
 * feature — "here is what the runway looked like when we made this call" — and
 * a card that silently re-ran the dashboard query would rewrite the record of
 * a decision every time an old thread is scrolled past.
 */

/**
 * The payload shape version, stored as `v` on every card.
 *
 * A reader that meets a version it does not know refuses to render the figures
 * rather than guessing at them (see `toRunwayCard` in lib/queries/chat.ts).
 * Bump this ONLY when the shape changes incompatibly, and add the new literal
 * as a discriminated union arm here rather than loosening `v` to `z.number()` —
 * a schema that accepts any version is a schema that validates nothing.
 */
export const RUNWAY_CARD_VERSION = 1;

/**
 * The stored payload of a Runway card.
 *
 * The field set MIRRORS the dashboard's own runway arithmetic
 * (app/(app)/dashboard/dashboard-client.tsx), so a card and the dashboard can
 * never quote two different definitions of the same word:
 *   cashOnHand   = investments + revenue − expenses  (the "Balance" stat)
 *   monthlyBurn  = the last 3 months of expenses ÷ 3
 *   runwayMonths = cashOnHand ÷ monthlyBurn
 *
 * `runwayMonths` is NULLABLE because the dashboard's version of it is
 * `Infinity` when nothing has been spent yet, and JSON has no Infinity —
 * `JSON.stringify(Infinity)` already yields `null`, so null is simply the
 * honest wire spelling of that case. It means "no burn recorded", NOT "no
 * data" and NOT "hidden from you"; the UI renders it as its own sentence.
 *
 * `cashOnHand` is deliberately unconstrained in sign: a workspace that has
 * spent more than it raised has a negative balance, and refusing to post that
 * card would hide exactly the number worth talking about.
 *
 * `.finite()` on the numbers rejects ±Infinity arriving through any path that
 * is not JSON.parse. NaN is already rejected by `z.number()` in zod 3.
 *
 * `currency` is a bounded plain string and NOT `z.enum(SUPPORTED_CURRENCIES)`,
 * which is the one place this file departs from "zod owns every union". A
 * stored card is an archival row that gets re-parsed on every render, possibly
 * years later; pinning it to today's supported list means the day a currency
 * is dropped from that list, every historical card denominated in it stops
 * parsing and renders as an unreadable frame. The value is written
 * server-side from `Company.currency` and never accepted from a client, so a
 * loose type costs nothing here.
 *
 * NOT `.strict()`, on purpose. Unknown keys are STRIPPED by zod's default
 * object behaviour, and the DTO in lib/queries/chat.ts is rebuilt from the
 * PARSED result rather than from the raw string — so a figure smuggled into
 * the JSON under a key nobody anticipated cannot ride along to a viewer who
 * is not allowed to see figures. Strict would instead throw the whole card
 * away, which is a worse outcome for a forward-compatible reader.
 */
export const RunwayPayloadSchema = z.object({
  v: z.literal(RUNWAY_CARD_VERSION),
  type: z.literal("runway"),
  // ISO-8601 instant, the same wire format every other date in lib/queries/
  // crosses the RSC boundary as.
  asOf: z.string().datetime({ message: "asOf must be an ISO timestamp" }),
  runwayMonths: z.number().finite().nullable(),
  cashOnHand: z.number().finite(),
  monthlyBurn: z.number().finite(),
  currency: z.string().trim().min(1).max(8),
});
export type RunwayPayload = z.infer<typeof RunwayPayloadSchema>;

/**
 * The subset of a Runway payload a viewer WITHOUT finance access may receive:
 * the frame, and nothing that is a figure.
 *
 * Derived with `.pick()` rather than `.omit()`, and that choice is the whole
 * safety property. With `omit` the default for a newly added field is PUBLIC —
 * add `burnByCategory` to the payload next quarter, forget to add it to the
 * omit list, and it ships straight to every member in the company. With `pick`
 * the default for a new field is SECRET: it simply is not in the list, so it
 * is dropped until somebody deliberately adds it. Fail closed.
 */
export const RedactedRunwayPayloadSchema = RunwayPayloadSchema.pick({
  v: true,
  type: true,
  asOf: true,
  currency: true,
});
export type RedactedRunwayPayload = z.infer<typeof RedactedRunwayPayloadSchema>;

/**
 * Posting a Runway card names a CHANNEL AND NOTHING ELSE.
 *
 * Every figure is computed server-side at post time from the caller's own
 * company. There is deliberately no `cashOnHand` field here, and there must
 * never be one: a schema that accepted the numbers would let any client post
 * any numbers it liked, over the company's name, into a channel their whole
 * team reads. The same reasoning as `OpenDmSchema` above — the only thing a
 * client is trusted with is the id it is addressing.
 *
 * No `parentId` either. A runway snapshot is an announcement to the room, not
 * a reply inside someone else's thread; if threading a card is ever wanted it
 * needs its own product decision, not a quietly optional field.
 */
export const PostRunwayCardSchema = z.object({
  channelId: ChannelIdField,
});
export type PostRunwayCardInput = z.infer<typeof PostRunwayCardSchema>;
