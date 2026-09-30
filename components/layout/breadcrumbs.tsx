"use client";

/**
 * Path-driven breadcrumbs (N2). Derives the trail from the current pathname
 * so it works on every app route without per-page wiring. Known segments map
 * to their localized nav label (the segment→label map lives in
 * lib/layout/breadcrumb-labels.ts so a test can iterate it against
 * NAV_ITEMS); a dynamic id under /projects renders a
 * generic "Project" crumb (the page's own H1 carries the actual name). The
 * leading Home link routes to the role's home so members don't land on a
 * finance page they can't see.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Home } from "lucide-react";
import { useStore } from "@/lib/store";
import { homeRouteForRole, type Role } from "@/lib/auth/role-gates";
import { useT } from "@/lib/i18n/use-t";
import { breadcrumbLabels } from "@/lib/layout/breadcrumb-labels";
import { isDmSlug } from "@/lib/chat/dm";

export function Breadcrumbs() {
  const pathname = usePathname();
  const t = useT();
  const role = (useStore((s) => s.currentUser?.role) as Role | undefined) ?? "member";
  const home = homeRouteForRole(role);

  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const navLabels = breadcrumbLabels(t);

  const shown = segments
    .map((seg, i) => {
      const href = "/" + segments.slice(0, i + 1).join("/");
      let label = navLabels[seg];
      if (!label) {
        // Unmapped segment: a project id gets a generic label; anything else is
        // humanized so we never render a raw slug.
        label =
          i > 0 && segments[i - 1] === "projects"
            ? t.breadcrumb.project
            : seg.charAt(0).toUpperCase() + seg.slice(1);
      }
      // …except a DM, where "humanized" is the bug. A DM's slug is two user ids
      // (`dm-<idA>_<idB>`), so the line above produced
      // "Dm-demo-ali_dmsmoke-ghost-816234" in the trail — the chat-008 class in
      // one more surface. The crumb is DROPPED rather than relabelled: the
      // honest label is the counterpart's name, and only the server knows who
      // that is relative to the viewer, so naming it here would create a second
      // source of truth for a DM's name — the disagreement lib/chat/dm.ts exists
      // to end. The channel header names the conversation one line below.
      const isDmLeaf = i > 0 && segments[i - 1] === "chat" && isDmSlug(seg);
      return { href, label, isDmLeaf };
    })
    .filter((c) => !c.isDmLeaf);

  // `isLast` is computed AFTER the drop, or the trail would render a chevron
  // and then nothing, with no crumb carrying aria-current.
  const crumbs = shown.map((c, i) => ({ ...c, isLast: i === shown.length - 1 }));

  return (
    <nav aria-label="Breadcrumb" className="px-4 pt-4 md:px-6 lg:px-8">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        <li>
          <Link
            href={home}
            className="inline-flex items-center gap-1 rounded transition-colors hover:text-fg"
          >
            <Home className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{t.breadcrumb.home}</span>
          </Link>
        </li>
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1.5">
            {/* The separator points along the trail, so it is a
                direction-of-travel glyph and has to mirror — an unrotated
                ChevronRight in Urdu points back the way you came. The Home
                icon above is a destination, not a direction, and stays put. */}
            <ChevronRight
              className="h-3 w-3 shrink-0 text-fg-muted/50 rtl:rotate-180"
              aria-hidden="true"
            />
            {c.isLast ? (
              <span aria-current="page" className="font-semibold text-fg">
                {c.label}
              </span>
            ) : (
              <Link href={c.href} className="rounded transition-colors hover:text-fg">
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
