import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/dashboard",
          "/expenses",
          "/investments",
          "/tasks",
          "/activities",
          "/team",
          "/reports",
          "/notifications",
          "/settings",
          "/api/",
        ],
      },
    ],
    // `appOrigin()`, not `env.NEXT_PUBLIC_APP_URL`. This line already read the
    // validated value rather than a literal, so it was never part of the
    // duplicated-fallback problem — but it is still a concatenation, and a
    // Production value saved as `https://app.founderflow.com/` (what you get by
    // copying the origin out of an address bar) made this
    // `https://app.founderflow.com//sitemap.xml`. That is not a route Next
    // serves, so Googlebot is pointed at a dead sitemap, the marketing pages are
    // never discovered, and nothing in the app errors or logs.
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
