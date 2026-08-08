"use client";

/**
 * Client hook for the Web Push opt-in lifecycle: detect support, read the
 * current permission/subscription, and enable/disable. The heavy lifting
 * (VAPID send) is server-side; this just manages the browser PushSubscription
 * and persists it via the push actions.
 */

import { useCallback, useEffect, useState } from "react";
import { savePushSubscriptionAction, deletePushSubscriptionAction } from "@/lib/actions/push";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** VAPID public key (URL-safe base64) → ArrayBuffer for applicationServerKey. */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

export type PushState =
  | "unsupported" // browser lacks SW/Push/Notification
  | "unconfigured" // no VAPID public key on this deployment
  | "denied" // user blocked notifications
  | "disabled" // supported + allowed, not subscribed
  | "enabled" // subscribed on this device
  | "busy"; // a subscribe/unsubscribe is in flight

export function usePushNotifications() {
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const [state, setState] = useState<PushState>("disabled");

  useEffect(() => {
    if (!supported) return setState("unsupported");
    if (!VAPID_PUBLIC_KEY) return setState("unconfigured");
    if (Notification.permission === "denied") return setState("denied");
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setState(sub ? "enabled" : "disabled");
      })
      .catch(() => {
        if (!cancelled) setState("disabled");
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const enable = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) return;
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "disabled");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC_KEY),
      });
      const res = await savePushSubscriptionAction(sub.toJSON());
      setState(res.success ? "enabled" : "disabled");
    } catch {
      setState("disabled");
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deletePushSubscriptionAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("disabled");
    } catch {
      setState("disabled");
    }
  }, [supported]);

  return { state, enable, disable, supported };
}
