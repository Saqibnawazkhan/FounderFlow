import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/env";

export default function sitemap(): MetadataRoute.Sitemap {
  // `appOrigin()`, not `env.NEXT_PUBLIC_APP_URL`: every entry below is built by
  // concatenation, so a Production origin saved with a trailing slash emitted
  // `https://app.founderflow.com//`, `…//login` and `…//signup`. Those are
  // distinct URLs to a crawler and not the ones the canonical tags claim, which
  // is the quiet version of an unindexable site — the file is valid XML, the
  // build is green, and the pages simply never rank.
  const base = appOrigin();
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
