"use client";

/**
 * The notification-preferences matrix — events down, delivery channels across.
 *
 * Toggles are optimistic and roll back on failure: a checkbox that waits on a
 * round-trip before moving feels broken, and a checkbox that moves and then
 * silently didn't save is worse. One cell at a time, so a failure can only
 * ever revert the switch the person actually touched.
 *
 * The matrix always arrives complete — `matrixFor` fills unstored events from
 * DEFAULT_CHANNELS server-side — so this never has to reason about "unset".
 */

import { useState } from "react";
import toast from "react-hot-toast";
import { Bell, Mail, Smartphone } from "lucide-react";
import { updateNotificationPreferenceAction } from "@/lib/actions/notification-preferences";
import { EVENT_COPY, NOTIFY_CHANNELS, type NotifyChannel } from "@/lib/notify/events";
import type { NotificationMatrixRow } from "@/lib/queries/notification-preferences";
import { cn } from "@/lib/utils";

const CHANNEL_COPY: Record<NotifyChannel, { label: string; icon: typeof Bell }> = {
  inApp: { label: "In app", icon: Bell },
  email: { label: "Email", icon: Mail },
  push: { label: "Push", icon: Smartphone },
};

export function NotificationMatrix({ initial }: { initial: NotificationMatrixRow[] }) {
  const [rows, setRows] = useState(initial);
  // Keyed "event:channel" so two cells can be in flight without blocking
  // each other — people flick several switches in a row.
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function toggle(event: string, channel: NotifyChannel, next: boolean) {
    const key = `${event}:${channel}`;
    setPending((p) => new Set(p).add(key));
    setRows((prev) =>
      prev.map((r) =>
        r.event === event ? { ...r, channels: { ...r.channels, [channel]: next } } : r
      )
    );

    const res = await updateNotificationPreferenceAction({ event, channel, enabled: next });

    if (!res.success) {
      // Put it back exactly where it was, and say why.
      setRows((prev) =>
        prev.map((r) =>
          r.event === event ? { ...r, channels: { ...r.channels, [channel]: !next } } : r
        )
      );
      toast.error(res.error);
    }
    setPending((p) => {
      const copy = new Set(p);
      copy.delete(key);
      return copy;
    });
  }

  return (
    <div>
      <p className="mb-5 text-sm text-fg-muted">
        Choose how each kind of update reaches you. In-app notifications are always kept as a record
        on the notifications page; email and push are the interruptions.
      </p>

      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[34rem]">
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="py-2.5 pr-4 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
              >
                Notify me about
              </th>
              {NOTIFY_CHANNELS.map((channel) => {
                const Icon = CHANNEL_COPY[channel].icon;
                return (
                  <th
                    key={channel}
                    scope="col"
                    className="w-24 py-2.5 text-center font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {CHANNEL_COPY[channel].label}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.event} className="border-b border-border last:border-b-0">
                <th scope="row" className="py-3.5 pr-4 text-left font-normal">
                  <span className="block text-sm font-semibold text-fg">
                    {EVENT_COPY[row.event].label}
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    {EVENT_COPY[row.event].description}
                  </span>
                </th>
                {NOTIFY_CHANNELS.map((channel) => {
                  const checked = row.channels[channel];
                  const key = `${row.event}:${channel}`;
                  return (
                    <td key={channel} className="py-3.5 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={pending.has(key)}
                        onChange={(e) => toggle(row.event, channel, e.target.checked)}
                        aria-label={`${CHANNEL_COPY[channel].label} for ${EVENT_COPY[row.event].label}`}
                        className={cn(
                          "h-4 w-4 cursor-pointer accent-primary",
                          pending.has(key) && "opacity-50"
                        )}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
