"use client";

/**
 * <NewDmModal> — the people picker behind the rail's "new direct message"
 * control.
 *
 * NOT a react-hook-form form, deliberately. There is no field to validate:
 * the only input is "which teammate", and the answer is always one of a list
 * the server already handed us. A form here would buy a resolver, an error
 * slot and a submit button for a gesture that is really a filter over a
 * roster — so this is a search box and a list of buttons, and the one schema
 * that matters (`OpenDmSchema`) is enforced where it can't be bypassed, on
 * the server.
 *
 * WHY THE PICKER KNOWS ABOUT `existingSlug`: re-opening a conversation you
 * already have is a navigation, not a write. `openDmAction` is idempotent, so
 * routing every click through it would still land in the right room — but it
 * would spend a write rate-limit token, a round trip and a `revalidatePath`
 * to learn a slug the query layer already told us. So a candidate carrying an
 * `existingSlug` is handed straight to `onOpened`; only a first conversation
 * calls the action.
 *
 * WHY ONLY ONE ROW MAY BE PENDING: two clicks racing on the same teammate is
 * exactly the fork `@@unique([companyId, dmKey])` exists to catch, and the
 * action's P2002 handler turns that race back into a successful open. That is
 * a safety net, not a licence to generate the race — the UI should not be
 * firing the second click in the first place, so `pendingId` disables the
 * whole list while a DM is being created.
 *
 * a11y: a `<ul>` of `<li><button>` (a list of people, announced as one), an
 * sr-only label on the search input, and `aria-busy` on the row that is
 * currently opening.
 */

import { useId, useState } from "react";
import { Loader2, Search } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { Modal } from "@/components/ui/modal";
import { openDmAction } from "@/lib/actions/chat";
import { slugifyName } from "@/lib/comments/mentions";
import { cn } from "@/lib/utils";
import type { DmCandidate } from "@/lib/queries/chat";

type Props = {
  open: boolean;
  onClose: () => void;
  candidates: DmCandidate[];
  onOpened: (slug: string) => void;
};

export function NewDmModal({ open, onClose, candidates, onOpened }: Props) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  /** The candidate whose DM is being created, or null. At most one, ever. */
  const [pendingId, setPendingId] = useState<string | null>(null);

  // No debounce: this list is the size of a company, the filter is a
  // `String.includes` over names already in memory, and there is no request
  // behind a keystroke. A debounce here would only add lag to a local filter.
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter((c) => c.name.toLowerCase().includes(needle))
    : candidates;

  const busy = pendingId !== null;

  function handleClose() {
    // The filter is scratch state, not a preference. Reopening the picker to
    // last session's half-typed "ay" and a one-row list reads as a roster
    // that lost people.
    setQuery("");
    onClose();
  }

  async function handlePick(candidate: DmCandidate) {
    // Belt and braces behind `disabled` — a keyboard Enter on a row that is
    // mid-render, or a double-fire from a trackpad, should not start a second
    // create for the same pair.
    if (busy) return;

    if (candidate.existingSlug) {
      // The whole point of `existingSlug`: no action, no rate-limit token, no
      // revalidate. This is a link that happens to be spelled as a button
      // because the parent owns the routing.
      onOpened(candidate.existingSlug);
      return;
    }

    setPendingId(candidate.id);
    const res = await openDmAction({ userId: candidate.id });
    setPendingId(null);
    if (!res.success) {
      // The action's own words — it knows the difference between "that
      // teammate is no longer here" and a rate limit, and paraphrasing here
      // would flatten both into something less true.
      toast.error(res.error);
      return;
    }
    onOpened(res.data.slug);
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New direct message"
      description="Pick a teammate to start a one-to-one conversation."
      size="md"
    >
      <div className="flex flex-col gap-3">
        {/* The search box is hidden when there is nobody to search: an empty
            filter over an empty roster is furniture that implies the list is
            merely filtered down, which is the opposite of what happened. */}
        {candidates.length > 0 && (
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-bg px-3.5 py-2.5 focus-within:border-primary/50">
            <Search className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
            <label htmlFor={searchId} className="sr-only">
              Search teammates
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teammates…"
              // No autoFocus: Radix moves focus into the dialog itself on
              // open, and a second claim on focus fights it for the same
              // frame — which on some browsers lands focus nowhere at all.
              className="w-full bg-transparent text-sm text-fg placeholder:text-fg-muted/70 focus:outline-none"
            />
          </div>
        )}

        {candidates.length === 0 ? (
          <EmptyState>
            You&apos;re the only person in this workspace — invite someone from the Team page.
          </EmptyState>
        ) : matches.length === 0 ? (
          <EmptyState>No teammates match that.</EmptyState>
        ) : (
          <ul className="scrollbar-thin -mx-1 max-h-80 space-y-0.5 overflow-y-auto px-1">
            {matches.map((candidate) => {
              const pending = candidate.id === pendingId;
              return (
                <li key={candidate.id} aria-busy={pending || undefined}>
                  <button
                    type="button"
                    onClick={() => handlePick(candidate)}
                    // Every row goes dead while one is opening, not just the
                    // pending one — clicking a DIFFERENT teammate mid-create
                    // would leave two conversations half-opened and the
                    // caller navigated to whichever resolved last.
                    disabled={busy}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      "hover:bg-glass/[0.06] disabled:cursor-not-allowed",
                      // The pending row keeps full contrast; the rest dim, so
                      // "which one am I waiting on" is answerable at a glance.
                      busy && !pending && "opacity-50"
                    )}
                  >
                    <Avatar name={candidate.name} size="xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-fg">
                        {candidate.name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-fg-muted">
                        @{slugifyName(candidate.name)}
                      </span>
                    </span>
                    {pending ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        Opening…
                      </span>
                    ) : (
                      // Two different promises, so two different words:
                      // "Open" goes to a conversation that already exists,
                      // "Message" creates one. Telling someone they are about
                      // to start a chat they have had for months is a small
                      // lie the query layer gave us the means to avoid.
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[10px] uppercase tracking-wider",
                          candidate.existingSlug ? "text-primary-strong" : "text-fg-muted"
                        )}
                      >
                        {candidate.existingSlug ? "Open" : "Message"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-bg/40 px-4 py-8 text-center text-sm text-fg-muted">
      {children}
    </p>
  );
}
