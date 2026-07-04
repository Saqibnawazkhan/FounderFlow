"use client";

/**
 * Seeds the client store's theme + locale from the signed-in user's DB
 * preferences once per session (S6). localStorage gives the instant first
 * paint; this reconciles it with the durable server value so a user who
 * changed their theme on another device sees it here too. Runs once per
 * user id, then stays out of the way. Renders nothing.
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
    getMyAppearanceAction().then((res) => {
      if (cancelled || !res.success) return;
      setTheme(res.data.theme);
      setLocale(res.data.locale);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, setTheme, setLocale]);

  return null;
}
