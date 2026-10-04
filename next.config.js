/** @type {import('next').NextConfig} */

const { buildCspHeader } = require("./lib/security/csp");
const { buildStrictTransportSecurity } = require("./lib/security/hsts");

const isProd = process.env.NODE_ENV === "production";

// CSP. The directive list lives in lib/security/csp.js so that
// tests/security/csp-header.test.ts can assert the PRODUCTION policy from a
// test process (where NODE_ENV is "test", making the prod branch of an inline
// ternary unreachable). That file also documents sec-009: production `script-src`
// still allows inline scripts, because Next.js inlines its own flight chunks
// into every page and the only alternative is a per-request nonce, which costs
// static rendering app-wide. Read the comment there before changing it.
const cspHeader = buildCspHeader({ isProd });

// HSTS. Same arrangement as the CSP, and for a second reason on top of
// testability: this is the one security header a browser REMEMBERS, so its
// value is a commitment rather than a setting. lib/security/hsts.js holds the
// value, the ramp it is partway up (prodready-023) and what has to be verified
// before the next rung. `null` there means "send no header at all", which is
// what every `next dev` gets.
const hstsHeader = buildStrictTransportSecurity({ isProd });

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspHeader },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(hstsHeader === null ? [] : [{ key: "Strict-Transport-Security", value: hstsHeader }]),
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
