"use client";

/**
 * Command palette — the actual behavior behind the topbar search input and
 * the global ⌘K / Ctrl-K shortcut.
 *
 * TWO SEARCHES, ONE LIST (Phase H). Nav destinations are filtered locally and
 * instantly; workspace content — tasks, projects, chat messages, and, only for
 * a role allowed to see money, transactions and budgets — comes back from
 * `searchAction` on a debounce and renders in groups BELOW the nav hits.
 *
 * WHY NAV STAYS LOCAL: nav filtering is a substring match over fifteen items
 * already in memory. Putting it behind the same round trip as the workspace
 * search would add 200ms of debounce plus a database query to the single most
 * used thing in this component — jumping to a page — to buy nothing. The two
 * halves are deliberately on different clocks.
 *
 * WHY BOTH A DEBOUNCE AND A REQUEST-ID GUARD. They solve different problems
 * and neither covers the other:
 *   • The debounce limits HOW OFTEN we ask. Without it every keystroke is five
 *     queries against the workspace, and the answers to all but the last are
 *     thrown away.
 *   • The request id decides WHOSE ANSWER WE KEEP. Two requests can be in
 *     flight at once (a pause mid-word fires one, then typing resumes) and
 *     nothing makes them come back in order — the "bud" query can out-run the
 *     "budget" query it preceded, and the palette would end up showing results
 *     for a term nobody is looking at any more. A counter captured before the
 *     await and re-read after it means a late answer is dropped on the floor.
 * An `AbortController` is not a substitute: a server action's promise is not
 * reliably abortable, so the response still arrives and still needs judging.
 * `remote.term` gives the same rule a second, dumber expression at render
 * time — results are only ever painted next to the term they were asked for.
 *
 * WHAT THIS COMPONENT MUST NOT DO: it must not invent groups. The server
 * returns groups in `SEARCH_GROUPS` order with the EMPTY ONES ALREADY OMITTED,
 * and for a member the absence of `transaction` / `budget` IS the finance
 * gate. Rendering a heading for a group we did not receive, or hardcoding the
 * list of sections here, would either fake a gate or hide a new content type —
 * so the render iterates what arrived, and the label/icon lookups are
 * exhaustive `Record<SearchGroup, …>`s that stop a build if the union grows.
 *
 * Interaction model:
 *  - ⌘K / Ctrl-K anywhere opens the palette (mounted globally in Topbar).
 *  - Escape or backdrop click closes, and focus goes back to whatever opened it.
 *  - Arrow up/down cycles items, Enter navigates. Nav hits and workspace hits
 *    are ONE flat sequence — nobody arrowing down thinks in sections — so the
 *    arrow keys walk straight from the last nav row into the first task hit.
 *  - Tab and Shift-Tab WRAP INSIDE THE SHEET and cannot leave it (audit
 *    a11y-006: they used to walk out into the page behind the backdrop, which
 *    `aria-modal="true"` had already promised was not there). Because this is an
 *    `aria-activedescendant` combobox, the rows are deliberately not tab stops
 *    of their own — DOM focus stays in the search box and the box points at the
 *    active row, which is the only arrangement a screen reader announces
 *    correctly. In practice that means Tab keeps focus in the box; ↑ ↓ move and
 *    ↵ opens, exactly as the footer says.
 *  - While it is open, everything outside it is `aria-hidden` + `inert` — see
 *    lib/hooks/use-focus-trap.ts for the whole of that contract.
 *  - Query normalizes to lowercase and matches label OR href tail, so a user
 *    can type "tasks" or "tasks page" or "/tas" and land the same result.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Briefcase,
  CheckSquare,
  Command,
  Loader2,
  MessageSquare,
  Search,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import { useStore } from "@/lib/store";
import { searchAction } from "@/lib/actions/search";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH, type SearchGroup } from "@/lib/schemas/search";
import type { SearchHit, SearchResults } from "@/lib/queries/search";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * ~200ms. Long enough that a burst of typing costs one query instead of six,
 * short enough that a pause feels like the results were already there.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** Stable identity for "no workspace results", so the memos below don't churn. */
const EMPTY_GROUPS: SearchResults["groups"] = [];

/**
 * One icon per content type. Exhaustive by type: adding a member to
 * `SEARCH_GROUPS` breaks the build HERE, which is the point — the alternative
 * is a new group shipping as an unlabelled, iconless section nobody notices.
 */
const GROUP_ICONS: Record<SearchGroup, LucideIcon> = {
  task: CheckSquare,
  project: Briefcase,
  message: MessageSquare,
  transaction: Wallet,
  budget: Target,
};

/** What the server returned, plus the term it answers. */
type RemoteState = {
  /**
   * `SearchResults` deliberately does not echo the query, so the term is
   * recorded here at the moment the response is accepted. It is what lets the
   * render refuse to show an answer next to a question it does not match.
   */
  term: string;
  groups: SearchResults["groups"];
  /** A real failure worth telling the user about — never a too-short term. */
  error: string | null;
};

/** A hit plus its position in the ONE flat keyboard sequence. */
type NumberedHit = { hit: SearchHit; index: number };

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const t = useT();
  const currentUser = useStore((s) => s.currentUser);
  const role: Role = (currentUser?.role as Role | undefined) ?? "member";
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /**
   * Monotonic request counter. Incremented on every term change (and on open),
   * captured before the await, compared after. See the header comment: this,
   * not the debounce, is what stops a slow earlier query from painting over a
   * fast later one.
   */
  const requestIdRef = useRef(0);
  const listboxId = useId();
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId]);

  // Reset query + active index every time the palette opens so a user who
  // fired Cmd-K, typed something, closed, then re-opened gets a fresh sheet.
  // The workspace half resets too, and the request id moves so that a response
  // still in flight from the previous open lands on a dead id.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    setRemote(null);
    setSearching(false);
    requestIdRef.current += 1;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      // Closing invalidates in-flight work too. The component stays mounted
      // when `open` flips false, so without this a response arriving after the
      // close would settle state for a palette nobody is looking at.
      requestIdRef.current += 1;
    };
  }, [open]);

  const visibleItems = useMemo(
    () => (role === "member" ? NAV_ITEMS.filter((i) => !isMemberBlockedRoute(i.href)) : NAV_ITEMS),
    [role]
  );

  const navResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = visibleItems.map((item) => ({ ...item, label: t.nav[item.labelKey] }));
    if (!q) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.href.toLowerCase().includes(q)
    );
  }, [query, visibleItems, t]);

  // The term the server sees. Trimmed here as well as in the schema so the
  // length checks below agree with the ones that would reject the request.
  const term = query.trim();

  useEffect(() => {
    if (!open) return;

    // Bump first, unconditionally: whatever was in flight is now answering a
    // question that is no longer on screen, including when the user deletes
    // back down to one character.
    const requestId = ++requestIdRef.current;

    // Outside the schema's bounds the action answers "Invalid request". That
    // is not an error state, it is "keep typing" — so we simply never ask, and
    // the palette shows nav results only. (The input's maxLength makes the
    // upper bound practically unreachable; it is still checked, because the
    // value can also arrive from the browser restoring a session.)
    if (term.length < SEARCH_MIN_LENGTH || term.length > SEARCH_MAX_LENGTH) {
      setSearching(false);
      setRemote(null);
      return;
    }

    // Set before the debounce elapses on purpose. The honest state while a
    // keystroke is settling is "we are looking", not the previous term's
    // results wearing this term's label.
    setSearching(true);

    const timer = setTimeout(() => {
      void (async () => {
        const res = await searchAction({ q: term });
        // THE GUARD. A newer request (or a close, or a drop below the minimum)
        // has moved the counter: this answer is stale, drop it. Note it is
        // checked before every setState, so a late response cannot even clear
        // the spinner belonging to a newer one.
        if (requestId !== requestIdRef.current) return;
        setSearching(false);
        setRemote(
          res.success
            ? { term, groups: res.data.groups, error: null }
            : { term, groups: EMPTY_GROUPS, error: res.error }
        );
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, term]);

  // Only ever render results that belong to the term currently in the box.
  const remoteMatchesTerm = remote !== null && remote.term === term;
  const remoteGroups = useMemo(
    () => (remote && remote.term === term ? remote.groups : EMPTY_GROUPS),
    [remote, term]
  );
  const remoteError = remote && remote.term === term ? remote.error : null;
  /** A request for THIS term has come back. The only license to say "nothing". */
  const settled = remoteMatchesTerm && !searching;

  const groupLabels: Record<SearchGroup, string> = useMemo(
    () => ({
      task: t.nav.tasks,
      project: t.nav.projects,
      // Messages live in Chat, and that is the word in the sidebar for them.
      message: t.nav.chat,
      // Not "Expenses": a transaction hit can be an expense, a revenue line or
      // an investment, and `t.nav.finance` is the existing heading that covers
      // all three. Reusing the five keys the dictionary already has keeps the
      // palette translated without adding strings this phase.
      transaction: t.nav.finance,
      budget: t.nav.budgets,
    }),
    [t]
  );

  // Number the hits continuously after the nav rows: one flat sequence for the
  // arrow keys, even though the eye sees sections.
  const groupSections = useMemo(() => {
    let cursor = navResults.length;
    return remoteGroups.map((section) => ({
      group: section.group,
      hits: section.hits.map<NumberedHit>((hit) => ({ hit, index: cursor++ })),
    }));
  }, [navResults.length, remoteGroups]);

  /** Every selectable row, in render order. Index === keyboard position. */
  const flatHrefs = useMemo(() => {
    const hrefs = navResults.map((i) => i.href);
    // .forEach rather than a nested spread: tsconfig has no downlevelIteration.
    groupSections.forEach((section) => {
      section.hits.forEach((h) => hrefs.push(h.hit.href));
    });
    return hrefs;
  }, [navResults, groupSections]);

  const hasResults = flatHrefs.length > 0;

  // Clamp activeIdx when the result set shrinks (typing "z" after sitting on
  // item 8 shouldn't leave `activeIdx=8` pointing off the end). Workspace hits
  // arriving late only ever grow the list, so they need no special case.
  useEffect(() => {
    if (activeIdx >= flatHrefs.length) setActiveIdx(Math.max(0, flatHrefs.length - 1));
  }, [flatHrefs.length, activeIdx]);

  // Keep the highlighted row on screen. The list used to be fifteen nav items
  // that fit; with workspace groups under them, arrowing down walks straight
  // out of the scroll box and the highlight disappears.
  useEffect(() => {
    if (!open || !hasResults) return;
    document.getElementById(optionId(activeIdx))?.scrollIntoView({ block: "nearest" });
  }, [open, hasResults, activeIdx, optionId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const count = flatHrefs.length;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (count ? (i + 1) % count : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (count ? (i - 1 + count) % count : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const href = flatHrefs[activeIdx];
        if (href) navigate(href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // navigate is stable-enough (router ref); flatHrefs/activeIdx are the real deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flatHrefs, activeIdx]);

  // Everything `aria-modal="true"` above actually promises: Tab cannot leave the
  // sheet, the page behind is out of the accessibility tree while it is open,
  // and focus returns to whatever opened it. The declaration and the behaviour
  // are now the same thing.
  useFocusTrap(open, dialogRef);

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t.common.search}
      className="fixed inset-0 z-modal flex items-start justify-center px-4 pt-24 md:pt-32"
    >
      {/* Backdrop — PRESENTATIONAL, and it stays FIRST in DOM order.
          It is a full-viewport <button> so that clicking or tapping outside the
          sheet closes the palette without a div carrying a click handler, but it
          is `tabIndex={-1}` and `aria-hidden` because it is invisible: as a real
          tab stop it was where Shift-Tab from the search box landed, an
          unannounceable full-screen control one keypress from the page behind
          (audit a11y-006). The keyboard and screen-reader way out is Escape,
          which the ESC legend in the footer advertises.
          The auditor suggested moving it AFTER the sheet instead. That would
          break the palette: both siblings are positioned with `z-index: auto`,
          so the later one paints on top — the backdrop would cover the sheet and
          swallow every click meant for a result row. `tabIndex={-1}` fixes the
          focus order without touching the paint order. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
      />

      {/* Sheet */}
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-fg-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.common.search}
            aria-label={t.common.search}
            // Same ceiling the schema enforces, so a paste can't put the box
            // into a state whose only possible answer is "Invalid request".
            maxLength={SEARCH_MAX_LENGTH}
            role="combobox"
            aria-expanded={hasResults}
            aria-controls={hasResults ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={hasResults ? optionId(activeIdx) : undefined}
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
          />
          {searching && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-muted" aria-hidden="true" />
          )}
          <kbd className="hidden items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted sm:inline-flex">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="scrollbar-thin max-h-80 overflow-y-auto p-2">
          {!hasResults ? (
            // Only once nothing is in flight. "No results" under a query that
            // is still being answered is a lie that flickers away a moment
            // later; while `searching` is true the status line below speaks
            // instead.
            !searching && (
              <div className="px-3 py-6 text-center text-sm text-fg-muted">
                {t.common.noResults ?? "No results"}
              </div>
            )
          ) : (
            <div id={listboxId} role="listbox" aria-label={t.common.search}>
              {navResults.map((item, i) => {
                const Icon = item.icon;
                const active = i === activeIdx;
                return (
                  <button
                    key={item.href}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    // Not a tab stop: DOM focus belongs to the combobox above,
                    // which names the active row via aria-activedescendant. A
                    // focusable `role="option"` makes that pointer a lie — a
                    // screen reader announces the focused button and ignores it.
                    tabIndex={-1}
                    aria-selected={active}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => navigate(item.href)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      active ? "bg-primary/10 text-fg" : "text-fg-muted hover:bg-surface-hover"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1 font-medium">{item.label}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      {item.href}
                    </span>
                    {active && (
                      <ArrowRight className="h-3.5 w-3.5 text-primary-strong" aria-hidden="true" />
                    )}
                  </button>
                );
              })}

              {/* Whatever the server sent, in the order it sent it. No section
                  is rendered from a hardcoded list, and none is synthesized
                  when a group is missing — a missing group is an answer. */}
              {groupSections.map((section) => {
                const label = groupLabels[section.group] ?? section.group;
                const Icon = GROUP_ICONS[section.group] ?? Search;
                return (
                  <div key={section.group} role="group" aria-label={label} className="pt-1">
                    <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      {label}
                    </div>
                    {section.hits.map(({ hit, index }) => {
                      const active = index === activeIdx;
                      return (
                        <button
                          key={`${hit.group}:${hit.id}`}
                          id={optionId(index)}
                          type="button"
                          role="option"
                          // Same reason as the nav rows above: arrow keys move,
                          // aria-activedescendant announces, focus stays put.
                          tabIndex={-1}
                          aria-selected={active}
                          onMouseEnter={() => setActiveIdx(index)}
                          onClick={() => navigate(hit.href)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                            active ? "bg-primary/10" : "hover:bg-surface-hover"
                          )}
                        >
                          <Icon
                            className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-fg">{hit.title}</span>
                            {hit.subtitle && (
                              // PLAIN TEXT. The server already stripped
                              // ts_headline's <b> markup, and this is a
                              // user-typed chat message either way — it is
                              // rendered as a text node, never as HTML.
                              <span className="block truncate text-xs text-fg-muted">
                                {hit.subtitle}
                              </span>
                            )}
                          </span>
                          {active && (
                            <ArrowRight
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-strong"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Status for the workspace half only — the nav half never has one to
            report. Announced politely so a screen reader hears the search
            finish without losing the caret in the input. */}
        {(searching || remoteError || (settled && remoteGroups.length === 0 && hasResults)) && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-fg-muted"
          >
            {searching ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span>Searching…</span>
              </>
            ) : remoteError ? (
              <span>{remoteError}</span>
            ) : (
              <span>{t.common.noResults ?? "No results"}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border bg-bg/40 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <Command className="h-3 w-3" aria-hidden="true" /> K
          </span>
          <span>↑ ↓ to move · ↵ to open</span>
        </div>
      </div>
    </div>
  );
}
