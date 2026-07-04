"use client";

/**
 * <ClockWidget> — the topbar pill that drives the user's time entry.
 *
 * Three render states:
 *   idle       → "Clock in" button, opens the start modal
 *   running    → "● 1h 23m" lime pill, opens the stop modal
 *   warn       → "Still working?" modal floats above the page; the user
 *                must answer within 30 min or the client auto-clocks out
 *                at lastActivityAt (lib/time/thresholds.ts:AUTO_CLOSE_MS).
 *
 * Why three pieces of state instead of one finite-state machine: the widget
 * is mostly idle, the modal pieces are mounted conditionally, and routing
 * everything through a discriminated union adds noise without saving bugs.
 *
 * Heartbeat: every HEARTBEAT_MS while an entry is open, we call
 * heartbeatAction so lastActivityAt stays current. The Page Visibility API
 * pauses heartbeats while the tab is hidden — there's no point claiming
 * activity when the user is in another tab — and the cron is the safety
 * net for "user closed the browser entirely" cases.
 */

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, LogIn, LogOut, PlayCircle } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import {
  autoCloseEntryAction,
  clockInAction,
  clockOutAction,
  getOpenEntryAction,
  heartbeatAction,
} from "@/lib/actions/time";
import {
  AUTO_CLOSE_MS,
  HEARTBEAT_MS,
  RESPONSE_WINDOW_MS,
  WARN_AFTER_MS,
  durationMs,
  entryState,
  formatDuration,
} from "@/lib/time/thresholds";
import type { TimeEntryClient } from "@/lib/queries/time";

/**
 * The widget self-loads — the topbar is a client component, so passing
 * RSC-fetched data down would mean restructuring the whole layout into
 * an async server component. Instead the widget calls getOpenEntryAction
 * on mount and after every clock-in/out to keep things self-contained.
 */
export function ClockWidget() {
  const router = useRouter();
  // startTransition keeps the running UI responsive while the RSC tree
  // re-fetches after a clock-in/out — otherwise the pill renders the
  // pre-mutation state for ~200-400ms and users double-click.
  const [, startTransition] = useTransition();
  const [entry, setEntry] = useState<TimeEntryClient | null>(null);
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
  const [now, setNow] = useState<Date>(() => new Date());

  // Initial load + after every mutation. router.refresh() doesn't re-run
  // this because the widget is a client component; we explicitly refetch.
  const reload = useCallback(async () => {
    const res = await getOpenEntryAction();
    if (res.success) {
      setEntry(res.data.openEntry);
      setTasks(res.data.tasks);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Cross-tab sync (X3): a single BroadcastChannel shared by every open tab.
  // When one tab clocks in/out/auto-closes it posts "time-changed"; the others
  // re-fetch their open-entry state so the pill agrees everywhere. reload()
  // itself never posts, so there's no echo loop.
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return; // graceful no-op
    const ch = new BroadcastChannel("ff-time");
    ch.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === "time-changed") void reload();
    };
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      ch.close();
    };
  }, [reload]);

  const broadcastChange = useCallback(() => {
    channelRef.current?.postMessage({ type: "time-changed" });
  }, []);

  // Two modals. They're mutually exclusive in practice — you can't clock-in
  // while one is open, and the warn modal only shows for a running entry.
  const [startOpen, setStartOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);

  // Local 1s ticker for the running pill. Throttled to once a minute when
  // the tab is hidden — no point repainting "1h 24m" if no one's looking.
  useEffect(() => {
    if (!entry) return;
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(
      tick,
      typeof document !== "undefined" && document.hidden ? 60_000 : 1_000
    );
    return () => window.clearInterval(id);
  }, [entry]);

  // Heartbeat loop — only while visible. The visibilitychange handler also
  // forces an immediate heartbeat when the tab comes back into focus, so
  // lastActivityAt reflects "actually here" not the last poll cycle.
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;

    async function beat() {
      if (cancelled || !entry) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const res = await heartbeatAction({ entryId: entry.id });
      if (!cancelled && res.success) {
        setEntry((prev) => (prev ? { ...prev, lastActivityAt: new Date().toISOString() } : prev));
      }
    }
    const onVis = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        // Two things happen on tab re-focus:
        //   1. Send a heartbeat so lastActivityAt catches up
        //   2. Force a now() update so the running pill repaints with the
        //      real elapsed time. Without #2 the ticker's `now` is up to
        //      60s stale (we throttle to 60s tick while the tab's hidden),
        //      so the pill displays a stale duration for a second or two
        //      after re-focus until the next tick rolls.
        beat();
        setNow(new Date());
      }
    };

    const id = window.setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [entry]);

  // Watch the warn / auto-close threshold. The user's keystrokes don't
  // shift lastActivityAt directly — only a successful heartbeat does — so
  // this fires on the first tick where idle >= 12h. If the user answers
  // "yes, keep going" we send a heartbeat that resets the clock.
  useEffect(() => {
    if (!entry) return;
    const state = entryState(new Date(entry.lastActivityAt), now);
    if (state === "warn" && !warnOpen && !stopOpen) {
      setWarnOpen(true);
    } else if (state === "auto-close") {
      // Client-side fallback to the server cron. If the cron beats us to
      // it, the action is idempotent for already-closed entries.
      void autoCloseEntryAction({ entryId: entry.id }).then((res) => {
        if (res.success) {
          setWarnOpen(false);
          setEntry(null);
          toast(`Auto-clocked out — no activity for ${Math.round(AUTO_CLOSE_MS / 3_600_000)}h.`, {
            icon: "⏱️",
          });
          startTransition(() => router.refresh());
          broadcastChange();
        }
      });
    }
  }, [entry, now, warnOpen, stopOpen, router, broadcastChange]);

  async function handleClockIn(taskId: string | undefined, note: string) {
    const res = await clockInAction({
      taskId: taskId || undefined,
      note: note.trim() || undefined,
    });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Clocked in");
    setStartOpen(false);
    // Re-fetch via the parent — the layout will re-render and pass us
    // back the fresh openEntry prop. We also seed locally so the pill
    // updates without waiting for the round-trip.
    setEntry({
      id: res.data.entryId,
      companyId: "",
      userId: "",
      userName: "",
      taskId: taskId ?? null,
      taskTitle: tasks.find((t) => t.id === taskId)?.title ?? null,
      note: note.trim() || null,
      clockInAt: new Date().toISOString(),
      clockOutAt: null,
      lastActivityAt: new Date().toISOString(),
      autoClosed: false,
      editedBy: null,
      editedByName: null,
      editedAt: null,
      createdAt: new Date().toISOString(),
    });
    startTransition(() => router.refresh());
    void reload();
    broadcastChange();
  }

  async function handleClockOut(note: string) {
    if (!entry) return;
    const res = await clockOutAction({
      entryId: entry.id,
      note: note.trim() || undefined,
    });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Clocked out");
    setStopOpen(false);
    setWarnOpen(false);
    setEntry(null);
    startTransition(() => router.refresh());
    void reload();
    broadcastChange();
  }

  async function keepWorking() {
    if (!entry) return;
    const res = await heartbeatAction({ entryId: entry.id });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    setEntry((prev) => (prev ? { ...prev, lastActivityAt: new Date().toISOString() } : prev));
    setWarnOpen(false);
  }

  const isRunning = Boolean(entry);
  const runningMs = entry ? durationMs(new Date(entry.clockInAt), null, now) : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => (isRunning ? setStopOpen(true) : setStartOpen(true))}
        aria-label={isRunning ? `Clocked in, ${formatDuration(runningMs)}` : "Clock in"}
        title={isRunning ? (entry?.taskTitle ?? "Tracking time") : "Start tracking time"}
        className={
          isRunning
            ? "inline-flex h-9 items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 font-mono text-xs font-bold tabular-nums text-primary-strong transition hover:bg-primary/15"
            : "inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-bg px-3 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
        }
      >
        {isRunning ? (
          <>
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              aria-hidden="true"
            />
            {formatDuration(runningMs)}
          </>
        ) : (
          <>
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Clock in</span>
          </>
        )}
      </button>

      <StartModal
        open={startOpen}
        onClose={() => setStartOpen(false)}
        tasks={tasks}
        onSubmit={handleClockIn}
      />
      <StopModal
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        entry={entry}
        runningMs={runningMs}
        onSubmit={handleClockOut}
      />
      <WarnModal
        open={warnOpen}
        onClose={() => setWarnOpen(false)}
        runningMs={runningMs}
        onKeepWorking={keepWorking}
        onClockOut={() => {
          setWarnOpen(false);
          setStopOpen(true);
        }}
      />
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Modals                                                                 */
/* ─────────────────────────────────────────────────────────────────────── */

function StartModal({
  open,
  onClose,
  tasks,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  tasks: { id: string; title: string }[];
  onSubmit: (taskId: string | undefined, note: string) => Promise<void>;
}) {
  const taskId = useId();
  const noteId = useId();
  const [selectedTask, setSelectedTask] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset when re-opened so the next clock-in doesn't carry old state.
  useEffect(() => {
    if (open) {
      setSelectedTask("");
      setNote("");
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start tracking"
      description="Optional: tag this session with a task and a note."
      size="md"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onSubmit(selectedTask || undefined, note);
          setBusy(false);
        }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor={taskId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Task (optional)
          </label>
          <select
            id={taskId}
            value={selectedTask}
            onChange={(e) => setSelectedTask(e.target.value)}
            className="w-full appearance-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
          >
            <option value="">Untagged work</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id} className="bg-bg">
                {t.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor={noteId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Note (optional)
          </label>
          <input
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="What are you working on?"
            className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <PlayCircle className="h-4 w-4" aria-hidden="true" />
            {busy ? "Starting…" : "Clock in"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StopModal({
  open,
  onClose,
  entry,
  runningMs,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  entry: TimeEntryClient | null;
  runningMs: number;
  onSubmit: (note: string) => Promise<void>;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setNote(entry?.note ?? "");
  }, [open, entry?.note]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Clock out?"
      description={
        entry?.taskTitle
          ? `You're tracking "${entry.taskTitle}" — ${formatDuration(runningMs)} so far.`
          : `${formatDuration(runningMs)} tracked so far.`
      }
      size="md"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onSubmit(note);
          setBusy(false);
        }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor={noteId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Final note (optional)
          </label>
          <input
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Wrap-up note for this session"
            className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            Keep going
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-danger px-4 py-2 text-sm font-bold text-white transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {busy ? "Stopping…" : "Clock out"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WarnModal({
  open,
  onClose,
  runningMs,
  onKeepWorking,
  onClockOut,
}: {
  open: boolean;
  onClose: () => void;
  runningMs: number;
  onKeepWorking: () => Promise<void>;
  onClockOut: () => void;
}) {
  // Visible countdown to auto-close — purely informational, the real
  // trigger is the auto-close effect in <ClockWidget> watching `now`.
  const [remainingMs, setRemainingMs] = useState(RESPONSE_WINDOW_MS);
  useEffect(() => {
    if (!open) return;
    const tick = () => setRemainingMs((prev) => Math.max(0, prev - 1000));
    setRemainingMs(RESPONSE_WINDOW_MS);
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <Modal
          open={open}
          onClose={onClose}
          title="Still working?"
          description={`You've been clocked in for ${formatDuration(runningMs)} with no activity for ${Math.round(WARN_AFTER_MS / 3_600_000)}h. Confirm to keep the timer running, or clock out.`}
          size="md"
        >
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
              Auto clock-out in{" "}
              <span className="font-mono font-bold tabular-nums">
                {formatDuration(remainingMs)}
              </span>
              . If you walked away, we'll record the session up to your last activity.
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onClockOut}
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Clock out now
              </button>
              <button
                type="button"
                onClick={onKeepWorking}
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Yes, keep going
              </button>
            </div>
          </motion.div>
        </Modal>
      )}
    </AnimatePresence>
  );
}
