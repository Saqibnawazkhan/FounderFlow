"use client";

/**
 * Admin/cofounder-only modal to retro-edit a time entry's clock-in/out
 * times, task assignment, and note. The server action re-verifies the
 * role on every submit, so this UI is "do the right thing" not security.
 *
 * Date input handling: <input type="datetime-local"> wants the local-time
 * `YYYY-MM-DDTHH:mm` string with no timezone. We serialize ISO → local on
 * mount and re-serialize back via zod's z.coerce.date() at save time.
 */

import { useId, useState } from "react";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { updateTimeEntryAction } from "@/lib/actions/time";
import type { TimeEntryClient } from "@/lib/queries/time";
import type { User } from "@/lib/types";

type Props = {
  entry: TimeEntryClient;
  tasks: { id: string; title: string }[];
  users: User[];
  onClose: () => void;
  onSaved: () => void;
};

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  // Build YYYY-MM-DDTHH:mm in *local* time. The native input renders these
  // exactly so we don't get an off-by-one timezone jump on round-trip.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EditEntryModal({ entry, tasks, users, onClose, onSaved }: Props) {
  const inId = useId();
  const outId = useId();
  const taskId = useId();
  const noteId = useId();

  const [clockInAt, setClockInAt] = useState(toLocalInput(entry.clockInAt));
  const [clockOutAt, setClockOutAt] = useState(toLocalInput(entry.clockOutAt));
  const [taskValue, setTaskValue] = useState(entry.taskId ?? "");
  const [note, setNote] = useState(entry.note ?? "");
  const [busy, setBusy] = useState(false);

  const owner = users.find((u) => u.id === entry.userId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clockInAt) {
      toast.error("Clock-in time is required");
      return;
    }
    setBusy(true);
    const res = await updateTimeEntryAction({
      entryId: entry.id,
      clockInAt: new Date(clockInAt),
      clockOutAt: clockOutAt ? new Date(clockOutAt) : null,
      taskId: taskValue === "" ? null : taskValue,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Entry updated");
    onSaved();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit time entry"
      description={
        owner
          ? `Adjusting ${owner.name}'s session. Audit-logged as your edit.`
          : "Audit-logged as your edit."
      }
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor={inId}
              className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              Clock in
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
              Clock out{" "}
              <span className="font-sans normal-case tracking-normal text-fg-muted/60">
                (leave blank if still running)
              </span>
            </label>
            <input
              id={outId}
              type="datetime-local"
              value={clockOutAt}
              onChange={(e) => setClockOutAt(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={taskId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Task
          </label>
          <select
            id={taskId}
            value={taskValue}
            onChange={(e) => setTaskValue(e.target.value)}
            className="w-full appearance-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
          >
            <option value="">Untagged</option>
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
            Note
          </label>
          <input
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:outline-none"
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
            <Save className="h-4 w-4" aria-hidden="true" />
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
