/**
 * Cross-content search — the read path behind the command palette. READ ONLY;
 * there is no write side to this feature.
 *
 * Five rules hold across this file:
 *
 *  1. The entry point starts at `requireScopedSession()`. Nothing here takes a
 *     companyId — or a userId, or a role — from its caller. A search box is
 *     the most attacker-friendly input surface in the product, and the one
 *     thing it must never be able to influence is WHOSE data is searched.
 *  2. Every group is capped at `GROUP_LIMIT`. A palette shows a shortlist you
 *     scan in one glance, not a result page; an uncapped group would also make
 *     one noisy content type push every other group off the screen.
 *  3. Finance groups are not FILTERED for a member, they are not RUN. See
 *     `searchWorkspace` — skipping the query is the stronger property.
 *  4. Permission questions are answered by the predicates in lib/auth/, never
 *     by a `role === "member"` written here. `canSeeFinances`,
 *     `canSeeAllProjects` and `visibleChannelWhere` are the three this file
 *     leans on, and the SQL below is GENERATED from the third rather than
 *     retyped next to it.
 *  5. Every scoped read filters `deletedAt: null`, manually, every time —
 *     including the raw SQL, where the search vector knows nothing about
 *     tombstones and will cheerfully resurface a "message deleted" row.
 *
 * ON THE MIX OF PRISMA AND RAW SQL: messages go through `$queryRaw` because
 * they are the one content type with a real full-text index behind them
 * (`Message.searchVector`, a Postgres GENERATED column the Prisma client
 * cannot even see — see migration 20260925120000_add_message_search). Chat
 * accumulates forever and an `ILIKE '%term%'` over it is a sequential scan
 * that gets slower every week. Tasks, projects, transactions and budgets stay
 * on ordinary Prisma `contains`: their per-company row counts are bounded by
 * how much work a company does, not by how much it chats, and a GIN index per
 * table would be four more migrations to maintain for a scan that is already
 * fast. If any of those tables ever grows past a comfortable scan, it gets its
 * own generated column and joins the raw path — the group functions below are
 * deliberately independent so that is a one-function change.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { canSeeAllProjects } from "@/lib/auth/project-permissions";
import { visibleChannelWhere } from "@/lib/auth/channel-permissions";
import { SEARCH_GROUPS, SearchQuerySchema, type SearchGroup } from "@/lib/schemas/search";
import { conversationTitle } from "@/lib/chat/dm";

/** Hits per group. Five fits a palette section without scrolling it. */
const GROUP_LIMIT = 5;

/**
 * `ts_headline` options, passed as a bound parameter rather than baked into
 * the SQL text.
 *
 * The delimiters are stated EXPLICITLY even though `<b>` / `</b>` are already
 * the Postgres defaults, because `stripHeadlineMarkup` below removes exactly
 * these two strings. Relying on the default would put the pairing in two
 * places — one of them a server config we do not control — and the failure
 * mode is literal `<b>` tags showing up in the palette.
 *
 * `MaxFragments=0` asks for one window around the best match rather than
 * stitched fragments; `MaxWords=18` keeps that window to roughly one line,
 * which is all a palette row has.
 */
const HEADLINE_OPTIONS =
  "StartSel=<b>,StopSel=</b>,MaxWords=18,MinWords=5,ShortWord=3,HighlightAll=FALSE,MaxFragments=0";

export interface SearchHit {
  group: SearchGroup;
  id: string;
  title: string;
  /** One line of context — the matching snippet, or the parent's name. */
  subtitle: string | null;
  /** Where Enter takes you. */
  href: string;
}

export interface SearchResults {
  groups: { group: SearchGroup; hits: SearchHit[] }[];
}

/**
 * `ts_headline` marks the matched words with the delimiters in
 * `HEADLINE_OPTIONS`. The palette renders a subtitle as TEXT, so those tags
 * would appear literally — and the fix is not to render the snippet as HTML:
 * that string is a user-typed chat message, and `dangerouslySetInnerHTML` over
 * it to bold three characters would be a stored-XSS surface bought for a
 * cosmetic gain. Strip the markup here instead and hand the UI plain text.
 *
 * Someone who literally typed "<b>" into a message loses it from the snippet.
 * That is the whole cost, and it is the right side of the trade.
 */
function stripHeadlineMarkup(snippet: string | null): string | null {
  if (snippet === null) return null;
  const plain = snippet.replace(/<\/?b>/g, "").trim();
  return plain.length > 0 ? plain : null;
}

/**
 * Where a transaction hit lands. Transaction.type is one of expense /
 * investment / income (lib/schemas/transaction.ts owns that union) and each
 * has its own page. Falls back to /expenses for an unknown value rather than
 * producing a dead link.
 */
function transactionHref(type: string): string {
  if (type === "investment") return "/investments";
  if (type === "income") return "/revenue";
  return "/expenses";
}

/**
 * The SQL spelling of `visibleChannelWhere`, GENERATED from that function's
 * own output rather than retyped beside it.
 *
 * WHY THIS EXISTS AT ALL: the raw message search cannot hand a Prisma `where`
 * fragment to `$queryRaw`, and lib/auth/channel-permissions.ts is emphatic
 * that an `OR: [{ kind: "public" }, …]` written a second time somewhere else
 * is the exact bug it was created to prevent. So this reads the fragment and
 * translates it, arm by arm: every VALUE in the SQL below — the literal
 * "public", the caller's id, the company id — comes out of the fragment. If
 * someone changes what "visible" means in that module, this follows without
 * an edit, and an arm shape it does not recognise throws instead of silently
 * dropping out of the WHERE clause (which is how a visibility rule quietly
 * stops applying).
 *
 * READ THIS BEFORE CHANGING EITHER SIDE: this is the SECOND expression of the
 * rule in lib/auth/channel-permissions.ts. `canSeeChannel` is the first. If
 * the two ever disagree, THE SQL IS THE ONE THAT LEAKS — it runs with no
 * per-row predicate behind it to catch what it lets through. That framing is
 * lifted verbatim from `visibleChannelWhere`'s own doc comment, and it is the
 * reason this function is a translator and not a rewrite.
 *
 * The fragment's arms are OR-ed, matching the Prisma semantics exactly: a
 * public channel, or one the caller holds a ChannelMember row for. Everything
 * else — private channels the caller was never invited to, other people's DMs
 * — matches nothing, which is Phase H's second security property.
 */
/**
 * Assert an arm carries EXACTLY the keys this translator knows how to render.
 *
 * `"kind" in arm` narrows the type, which catches a brand-new arm at build
 * time — but it also happily matches an arm that has GROWN a second condition,
 * say `{ kind: "public", archivedAt: null }`. In that case the translator
 * would emit only the half it recognised: a WIDER rule than Prisma enforces,
 * with the `never` check still silent. That is this module's own failure mode,
 * in the direction that leaks — search would keep returning messages from
 * archived channels after every Prisma caller had stopped.
 */
function assertArmShape(arm: object, expected: string): void {
  const actual = Object.keys(arm).sort().join(",");
  if (actual === expected) return;
  throw new Error(
    `Channel visibility arm "${expected}" has grown new conditions (${actual}). ` +
      `lib/auth/channel-permissions.ts changed and lib/queries/search.ts still ` +
      `translates only part of the rule — which would serve messages the ` +
      `predicate denies. Update both together.`
  );
}

function channelVisibilitySql(userId: string, companyId: string): Prisma.Sql {
  const fragment = visibleChannelWhere(userId, companyId);

  const arms = fragment.OR.map((arm): Prisma.Sql => {
    // Two guards, catching two different mistakes. `in` narrows the union, so
    // a NEW arm fails at build time on the `never` below. assertArmShape
    // compares the full key set, so a WIDENED existing arm fails loudly on
    // first call. Neither one catches the other's case.
    if ("kind" in arm) {
      assertArmShape(arm, "kind");
      return Prisma.sql`ch."kind" = ${arm.kind}`;
    }
    if ("members" in arm) {
      assertArmShape(arm, "members");
      return Prisma.sql`EXISTS (
        SELECT 1 FROM "ChannelMember" cm
         WHERE cm."channelId" = ch."id"
           AND cm."userId" = ${arm.members.some.userId}
      )`;
    }
    // Throwing takes search down for everyone, deliberately. A visibility rule
    // this module cannot express is not something to degrade around.
    const unknownArm: never = arm;
    throw new Error(`Unhandled channel visibility arm: ${JSON.stringify(unknownArm)}`);
  });

  // `fragment.companyId`, not the parameter: the tenancy scope travels with
  // the visibility rule, exactly as it does for every Prisma caller of the
  // fragment.
  return Prisma.sql`ch."companyId" = ${fragment.companyId} AND (${Prisma.join(arms, " OR ")})`;
}

/** The shape `$queryRaw` hands back — plain scalars, no Prisma types. */
type MessageSearchRow = {
  id: string;
  authorName: string;
  channelSlug: string;
  channelName: string;
  channelKind: string;
  snippet: string | null;
};

/**
 * Full-text search over chat messages. The ONLY raw SQL in this feature, and
 * therefore the only place a tenancy or visibility bug could be silent.
 *
 * ON `$queryRaw` AND NOT `$queryRawUnsafe`: every `${…}` in a Prisma tagged
 * template becomes a bound parameter, so the search term reaches Postgres as a
 * value and can never be parsed as SQL. `$queryRawUnsafe` and string
 * concatenation are banned here — a search box is the first thing anyone tries
 * an injection against, and there is no version of this query that needs them.
 * The one composed fragment (`channelVisibilitySql`) is built with
 * `Prisma.sql` / `Prisma.join`, which are parameterized the same way.
 *
 * ON `websearch_to_tsquery` AND NOT `to_tsquery`: `to_tsquery` demands valid
 * tsquery syntax and throws a Postgres syntax error on ordinary human typing —
 * "budget & " mid-word, an unbalanced quote, a stray colon. Every one of those
 * is a keystroke someone WILL pass through on their way to a real term, and
 * with `to_tsquery` each one is a 500 in the middle of type-ahead.
 * `websearch_to_tsquery` never throws on user input: it parses the term the
 * way a search engine box does (quoted phrases, `or`, leading `-`) and
 * discards what it cannot use. The config argument is the literal 'english' to
 * match the generated column's own configuration — a query built with 'simple'
 * parses to different lexemes and would not use the GIN index at all.
 *
 * ON THE URDU CAVEAT: the column is stemmed with the English dictionary
 * (migration 20260925120000_add_message_search explains why it cannot be
 * per-workspace). Urdu text is indexed and findable, but by exact token only —
 * an inflected form will not find the base form. An Urdu search returning
 * nothing is therefore not necessarily a bug here.
 *
 * ON THE SUBQUERY: `ts_headline` reads "body", not the vector, so it is not
 * index-accelerated and costs real work per row. Ranking and LIMIT happen in
 * the inner query; the snippet is computed in the outer one, over the five
 * rows that survived. Putting it in the inner SELECT list would let Postgres
 * compute a headline for every matching message in the workspace.
 */
async function searchMessages(q: string, userId: string, companyId: string): Promise<SearchHit[]> {
  const visibleChannel = channelVisibilitySql(userId, companyId);

  // THE THREE FILTERS THE INDEX DOES NOT ENFORCE. The GIN index makes this
  // fast; it makes nothing safe. Each of these has to be written here, and a
  // missing one fails silently — as extra results, never as an error:
  //
  //   * m."deletedAt" IS NULL — the vector is computed from "body" alone and
  //     knows nothing about tombstones, so a soft-deleted message still
  //     matches its own text and would surface in a palette that the timeline
  //     renders as "message deleted".
  //   * m."companyId" = the session's company — never a caller's. Message
  //     carries the denormalized company scope precisely so a workspace-wide
  //     sweep like this one need not infer tenancy from the join.
  //   * the channel-visibility join — see channelVisibilitySql above. Company
  //     scope is not visibility: every message here is already in my company,
  //     and that says nothing about whether I am in its channel.
  const rows = await db.$queryRaw<MessageSearchRow[]>`
    SELECT ranked."id",
           ranked."authorName",
           ranked."channelSlug",
           ranked."channelName",
           ranked."channelKind",
           ts_headline('english',
                       ranked."body",
                       websearch_to_tsquery('english', ${q}),
                       ${HEADLINE_OPTIONS}) AS "snippet"
      FROM (
        SELECT m."id",
               m."body",
               m."authorName",
               m."createdAt",
               ch."slug" AS "channelSlug",
               ch."name" AS "channelName",
               ch."kind" AS "channelKind",
               ts_rank(m."searchVector", websearch_to_tsquery('english', ${q})) AS "rank"
          FROM "Message" m
          JOIN "Channel" ch
            ON ch."id" = m."channelId"
           AND ${visibleChannel}
         WHERE m."companyId" = ${companyId}
           AND m."deletedAt" IS NULL
           -- TEXT MESSAGES ONLY, and this is a security filter rather than
           -- a tidiness one. A card message carries its content in the
           -- payload column, which lib/queries/chat.ts redacts per viewer so
           -- a member never receives the company's cash position. Nothing
           -- redacts the body column, because for a text message there is
           -- nothing to redact -- so the day the Runway post path writes a
           -- figure into body as a notification or rail preview (the natural
           -- place to put it), that figure would arrive in a member's palette
           -- inside a ts_headline snippet, straight past the redaction.
           -- Excluding non-text kinds here means search cannot become the
           -- hole, whatever the post path decides to store. Widen this only
           -- alongside a redaction story for whatever kind is admitted.
           -- (No backticks in this comment: it lives inside a tagged template
           -- literal, where a backtick ends the query.)
           AND m."kind" = 'text'
           AND m."searchVector" @@ websearch_to_tsquery('english', ${q})
         ORDER BY "rank" DESC, m."createdAt" DESC
         -- The cast is not decoration: LIMIT accepts bigint only, and a bound
         -- parameter here arrives with whatever numeric type the driver chose
         -- for it. Casting pins the type rather than leaving the query one
         -- driver detail away from "argument of LIMIT must be type bigint".
         LIMIT ${GROUP_LIMIT}::bigint
      ) ranked
     ORDER BY ranked."rank" DESC, ranked."createdAt" DESC
  `;

  return rows.map((row) => ({
    group: "message" as const,
    id: row.id,
    // ON THE DM LABEL: `Channel.name` on a DM is a static "Alice & Bob"
    // fallback written once by whoever opened it, and it reads wrong from the
    // other end — Ayesha must not see a result filed under "Ayesha". Resolving
    // it per viewer means `dmDisplayName` plus the membership roster, which is
    // a second query for one line of a palette row. The author's name is
    // already denormalized on the message and is the honest answer to "who
    // said this"; the conversation's own header, which IS resolved per viewer,
    // is one Enter away.
    title:
      row.channelKind === "dm"
        ? `${row.authorName} in a direct message`
        : // See `conversationTitle`: a private channel is addressed by its bare
          // name, because the hash is what a public room wears.
          `${row.authorName} in ${conversationTitle(row.channelKind, row.channelName)}`,
    subtitle: stripHeadlineMarkup(row.snippet),
    // Matches the deep link `sendMessageAction` already writes into its
    // mention notifications — deliberately one shape, not two.
    //
    // AND IT IS READ, as of chat-010. This comment carried an "HONEST
    // LIMITATION: nothing reads `?message=` yet" for as long as that was true,
    // and it stopped being true in the same change that closed chat-010 —
    // leaving the one place in the repo that told the next reader about this
    // asserting the opposite of the code. app/(app)/chat/[slug]/chat-client.tsx
    // reads the parameter, `nextAnchorStep` in lib/chat/anchor.ts decides what to
    // do with it, and <MessageList> marks and scrolls to the row. The thread case
    // this comment named as a prerequisite is handled too: a hit whose `parentId`
    // is non-null opens the panel rather than scrolling the timeline.
    //
    // Still not done, so that the next reader is not misled the other way: an
    // anchor older than the newest loaded page is NOT paged towards — it falls
    // back to a line pointing at "Load earlier messages".
    href: `/chat/${row.channelSlug}?message=${row.id}`,
  }));
}

/**
 * Tasks, by title.
 *
 * ON THE MEMBER SCOPE — a deliberate choice, written down because the obvious
 * alternative looks more generous and is worse. `canSeeProject` would let a
 * member-supervisor find every task inside a project they supervise, and that
 * would not be a leak. But a task hit's href is the GLOBAL board, and
 * `getTasks()` in lib/queries/tasks.ts narrows that board for a member to
 * `assignedTo: userId`. A hit the board will not render is a dead result: the
 * palette closes, the page navigates, the highlight ring finds nothing, and
 * the user concludes search is broken. So the scope here mirrors the
 * DESTINATION, which is strictly narrower than the permission and therefore
 * cannot leak. Project-scoped task search belongs with a project-scoped
 * destination, if that is ever wanted.
 *
 * Title only, not description: the palette row shows the title, and a hit
 * whose match is invisible in the row reads as a wrong result.
 */
async function searchTasks(
  q: string,
  userId: string,
  companyId: string,
  role: Role
): Promise<SearchHit[]> {
  const rows = await db.task.findMany({
    where: {
      companyId,
      deletedAt: null,
      title: { contains: q, mode: "insensitive" },
      // A tombstoned project's tasks are gone from every other surface.
      project: { deletedAt: null },
      ...(canSeeAllProjects(role) ? {} : { assignedTo: userId }),
    },
    select: { id: true, title: true, project: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: GROUP_LIMIT,
  });

  return rows.map((row) => ({
    group: "task" as const,
    id: row.id,
    title: row.title,
    subtitle: row.project?.name ?? null,
    href: `/tasks?taskId=${row.id}`,
  }));
}

/**
 * Projects, by name.
 *
 * The non-admin branch is the query form of `canSeeProject`: supervise it, or
 * hold a task in it. It is copied from `listProjectsForUser`'s own where
 * clause deliberately — same rule, same page the href lands on, so a hit is
 * always a project `/projects/[id]` will actually render instead of 404ing
 * through `getProjectForUser`.
 */
async function searchProjects(
  q: string,
  userId: string,
  companyId: string,
  role: Role
): Promise<SearchHit[]> {
  const rows = await db.project.findMany({
    where: {
      companyId,
      deletedAt: null,
      name: { contains: q, mode: "insensitive" },
      ...(canSeeAllProjects(role)
        ? {}
        : {
            OR: [
              { supervisorId: userId },
              { tasks: { some: { assignedTo: userId, deletedAt: null } } },
            ],
          }),
    },
    select: { id: true, name: true, description: true },
    orderBy: { createdAt: "desc" },
    take: GROUP_LIMIT,
  });

  return rows.map((row) => ({
    group: "project" as const,
    id: row.id,
    title: row.name,
    subtitle: row.description,
    href: `/projects/${row.id}`,
  }));
}

/**
 * Transactions, by description or category. ONLY EVER CALLED FOR A ROLE THAT
 * PASSES `canSeeFinances` — see `searchWorkspace`.
 *
 * No supervisor escape hatch here, unlike `canSeeProjectFinances`. That hatch
 * exists so a member supervising a project can manage its budget INSIDE the
 * project page; every destination this group can offer (/expenses,
 * /investments, /revenue) is on MEMBER_BLOCKED_ROUTES, so a hit would be a
 * result that bounces the moment it is opened.
 */
async function searchTransactions(q: string, companyId: string): Promise<SearchHit[]> {
  const rows = await db.transaction.findMany({
    where: {
      companyId,
      deletedAt: null,
      // `%` and `_` in the term act as ILIKE wildcards. They are bound
      // parameters, not SQL, so this is a slightly surprising match at worst —
      // escaping them would also stop anyone searching for a literal "%".
      OR: [
        { description: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, description: true, category: true, type: true },
    orderBy: { date: "desc" },
    take: GROUP_LIMIT,
  });

  return rows.map((row) => ({
    group: "transaction" as const,
    id: row.id,
    title: row.description,
    subtitle: row.category,
    // No amount in the subtitle on purpose: it is a Prisma.Decimal that would
    // need converting, and rendering it needs the workspace currency, which is
    // another query for a palette row. The destination page shows the figure.
    href: transactionHref(row.type),
  }));
}

/**
 * Budgets, by category. ONLY EVER CALLED FOR A ROLE THAT PASSES
 * `canSeeFinances` — see `searchWorkspace`.
 *
 * Paused budgets are included, ordered after active ones, matching
 * lib/queries/budgets.ts: /budgets lists both, so search should find both.
 */
async function searchBudgets(q: string, companyId: string): Promise<SearchHit[]> {
  const rows = await db.budget.findMany({
    where: {
      companyId,
      deletedAt: null,
      category: { contains: q, mode: "insensitive" },
    },
    select: { id: true, category: true, project: { select: { name: true } } },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    take: GROUP_LIMIT,
  });

  return rows.map((row) => ({
    group: "budget" as const,
    id: row.id,
    title: row.category,
    subtitle: row.project?.name ?? null,
    href: "/budgets",
  }));
}

/**
 * Search everything the caller is allowed to see, grouped by content type.
 *
 * Returns groups in `SEARCH_GROUPS` order with empty ones OMITTED, so the
 * palette renders a heading only where there is something under it.
 */
export async function searchWorkspace(q: string): Promise<SearchResults> {
  const { userId, companyId, role } = await requireScopedSession();

  // Re-validate rather than trust the caller. `searchAction` parses too, but
  // this is an exported query entry point and an RSC could call it directly
  // with a raw string; the minimum-length rule is the thing standing between
  // type-ahead and five full scans per keystroke, so it is enforced at the
  // boundary that actually runs the queries. A rejected term is an empty
  // result, not a throw — there is nothing for an error boundary to say about
  // someone having typed one character.
  const parsed = SearchQuerySchema.safeParse({ q });
  if (!parsed.success) return { groups: [] };
  const term = parsed.data.q;

  // THE FINANCE GATE. `canSeeFinances` is the existing predicate — the same
  // one that decides MEMBER_BLOCKED_ROUTES in the middleware and the sidebar —
  // and it is asked once, here.
  //
  // WHY THIS SKIPS THE QUERY RATHER THAN FILTERING ITS RESULTS: a member's
  // search does not run a transaction query or a budget query at all. Filtering
  // afterwards would mean the rows were read (so a bug in the filter is a
  // leak rather than a no-op), it would cost two round trips per keystroke for
  // output that is discarded, and the timing difference between "member typed
  // a term that matches 40 expenses" and "member typed a term that matches
  // none" would still be observable from the outside. An unasked question
  // leaks nothing and takes no time. The empty arrays below are constants, not
  // results — and because empty groups are omitted, a member never even sees
  // the heading.
  const finance = canSeeFinances(role);
  const none: SearchHit[] = [];

  // Independent queries, so they overlap on the wire. Run in sequence the
  // palette would wait for the slowest chain instead of the slowest query.
  const [tasks, projects, messages, transactions, budgets] = await Promise.all([
    searchTasks(term, userId, companyId, role),
    searchProjects(term, userId, companyId, role),
    searchMessages(term, userId, companyId),
    finance ? searchTransactions(term, companyId) : Promise.resolve(none),
    finance ? searchBudgets(term, companyId) : Promise.resolve(none),
  ]);

  const byGroup: Record<SearchGroup, SearchHit[]> = {
    task: tasks,
    project: projects,
    message: messages,
    transaction: transactions,
    budget: budgets,
  };

  // Driven by SEARCH_GROUPS, not by the array above: the render order lives in
  // lib/schemas/search.ts and adding a group there is a type error here until
  // it is wired up, rather than a group that silently never renders.
  return {
    groups: SEARCH_GROUPS.map((group) => ({ group, hits: byGroup[group] })).filter(
      (entry) => entry.hits.length > 0
    ),
  };
}
