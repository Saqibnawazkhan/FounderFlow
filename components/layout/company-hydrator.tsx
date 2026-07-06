"use client";

/**
 * Seeds the client store's `currentCompany` (name + industry) from the DB once
 * per session, so the sidebar header shows the real workspace name instead of
 * the "Your Company" fallback. Mirrors PreferenceHydrator: runs once per user
 * id, reconciles the demo-seeded store with the durable server value, then
 * stays out of the way. Renders nothing.
 *
 * Why it's needed: the store's `companies` array only ever holds demo-seed
 * data, so an authenticated user's real companyId never matched it — the
 * sidebar fell back to "Your Company". getCurrentCompany() has existed for
 * exactly this purpose; this wires it up.
 */

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { getMyCompanyAction } from "@/lib/actions/company";

export function CompanyHydrator() {
  const hydrateCompany = useStore((s) => s.hydrateCompany);
  const currentUserId = useStore((s) => s.currentUser?.id);
  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentUserId) return;
    if (seededForRef.current === currentUserId) return;
    seededForRef.current = currentUserId;
    let cancelled = false;
    getMyCompanyAction().then((res) => {
      if (cancelled || !res.success) return;
      hydrateCompany(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, hydrateCompany]);

  return null;
}
