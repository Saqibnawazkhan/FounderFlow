"use client";

/**
 * Manual/backdated time entry (X1). Lets any user log a *completed* session
 * they forgot to track live — both clock-in and clock-out are required. The
 * entry is always for the current user; the server action (createManualEntry)
 * ignores any userId, so there's no cross-user logging here.
 *
 * Date handling mirrors the edit modal: <input type="datetime-local"> speaks
 * local `YYYY-MM-DDTHH:mm`, and z.coerce.date() re-parses at save time.
 */

import { useId, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createManualEntryAction } from "@/lib/actions/time";
import { durationMs, formatDuration } from "@/lib/time/thresholds";

type Props = {
  tasks: { id: string; title: string }[];
  onClose: () => void;
  onSaved: () => void;
};

function toLocalInput(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function ManualEntryModal({ tasks, onClose, onSaved }: Props) {
  const inId = useId();
  const outId = useId();
  const taskFieldId = useId();
  const noteId = useId();

  // Seed with a sensible recent window: an hour ago → now.
  const [defaults] = useState(() => {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    return { in: toLocalInput(hourAgo), out: toLocalInput(now) };
  });

  const [clockInAt, setClockInAt] = useState(defaults.in);
  const [clockOutAt, setClockOutAt] = useState(defaults.out);
  const [taskValue, setTaskValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Live duration preview so the user can sanity-check the window before save.
  const preview = useMemo(() => {
    if (!clockInAt || !clockOutAt) return null;
    const start = new Date(clockInAt);
    const end = new Date(clockOutAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end.getTime() <= start.getTime()) return null;
    return formatDuration(durationMs(start, end, end));
  }, [clockInAt, clockOutAt]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clockInAt || !clockOutAt) {
      toast.error("Both start and end times are required");
      return;
    }
    setBusy(true);
    const res = await createManualEntryAction({
      clockInAt: new Date(clockInAt),
      clockOutAt: new Date(clockOutAt),
      taskId: taskValue === "" ? null : taskValue,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Time logged");
    onSaved();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Log time manually"
      description="Record a completed session you forgot to track live. Both start and end are required."
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor={inId}
              className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              Started
            </label>
            <input
              id={inId}
              type="datetime-local"
              required
              value={clockInAt}
              onChange={(e) => setClockInAt(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor={outId}
              className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              Ended
            </label>
            <input
              id={outId}
              type="datetime-local"
              required
              value={clockOutAt}
              onChange={(e) => setClockOutAt(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between rounded-xl border border-border bg-bg px-4 py-2.5 text-sm"
          aria-live="polite"
        >
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
            Duration
          </span>
          <span className="font-mono font-bold tabular-nums text-fg">
            {preview ?? <span className="text-danger">End must be after start</span>}
          </span>
        </div>

        <div>
          <label
            htmlFor={taskFieldId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Task
          </label>
          <select
            id={taskFieldId}
            value={taskValue}
            onChange={(e) => setTaskValue(e.target.value)}
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
            placeholder="What did you work on?"
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
            disabled={busy || !preview}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {busy ? "Logging…" : "Log time"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
