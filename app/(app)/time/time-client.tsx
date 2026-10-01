"use client";

/**
 * /time client. Three responsibilities:
 *   1. Render the table of entries (current user's or the whole team's).
 *   2. Show a self ↔ team toggle for admins/cofounders.
 *   3. Open the edit modal for admins/cofounders (members never see it).
 *
 * Delete is owner-OR-privileged — members can scrub their own mistakes;
 * admins/cofounders can clean up anyone's row. The server action re-checks.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Clock, List, Pencil, Plus, Trash2, Users } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deleteTimeEntryAction } from "@/lib/actions/time";
import { canEditEntryTimes, durationMs, formatDuration, sumDurations } from "@/lib/time/thresholds";
import { WeeklyTimesheet } from "@/components/time/weekly-timesheet";
import { LocalTime, useMounted } from "@/components/time/local-time";
import { cn } from "@/lib/utils";
import type { TimeEntryClient } from "@/lib/queries/time";
import type { User } from "@/lib/types";
import { useNumberFormat } from "@/lib/i18n/use-t";
import { EditEntryModal } from "./edit-entry-modal";
import { ManualEntryModal } from "./manual-entry-modal";

type Props = {
  initialEntries: TimeEntryClient[];
  users: User[];
  tasks: { id: string; title: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  canSeeTeam: boolean;
  initialScope: "mine" | "team";
  /**
   * The SERVER's clock at render time (time-011).
   *
   * `renderedAt` was `useMemo(() => new Date())`, which runs once on the server
   * and again during hydration — two different instants — so an open entry's
   * duration differed between the two renders and React logged a mismatch. Taking
   * the instant from the RSC makes the server render and the first client render
   * identical by construction, and it is also more correct than the old version
   * after a `router.refresh()`: the memo never re-ran while the component stayed
   * mounted, so the page's "now" was frozen at first mount for ever.
   */
  serverNowMs: number;
  /**
   * True when `getEntries` hit its row ceiling, so `initialEntries` is the newest
   * window and not the whole history (time-010).
   */
  entriesTruncated: boolean;
  /**
   * `clockInAt` of the oldest loaded entry when the read was truncated, else null.
   * The Week view uses it to say a week is outside the loaded window instead of
   * drawing it as an empty week.
   */
  oldestLoadedAt: string | null;
};

export function TimeClient({
  initialEntries,
  users,
  tasks,
  currentUserId,
  currentUserRole,
  canSeeTeam,
  initialScope,
  serverNowMs,
  entriesTruncated,
  oldestLoadedAt,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const canEdit = canEditEntryTimes(currentUserRole);

  const [editing, setEditing] = useState<TimeEntryClient | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  // List ↔ Week view, persisted like the tasks view (T5 pattern).
  const [viewMode, setViewMode] = useState<"list" | "week">("list");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ff.time.view");
      if (saved === "list" || saved === "week") setViewMode(saved);
    } catch {
      // private-mode Safari can throw — fall back to the default.
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("ff.time.view", viewMode);
    } catch {}
  }, [viewMode]);

  // Cross-tab sync (X3): shared channel with the topbar clock widget. We
  // refresh when another tab changes the timer, and post on our own writes
  // (manual log / edit / delete) so other tabs — and the widget — keep up.
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("ff-time");
    ch.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === "time-changed") startTransition(() => router.refresh());
    };
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      ch.close();
    };
  }, [router]);

  function broadcastChange() {
    channelRef.current?.postMessage({ type: "time-changed" });
  }

  // Switching scope is a URL change so the RSC re-fetches.
  function switchScope(scope: "mine" | "team") {
    if (scope === initialScope) return;
    const url = scope === "team" ? "/time?scope=team" : "/time";
    startTransition(() => router.push(url));
  }

  // "Now" frozen at RENDER time — the server's render — for in-table duration
  // display. Running entries also have the topbar widget's live ticker; this is
  // the historical view, so a snapshot is what the user expects. See the
  // `serverNowMs` prop for why it is not `new Date()`.
  const renderedAt = useMemo(() => new Date(serverNowMs), [serverNowMs]);
  // Gates the one remaining timezone-dependent ATTRIBUTE below. Every VISIBLE
  // timestamp goes through <LocalTime>, which gates itself.
  const mounted = useMounted();

  const totalMs = useMemo(
    () =>
      sumDurations(
        initialEntries.map((e) => ({
          clockInAt: new Date(e.clockInAt),
          clockOutAt: e.clockOutAt ? new Date(e.clockOutAt) : null,
        })),
        renderedAt
      ),
    [initialEntries, renderedAt]
  );

  const n = useNumberFormat();
  const openCount = initialEntries.filter((e) => !e.clockOutAt).length;
  const autoClosedCount = initialEntries.filter((e) => e.autoClosed).length;
  // Own running entry — the one to surface prominently on this page. Team
  // scope shows the count in the KPI but we don't spotlight someone else's
  // in-progress session (privacy + noise).
  const myRunningEntry = useMemo(
    () =>
      initialScope === "mine"
        ? (initialEntries.find((e) => !e.clockOutAt && e.userId === currentUserId) ?? null)
        : null,
    [initialEntries, initialScope, currentUserId]
  );

  async function handleDelete(entry: TimeEntryClient) {
    const ok = await confirm({
      title: "Delete this time entry?",
      description: "Cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const res = await deleteTimeEntryAction(entry.id);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Entry deleted");
    broadcastChange();
    startTransition(() => router.refresh());
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="forest">
            <Clock className="me-1 inline h-3 w-3" aria-hidden="true" /> Time tracking
          </PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Time</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            {initialScope === "team"
              ? "Every founder + team member's logged hours."
              : "Your clocked sessions and the time they consumed."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canSeeTeam && (
            <div className="inline-flex w-fit gap-1 rounded-full border border-border bg-bg p-1">
              <button
                type="button"
                onClick={() => switchScope("mine")}
                aria-pressed={initialScope === "mine"}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  initialScope === "mine"
                    ? "bg-surface text-fg shadow-card"
                    : "text-fg-muted hover:text-fg"
                )}
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Mine
              </button>
              <button
                type="button"
                onClick={() => switchScope("team")}
                aria-pressed={initialScope === "team"}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  initialScope === "team"
                    ? "bg-surface text-fg shadow-card"
                    : "text-fg-muted hover:text-fg"
                )}
              >
                <Users className="h-3.5 w-3.5" aria-hidden="true" /> Team
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Log time
          </button>
        </div>
      </header>

      {myRunningEntry && (
        <RunningEntryBanner
          entry={myRunningEntry}
          now={renderedAt}
          note="Tick to keep tracking — clock out from the topbar widget when done."
        />
      )}

      <section aria-label="Time summary" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total tracked"
          value={formatDuration(totalMs)}
          icon={Clock}
          tone="forest"
          /* time-010. This read `${n} session${s}` unconditionally, over an array
             `getEntries` had capped — so past the ceiling the label stopped being
             a count of sessions and started disagreeing with /settings, which sums
             every row in SQL. The number is still the truth about the window; the
             label now says which window, rather than implying there is no other. */
          deltaLabel={
            entriesTruncated
              ? `${n.number(initialEntries.length)} most recent sessions`
              : `${n.number(initialEntries.length)} session${
                  initialEntries.length === 1 ? "" : "s"
                }`
          }
        />
        <DashboardStat
          label="Currently running"
          value={n.number(openCount)}
          icon={Clock}
          tone="primary"
          deltaLabel={openCount === 0 ? "All clocked out" : "Live session(s)"}
        />
        <DashboardStat
          label="Auto-closed"
          value={n.number(autoClosedCount)}
          icon={Clock}
          tone="mint"
          // NOT "idle", and not a number. Two paths write `autoClosed`: the nightly
          // sweep, which really does mean nobody was there, and `heartbeatAction`
          // hitting the maximum session length while the tab was demonstrably
          // VISIBLE. Calling both idle told a customer who worked through the night
          // that they had walked away. The hour figure is gone too — it was stated
          // here, in the row title and in the action, and the three had already
          // drifted apart once.
          deltaLabel={autoClosedCount === 0 ? "None" : "Closed automatically"}
        />
      </section>

      <div className="inline-flex w-fit gap-1 rounded-full border border-border bg-bg p-1">
        <button
          type="button"
          onClick={() => setViewMode("list")}
          aria-pressed={viewMode === "list"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            viewMode === "list" ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
          )}
        >
          <List className="h-3.5 w-3.5" aria-hidden="true" /> List
        </button>
        <button
          type="button"
          onClick={() => setViewMode("week")}
          aria-pressed={viewMode === "week"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            viewMode === "week" ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Week
        </button>
      </div>

      {viewMode === "week" ? (
        initialEntries.length === 0 ? (
          <section className="overflow-hidden rounded-2xl border border-border bg-surface">
            <EmptyState
              icon={Clock}
              title="No time entries yet"
              description="Log a session with “Log time”, or clock in from the topbar."
            />
          </section>
        ) : (
          <WeeklyTimesheet
            entries={initialEntries}
            showPerson={initialScope === "team"}
            renderedAt={renderedAt}
            loadedSince={oldestLoadedAt ? new Date(oldestLoadedAt) : null}
          />
        )
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          {initialEntries.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No time entries yet"
              description="Click the clock pill in the topbar to start tracking."
            />
          ) : (
            <div className="scrollbar-thin hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border">
                    {initialScope === "team" && (
                      <th
                        scope="col"
                        className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                      >
                        Person
                      </th>
                    )}
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Started
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Ended
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Duration
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Task
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Note
                    </th>
                    <th scope="col" className="px-6 py-3.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {initialEntries.map((e) => {
                    const startedAt = new Date(e.clockInAt);
                    const endedAt = e.clockOutAt ? new Date(e.clockOutAt) : null;
                    const dur = durationMs(startedAt, endedAt, renderedAt);
                    const isOwn = e.userId === currentUserId;
                    const canDeleteRow = isOwn || canEdit;
                    return (
                      <tr
                        key={e.id}
                        className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                      >
                        {initialScope === "team" && (
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <Avatar name={e.userName} size="xs" />
                              <span className="text-sm text-fg">{e.userName}</span>
                            </div>
                          </td>
                        )}
                        <td className="px-6 py-4 font-mono text-xs text-fg-muted">
                          <LocalTime value={startedAt} pattern="MMM dd · HH:mm" />
                        </td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {endedAt ? (
                            <span
                              className={cn("text-fg-muted", e.autoClosed && "text-warning-strong")}
                              title={
                                e.autoClosed
                                  ? "Closed automatically — either no activity for hours, or the session reached its maximum length"
                                  : undefined
                              }
                            >
                              <LocalTime value={endedAt} pattern="MMM dd · HH:mm" />
                              {e.autoClosed && " ⏱"}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-primary-strong">
                              <span
                                className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
                                aria-hidden="true"
                              />
                              Running
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono text-sm font-bold tabular-nums">
                          {formatDuration(dur)}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {e.taskTitle ? (
                            <span className="text-fg">{e.taskTitle}</span>
                          ) : (
                            <span className="text-fg-muted">—</span>
                          )}
                        </td>
                        <td className="max-w-xs truncate px-6 py-4 text-xs text-fg-muted">
                          {e.note || "—"}
                          {e.editedAt && (
                            <span
                              /* `toLocaleString()` is timezone-dependent, and a
                                 `title` is an attribute React compares during
                                 hydration — so this was the one part of the row
                                 that <LocalTime> could not cover. Gated on mount
                                 for the same reason: the server has no business
                                 guessing the viewer's zone. */
                              title={
                                mounted
                                  ? `Edited by ${e.editedByName ?? "unknown"} on ${new Date(
                                      e.editedAt
                                    ).toLocaleString()}`
                                  : undefined
                              }
                              className="ms-1 inline-flex items-center text-forest-strong"
                            >
                              ✎
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-end">
                          <div className="inline-flex items-center gap-1">
                            {canEdit && (
                              <button
                                onClick={() => setEditing(e)}
                                aria-label={`Edit time entry for ${e.userName}`}
                                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg"
                              >
                                <Pencil className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                            {canDeleteRow && (
                              <button
                                onClick={() => handleDelete(e)}
                                aria-label={`Delete time entry for ${e.userName}`}
                                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Mobile card fallback — the 7-column time table scrolls awkwardly
              on a phone; cards read better. Same data + actions. */}
          {initialEntries.length > 0 && (
            <ul className="divide-y divide-border md:hidden">
              {initialEntries.map((e) => {
                const startedAt = new Date(e.clockInAt);
                const endedAt = e.clockOutAt ? new Date(e.clockOutAt) : null;
                const dur = durationMs(startedAt, endedAt, renderedAt);
                const isOwn = e.userId === currentUserId;
                const canDeleteRow = isOwn || canEdit;
                return (
                  <li key={e.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {e.taskTitle ?? "Untagged work"}
                      </span>
                      <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-fg">
                        {formatDuration(dur)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
                      <span>
                        <LocalTime value={startedAt} pattern="MMM dd · HH:mm" />
                      </span>
                      {endedAt ? (
                        <span className={cn(e.autoClosed && "text-warning-strong")}>
                          → <LocalTime value={endedAt} pattern="HH:mm" />
                          {e.autoClosed && " ⏱"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-primary-strong">
                          <span
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
                            aria-hidden="true"
                          />
                          Running
                        </span>
                      )}
                      {initialScope === "team" && <span>· {e.userName}</span>}
                      {e.editedAt && <span className="text-forest-strong">· edited</span>}
                    </div>
                    {(e.note || canEdit || canDeleteRow) && (
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                          {e.note || ""}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          {canEdit && (
                            <button
                              onClick={() => setEditing(e)}
                              aria-label={`Edit time entry for ${e.userName}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg"
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                          {canDeleteRow && (
                            <button
                              onClick={() => handleDelete(e)}
                              aria-label={`Delete time entry for ${e.userName}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {manualOpen && (
        <ManualEntryModal
          tasks={tasks}
          onClose={() => setManualOpen(false)}
          onSaved={() => {
            setManualOpen(false);
            broadcastChange();
            startTransition(() => router.refresh());
          }}
        />
      )}

      {editing && canEdit && (
        <EditEntryModal
          entry={editing}
          tasks={tasks}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            broadcastChange();
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

/**
 * Callout at the top of /time when the current user has a running entry.
 * Complements the topbar clock widget — audit X12 called out that the
 * running session was only visible up there, not on the page itself.
 */
function RunningEntryBanner({
  entry,
  now,
  note,
}: {
  entry: TimeEntryClient;
  now: Date;
  note: string;
}) {
  const runFor = durationMs(new Date(entry.clockInAt), null, now);
  return (
    <section
      aria-label="Currently running session"
      className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary-strong"
        >
          <Clock className="h-5 w-5" />
        </span>
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-primary-strong">
            Live session · started <LocalTime value={entry.clockInAt} pattern="h:mm a" />
          </p>
          <p className="mt-0.5 text-sm font-semibold text-fg">
            {entry.taskTitle ?? "Untagged work"}
          </p>
          {entry.note && <p className="mt-0.5 text-xs text-fg-muted">{entry.note}</p>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="font-mono text-2xl font-bold tabular-nums text-primary-strong">
          {formatDuration(runFor)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-fg-muted">{note}</span>
      </div>
    </section>
  );
}
