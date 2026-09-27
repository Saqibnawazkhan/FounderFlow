"use server";

/**
 * The server action behind the command palette.
 *
 * This is a thin wrapper and nothing else. The palette is a client component,
 * so it cannot import lib/queries/search.ts — that module reaches for the
 * Prisma client and the session, both server-only — and this file exists to
 * give it a callable door. Every decision worth making (what a member may
 * search, which channels a message may come from, how a term is validated)
 * lives behind that door, in the query and in lib/auth/. Nothing about
 * permissions is decided here, deliberately: an access rule written in a
 * server action is a rule the RSC callers of the query do not get.
 *
 * There is no `revalidatePath` anywhere below. This is a read.
 */

import { auth } from "@/lib/auth";
import { limiters } from "@/lib/rate-limit";
import { SearchQuerySchema } from "@/lib/schemas/search";
import { searchWorkspace, type SearchResults } from "@/lib/queries/search";
import { captureServerError } from "@/lib/sentry-server";
import type { ActionResult } from "@/lib/actions/types";

/**
 * Search the caller's workspace.
 *
 * DELIBERATELY NOT RATE LIMITED, and specifically not under `limiters.write`.
 * This fires on every debounced keystroke-burst in the palette, which makes it
 * one of the highest-frequency calls in the product — and `limiters.write` is
 * a single 60-per-minute bucket SHARED across every write that user makes. A
 * couple of minutes of searching would burn that budget, and the next thing
 * rejected would not be a search: it would be the user's next message, task or
 * expense. That bug reads as "sometimes saving fails, but only when I'm busy",
 * which lands on a different action from the one that caused it and never
 * reproduces on a quiet account. The same reasoning `markChannelReadAction`
 * spells out for its own exemption, for the same reason: a read must never be
 * able to spend a write's budget.
 *
 * It IS limited, under `limiters.read` — a separate 120/min bucket added for
 * exactly this call site, so the abuse worth pricing (a scripted term-by-term
 * enumeration of a workspace, which drives four unindexed ILIKE scans per
 * request) is bounded without a search ever being able to spend a write's
 * budget. A person typing behind a 200ms debounce does not come close.
 *
 * The other protections still apply and are not replaced by the bucket: a
 * session is required, every group is capped at five rows, the minimum term
 * length keeps the cheapest-to-abuse query off the table, and nothing is
 * returned that the caller could not reach by navigating.
 */
export async function searchAction(input: unknown): Promise<ActionResult<SearchResults>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    // `requireScopedSession` inside the query would throw on this too. Checking
    // here turns a signed-out palette (an expired tab, a bumped
    // sessionVersion) into an ordinary envelope the client can render, instead
    // of an unhandled rejection in a fetch nobody is awaiting carefully.
    return { success: false, error: "Not authenticated" };
  }

  // Keyed on the user, not the IP: a shared office NAT must not let one
  // colleague's typing throttle everyone else's.
  const gate = limiters.read.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = SearchQuerySchema.safeParse(input);
  // No field-level message: the palette knows what it sent, and the only way
  // to fail this parse is a term below two characters or above a hundred,
  // which the UI should be rendering as "keep typing" rather than as an error.
  if (!parsed.success) return { success: false, error: "Invalid request" };

  try {
    // No companyId, userId or role crosses this call. The query takes the
    // term and nothing else, and resolves who is asking from the session
    // itself — see rule 1 in lib/queries/search.ts.
    const data = await searchWorkspace(parsed.data.q);
    return { success: true, data };
  } catch (e) {
    captureServerError(e, {
      action: "searchAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    // Generic on purpose: a database error message from a search box is a
    // free description of the schema.
    return { success: false, error: "Couldn't run that search right now." };
  }
}
