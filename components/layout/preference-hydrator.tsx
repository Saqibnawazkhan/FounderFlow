"use client";

/**
 * Seeds the client store's theme + locale from the signed-in user's DB
 * preferences once per session (S6). localStorage gives the instant first
 * paint; this reconciles it with the durable server value so a user who
 * changed their theme on another device sees it here too. Runs once per
 * user id, then stays out of the way. Renders nothing.
 *
 * WHY THE TWO `setX` CALLS ARE GUARDED (i18n-002). They used to be
 * unconditional, which made this component silently undo the user's own click:
 * the round-trip is issued on mount, the language toggle in the topbar is one
 * click away, and `setLocale(res.data.locale)` landing afterwards wrote the
 * STALE server value back. The user clicked اردو, the UI switched, and then it
 * switched back on its own — with no error, no toast, and no way to tell whether
 * the DB write they triggered had won. Losing a preference is minor; a control
 * that reverts itself and says nothing reads as the app being broken.
 *
 * The guard is the one `components/layout/command-palette.tsx` already uses for
 * out-of-order search responses: capture the value before the await, compare it
 * to the live store value after, and drop the response if it moved. It is read
 * from `useStore.getState()` rather than from a subscription on purpose — this
 * component must not re-render (and re-run its effect) when the locale changes.
 *
 * The two preferences are guarded INDEPENDENTLY: clicking اردو mid-flight must
 * not also cost the user the theme they set on another device.
 *
 * Note what this deliberately does not do: retry. `seededForRef` is set before
 * the await, so a failed fetch is not re-attempted for that user id. That is
 * unchanged, and it is the correct trade while localStorage already holds a
 * usable value.
 */

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { getMyAppearanceAction } from "@/lib/actions/appearance";

export function PreferenceHydrator() {
  const setTheme = useStore((s) => s.setTheme);
  const setLocale = useStore((s) => s.setLocale);
  const currentUserId = useStore((s) => s.currentUser?.id);
  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentUserId) return;
    if (seededForRef.current === currentUserId) return;
    seededForRef.current = currentUserId;
    let cancelled = false;

    const atRequest = useStore.getState();
    const themeAtRequest = atRequest.theme;
    const localeAtRequest = atRequest.locale;

    getMyAppearanceAction().then((res) => {
      if (cancelled || !res.success) return;
      const now = useStore.getState();
      if (now.theme === themeAtRequest) setTheme(res.data.theme);
      if (now.locale === localeAtRequest) setLocale(res.data.locale);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, setTheme, setLocale]);

  return null;
}
