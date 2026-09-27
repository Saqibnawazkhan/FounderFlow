/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === "production";

// CSP — kept relatively permissive for dev (Next.js dev needs 'unsafe-eval').
// Tighten further once Phase 1 (real backend) lands.
const cspHeader = [
  "default-src 'self'",
  `script-src 'self' ${isProd ? "" : "'unsafe-eval'"} 'unsafe-inline'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://ui-avatars.com https://images.unsplash.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // 'self' covers RSC/Server-Action fetches + the same-origin Sentry tunnel
  // (/monitoring). The explicit sentry.io ingest hosts are a fallback so
  // browser-side error reporting still works when the tunnel isn't active
  // (partial Sentry config) instead of being silently blocked by CSP.
  "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
]
  .join("; ")
  .replace(/\s{2,}/g, " ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspHeader },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Required in Next.js 14 for instrumentation.ts to load. Becomes the
  // default (and removed from the config) when we upgrade to Next 15+.
  experimental: {
    instrumentationHook: true,
  },
  // WHY THE OPTIMIZER IS OFF (2026-09-26, security):
  //
  // `/_next/image` is a live, UNAUTHENTICATED endpoint — middleware.ts's
  // matcher excludes `_next/image` by design, so it never reaches the auth
  // gate. Next 14.2.35 still carries a CRITICAL advisory there
  // ("Unauthenticated RCE in the Image Optimization API when AVIF files are
  // used", fixed only in >=15.5.24), and the `remotePatterns` below carried no
  // `pathname` constraint, so any URL on an allow-listed host — including one
  // serving attacker-chosen AVIF bytes — was a valid input to the optimizer.
  //
  // This costs us NOTHING, which is why it is the right interim fix rather
  // than a rushed major upgrade: `next/image` is imported in ZERO files.
  // components/brand-mark.tsx:32 explains it was deliberately skipped, and the
  // two hosts below appear nowhere except this config — no component ever
  // referenced either. The config was vestigial; the endpoint it opened was
  // not.
  //
  // `unoptimized: true` makes the optimizer inert, so the route stops
  // transforming untrusted bytes. Restore the block below (WITH a `pathname`
  // constraint per host) only after the Next 15.5.24+ upgrade, and only if
  // something actually needs `next/image`.
  images: {
    unoptimized: true,
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

// Wrap with @next/bundle-analyzer when ANALYZE=true so `npm run analyze`
// opens the treemap visualization at build time. No-op in normal builds.
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

// Wrap with @sentry/nextjs only when source-map upload is configured
// (SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT). Without that the
// runtime SDK still works fine — errors report with minified stacks until
// upload is set up. The wrapper is a no-op without DSN, so unconfigured
// builds behave identically to having no Sentry installed.
const { withSentryConfig } = require("@sentry/nextjs");

// Sentry needs FOUR env vars to upload source maps:
//   SENTRY_DSN (always required to emit events at runtime)
//   SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT (required for upload)
//
// Previously we only checked DSN + AUTH_TOKEN. With a partial config
// (org missing, or project missing) the wrapper silently no-ops the upload
// step at build time and prod errors come back with minified stacks
// forever. Throw early so a misconfig surfaces during `next build`.
const hasSentryRuntime = !!process.env.SENTRY_DSN;
const hasSentryUpload =
  !!process.env.SENTRY_AUTH_TOKEN && !!process.env.SENTRY_ORG && !!process.env.SENTRY_PROJECT;
const partialUpload =
  !!process.env.SENTRY_AUTH_TOKEN || !!process.env.SENTRY_ORG || !!process.env.SENTRY_PROJECT;

if (partialUpload && !hasSentryUpload) {
  throw new Error(
    "Sentry source-map upload is partially configured. Set ALL of " +
      "SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT — or unset them all. " +
      "Got: " +
      JSON.stringify({
        SENTRY_AUTH_TOKEN: !!process.env.SENTRY_AUTH_TOKEN,
        SENTRY_ORG: !!process.env.SENTRY_ORG,
        SENTRY_PROJECT: !!process.env.SENTRY_PROJECT,
      })
  );
}

const sentryEnabled = hasSentryRuntime && hasSentryUpload;

const finalConfig = withBundleAnalyzer(nextConfig);

module.exports = sentryEnabled
  ? withSentryConfig(finalConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      tunnelRoute: "/monitoring",
      hideSourceMaps: true,
      disableLogger: true,
      automaticVercelMonitors: false,
    })
  : finalConfig;
