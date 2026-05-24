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

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Clock, Pencil, Trash2, Users } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deleteTimeEntryAction } from "@/lib/actions/time";
import { canEditEntryTimes, durationMs, formatDuration, sumDurations } from "@/lib/time/thresholds";
import { cn } from "@/lib/utils";
import type { TimeEntryClient } from "@/lib/queries/time";
import type { User } from "@/lib/types";
import { EditEntryModal } from "./edit-entry-modal";

type Props = {
  initialEntries: TimeEntryClient[];
  users: User[];
  tasks: { id: string; title: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  canSeeTeam: boolean;
  initialScope: "mine" | "team";
};

export function TimeClient({
  initialEntries,
  users,
  tasks,
  currentUserId,
  currentUserRole,
  canSeeTeam,
  initialScope,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const canEdit = canEditEntryTimes(currentUserRole);

  const [editing, setEditing] = useState<TimeEntryClient | null>(null);

  // Switching scope is a URL change so the RSC re-fetches.
  function switchScope(scope: "mine" | "team") {
    if (scope === initialScope) return;
    const url = scope === "team" ? "/time?scope=team" : "/time";
    startTransition(() => router.push(url));
  }

  // "Now" frozen at render time for in-table duration display. Running
  // entries also have the topbar widget's live ticker; this is the historical
  // view, so a slightly stale render is fine — the user expects a snapshot.
  const renderedAt = useMemo(() => new Date(), []);

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

  const openCount = initialEntries.filter((e) => !e.clockOutAt).length;
  const autoClosedCount = initialEntries.filter((e) => e.autoClosed).length;

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
    startTransition(() => router.refresh());
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="cyan">
            <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" /> Time tracking
          </PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Time</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            {initialScope === "team"
              ? "Every founder + team member's logged hours."
              : "Your clocked sessions and the time they consumed."}
          </p>
        </div>
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
      </header>

      <section aria-label="Time summary" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total tracked"
          value={formatDuration(totalMs)}
          icon={Clock}
          tone="cyan"
          deltaLabel={`${initialEntries.length} session${initialEntries.length === 1 ? "" : "s"}`}
        />
        <DashboardStat
          label="Currently running"
          value={openCount.toString()}
          icon={Clock}
          tone="primary"
          deltaLabel={openCount === 0 ? "All clocked out" : "Live session(s)"}
        />
        <DashboardStat
          label="Auto-closed"
          value={autoClosedCount.toString()}
          icon={Clock}
          tone="pink"
          deltaLabel={autoClosedCount === 0 ? "No idle timeouts" : "Closed after 12.5h idle"}
        />
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        {initialEntries.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No time entries yet"
            description="Click the clock pill in the topbar to start tracking."
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  {initialScope === "team" && (
                    <th
                      scope="col"
                      className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                    >
                      Person
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Started
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Ended
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Duration
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Task
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
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
                        {format(startedAt, "MMM dd · HH:mm")}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs">
                        {endedAt ? (
                          <span
                            className={cn("text-fg-muted", e.autoClosed && "text-warning")}
                            title={e.autoClosed ? "Auto-closed after 12.5h idle" : undefined}
                          >
                            {format(endedAt, "MMM dd · HH:mm")}
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
                            title={`Edited by ${e.editedByName ?? "unknown"} on ${new Date(
                              e.editedAt
                            ).toLocaleString()}`}
                            className="ml-1 inline-flex items-center text-cyan-strong"
                          >
                            ✎
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
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
      </section>

      {editing && canEdit && (
        <EditEntryModal
          entry={editing}
          tasks={tasks}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
