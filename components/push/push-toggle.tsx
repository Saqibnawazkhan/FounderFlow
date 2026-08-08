"use client";

/**
 * Settings control to enable/disable Web Push on this device. Renders a plain
 * status line when push is unsupported or not configured on the deployment.
 */

import { usePushNotifications } from "@/lib/hooks/usePushNotifications";
import { cn } from "@/lib/utils";

export function PushToggle() {
  const { state, enable, disable } = usePushNotifications();

  if (state === "unsupported") {
    return (
      <p className="text-sm text-fg-muted">This browser doesn&apos;t support push notifications.</p>
    );
  }
  if (state === "unconfigured") {
    return (
      <p className="text-sm text-fg-muted">
        Push notifications aren&apos;t set up on this deployment yet.
      </p>
    );
  }

  const enabled = state === "enabled";
  const busy = state === "busy";
  const denied = state === "denied";

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-fg-muted">
        {denied
          ? "Blocked in your browser — allow notifications for this site in your browser settings, then reload."
          : enabled
            ? "On — you'll get a desktop notification and a chime for new activity, even when FounderFlow is closed."
            : "Get a desktop notification and a chime for new activity on this device — even when FounderFlow is closed."}
      </p>
      <button
        type="button"
        disabled={busy || denied}
        onClick={enabled ? disable : enable}
        className={cn(
          "shrink-0 rounded-full px-4 py-2 text-sm font-bold transition-transform active:scale-95 disabled:opacity-50",
          enabled
            ? "border border-border text-fg-muted hover:bg-surface-hover hover:text-fg"
            : "bg-primary text-primary-fg hover:scale-[1.02]"
        )}
      >
        {busy ? "…" : enabled ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}
