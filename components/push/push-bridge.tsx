"use client";

/**
 * Listens for the "ff-push" message the service worker posts when a push
 * arrives while the app is open, and (1) plays the in-app chime, (2) nudges the
 * notification pollers to refresh the unread badge immediately. Renders nothing.
 */

import { useEffect } from "react";
import { playNotificationTone } from "@/lib/push/tone";

export function PushBridge() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data && event.data.type === "ff-push") {
        playNotificationTone();
        window.dispatchEvent(new CustomEvent("ff-notifications-changed"));
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);
  return null;
}
