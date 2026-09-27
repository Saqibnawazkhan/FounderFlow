/**
 * User handle derivation — the RUNTIME half of FaultsAudit T16.
 *
 * WHY THIS EXISTS. `prisma/migrations/20260925140000_add_user_handle` gave a
 * handle to every user who existed on 2026-09-25 and then, being a migration,
 * never ran again. A migration is a statement about the past. Nothing wrote a
 * handle for a user created AFTER it, so every new account would land with
 * `handle = NULL` — unmentionable inside their own workspace, which is the
 * precise bug T16 exists to fix, reintroduced for everybody who signs up from
 * now on. (Same shape as the #general gap that `lib/chat/bootstrap.ts` was
 * written to close: a backfill without a write path is a fix with an expiry
 * date.)
 *
 * And it would be SILENT. `@@unique([companyId, handle])` is NULLS DISTINCT in
 * Postgres, so a NULL handle conflicts with nothing and any number of
 * handle-less users coexist happily — the schema comment on `User.handle` says
 * so explicitly, because that property is what let the column ship nullable.
 * Nothing in the database or the UI would have complained. The only symptom is
 * "why can't I @mention the new hire".
 *
 * SHAPE. Two functions, deliberately the same two as `lib/chat/slug.ts`
 * (`slugifyChannelName` / `uniqueChannelSlug`): one that turns free text into a
 * candidate, one that walks a numbered series until it finds a free one. Same
 * class of problem — a per-workspace unique string derived from text a human
 * typed — so this should read as that file's sibling, bounded loop and all.
 * Pure and I/O-free so tests/lib/user/handle.test.ts can hold every hostile
 * input down without a database; the caller owns the query that loads `taken`,
 * and the unique index stays the only real guarantee.
 *
 * MIRRORS THE MIGRATION, ON PURPOSE. Both halves hand out handles into the
 * same unique index, so any disagreement in derivation style is a permanent
 * split in the product: the ali.khan backfilled on 2026-09-25 would be
 * `@alikhan` and the ali.khan who joins tomorrow `@ali-khan`, and nobody could
 * guess a colleague's handle from their address. The rules below are the
 * migration's rules, in the migration's order, with its `--n` de-duplication.
 * Read its `migration.sql`; it argues each one at length.
 */

/**
 * NOT a slugifier in the `slugifyChannelName` sense, and this is the one place
 * the two files deliberately differ: that one REPLACES a run of junk with a
 * hyphen ("Q3 // Growth" becomes "q3-growth"), this one DELETES it ("ali.khan"
 * becomes "alikhan"), because that is what the backfill's
 * `regexp_replace(local_part, '[^a-z0-9-]', '', 'g')` did to the users already
 * in the index. A channel slug is a URL, where word boundaries help you read
 * it; a handle is a token typed after an `@` mid-sentence, where every extra
 * hyphen is one more keystroke to get wrong.
 */
const DISALLOWED = /[^a-z0-9-]/g;

/**
 * The stem for text carrying no ASCII alphanumerics at all — an all-Urdu
 * local-part (exactly the population T16 is about), or one that is nothing but
 * dots and plus signs. `deriveHandle` must never return "": an empty handle is
 * not addressable, which is this bug wearing a different mask.
 *
 * A CONSTANT, where the migration used `user-<first 8 of md5(id)>`. It had a
 * primary key to hash; this function does not — it is pure, it takes a string,
 * and it runs BEFORE the row exists. Both alternatives are worse than
 * numbering: hashing the email would publish a stable token derived from
 * someone's address to every teammate who can see their handle, and a random
 * stem would make the same input produce a different answer on every call,
 * which is untestable. So the stem is constant and `uniqueHandle` numbers it:
 * `user`, `user--2`, `user--3`. Deliberately ugly, like the migration's — a
 * machine-assigned handle should look machine-assigned, so its owner renames it
 * the day a rename control exists.
 *
 * It cannot collide with a backfilled fallback: those are `user-` plus eight
 * hex characters, and `user--2` is not that string (md5 hex never starts with a
 * hyphen). Both families number off the same stem, so they read as one
 * convention rather than two.
 */
export const FALLBACK_HANDLE = "user";

/**
 * Handles are capped so the token stays typable. RFC 5321 already bounds an
 * email local-part at 64 characters, and half of that is longer than anything
 * anyone will type after an `@` in the middle of a sentence.
 *
 * The migration did NOT cap, which is a real difference and a safe one: this
 * shortens only handles assigned from today onward, and a shortened base can
 * produce a COLLISION but never an inconsistency the index misses —
 * `uniqueHandle` numbers the second holder, and `@@unique([companyId, handle])`
 * arbitrates anything that slips past. Two 40-character local-parts sharing
 * their first 32 characters are not a scenario worth an uncapped column.
 */
export const MAX_HANDLE_LENGTH = 32;

/**
 * The de-duplication separator, and why a DOUBLE hyphen is collision-free —
 * the migration's argument, restated because both sides now depend on it.
 *
 * A plain numeric suffix is not safe: `ali`, `ali`, `ali2@z.com` would hand out
 * `ali`, `ali2`, `ali2`. `--` is safe because the cleaning step collapses every
 * run of hyphens to one and trims the ends, so no DERIVED base can contain
 * `--`. `ali--2` is therefore unreachable as a base, and two different bases
 * cannot produce the same suffixed handle either (that would take a base
 * containing `--`). tests/lib/user/handle.test.ts pins that property.
 */
const DEDUPE_SEPARATOR = "--";

/**
 * How far the numbered series runs before giving up on readability. Bounded
 * rather than `while (true)` for the reason `uniqueChannelSlug` gives: a
 * workspace with a thousand teammates whose addresses all clean down to one
 * base is a bug or an attack, and an unbounded loop is the wrong way to find
 * out which.
 */
const MAX_DEDUPE_SERIES = 1000;

/** The name Prisma derives for `@@unique([companyId, handle])` on User. */
export const HANDLE_UNIQUE_INDEX = "User_companyId_handle_key";

/**
 * Derive a candidate handle from an email local-part or a name.
 *
 * Four steps, each of which the de-duplication below depends on:
 *
 *   local-part  everything before the first `@`
 *   cleaned     strip everything outside [a-z0-9-] → collapse hyphen runs →
 *               trim leading/trailing hyphens
 *   base        force a leading ASCII LETTER, then fall back if empty
 *   capped      MAX_HANDLE_LENGTH, with any separator the cut exposed trimmed
 *
 * WHY FORCE A LEADING LETTER. `MENTION_REGEX` in lib/comments/mentions.ts is
 * `/@([a-zA-Z][a-zA-Z0-9-]*)/` — the first character must be a letter so
 * `@2024` does not tokenize as a mention. A handle of `2024ali` would be
 * exactly as unaddressable as the empty string this module exists to prevent,
 * so `2024ali@x.com` becomes `u2024ali`.
 *
 * WHY SPLIT ON `@` WHEN A NAME MAY BE PASSED. `split_part(lower(email), '@',
 * 1)` is what the backfill did, and a name containing an `@` is not something
 * this product produces. The degenerate input "@ali" yields "" and therefore
 * the fallback — the safe direction: a machine-assigned handle nobody claimed
 * beats quietly claiming the text after somebody else's `@`.
 *
 * NEVER RETURNS "". The result always begins with an ASCII letter, so neither
 * the length cap nor the trailing-separator trim can empty it. That invariant
 * IS the fix; the test file asserts it over a table of adversarial inputs.
 */
export function deriveHandle(emailOrName: string): string {
  const localPart = emailOrName.split("@")[0] ?? "";

  const cleaned = localPart
    .toLowerCase()
    .replace(DISALLOWED, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  let base: string;
  if (/^[a-z]/.test(cleaned)) {
    base = cleaned;
  } else if (cleaned !== "") {
    // Leads with a digit or a hyphen: prefix rather than discard, so `2024ali`
    // stays recognisably itself as `u2024ali` instead of becoming `user`.
    base = `u${cleaned}`;
  } else {
    base = FALLBACK_HANDLE;
  }

  return (
    base
      .slice(0, MAX_HANDLE_LENGTH)
      // The cut can land mid-separator and leave a trailing hyphen. Safe to
      // strip greedily: character 0 is an ASCII letter by construction above,
      // so there is always something left.
      .replace(/-+$/g, "")
  );
}

/**
 * The first handle in the `base`, `base--2`, `base--3`, … series that is not
 * already `taken`, so ali@x.com and ali@y.com in one workspace become `@ali`
 * and `@ali--2` rather than the second insert failing the unique index.
 *
 * `taken` is the set of handles ALREADY IN THE WORKSPACE — the caller loads it
 * scoped to its companyId, because handles are per-workspace (two companies may
 * each hold an `@ali`, for the reason the schema comment gives). That load must
 * NOT filter `deletedAt: null`, and each caller says why at the query: a
 * tombstoned user still occupies their slot in the unique index, so handing
 * their handle to a live teammate would break the soft-delete restore
 * documented in CLAUDE.md the moment ops ran it.
 *
 * NO RESERVED LIST, unlike `uniqueChannelSlug`. That one reserves route
 * segments because a slug is a URL and `/chat/new` is already spoken for; a
 * handle owns no route. Nor is there a broadcast token to protect —
 * `MENTION_REGEX` has no `@everyone`/`@here` concept, and if one is ever added
 * it has to be reserved in the PARSER, because the backfill has already handed
 * out whatever it handed out and a rule enforced against new users only is not
 * a rule.
 *
 * Best-effort, not a lock: two invites accepted in the same millisecond can
 * both compute `ali--2`. The unique index is the real guarantee and the caller
 * retries on its P2002 — see `isHandleConflict`.
 */
export function uniqueHandle(base: string, taken: Iterable<string>): string {
  const used = new Set<string>(taken);

  if (!used.has(base)) return base;
  for (let n = 2; n <= MAX_DEDUPE_SERIES; n++) {
    const candidate = `${base}${DEDUPE_SEPARATOR}${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Past the series, fall through to something time-derived and let the unique
  // index arbitrate. base-36 of a timestamp is [0-9a-z] only, so the result is
  // still a legal mention token rather than an unaddressable handle.
  return `${base}${DEDUPE_SEPARATOR}${Date.now().toString(36)}`;
}

/**
 * Is this error the handle unique index rejecting a write?
 *
 * WHY CHECKING P2002 IS NOT ENOUGH. `User.email` is unique too, and a duplicate
 * email is a completely different event: it means "an account with this email
 * already exists", which both write paths answer with their own message and
 * must never retry under a fresh handle. A blanket P2002 retry would turn that
 * clear answer into a generic failure three attempts later.
 *
 * Matches the index name AND the bare field name because Prisma's `meta.target`
 * is not a stable shape — the Postgres connector has reported the constraint
 * name as a string and an array of field names across versions, and neither is
 * part of a documented contract. An unattributable P2002 (no `meta`, unknown
 * shape) deliberately returns false and surfaces as an ordinary failure:
 * retrying a conflict we cannot name is how a duplicate email becomes three
 * identical apologies.
 *
 * Spelled out structurally rather than through `instanceof
 * Prisma.PrismaClientKnownRequestError`, the way `createChannelAction`,
 * `openDmAction` and `lib/chat/bootstrap.ts` all do it: that `instanceof` is
 * worthless in a unit test, where the error is a plain object with a `code`.
 */
export function isHandleConflict(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, meta } = e as { code?: string; meta?: { target?: unknown } };
  if (code !== "P2002") return false;

  const target = meta?.target;
  const fields = typeof target === "string" ? [target] : Array.isArray(target) ? target : [];
  return fields.some((f) => f === HANDLE_UNIQUE_INDEX || f === "handle");
}
