/**
 * The Content-Security-Policy, built in one place.
 *
 * `next.config.js` is the only caller in the app: it turns the string this
 * returns into the `Content-Security-Policy` response header for every route.
 *
 * WHY THIS IS `.js` AND NOT `.ts`: next.config.js is plain CommonJS loaded by
 * Node before any TypeScript tooling exists, so it cannot `require` a `.ts`
 * module. Keeping the policy here instead of inline in next.config.js is what
 * lets tests/security/csp-header.test.ts assert the PRODUCTION policy from a
 * test process, where `NODE_ENV` is "test" and the production branch would
 * otherwise be unreachable.
 */

/**
 * Module-private on purpose: `buildCspHeader` is the whole public surface.
 * This was exported with no caller anywhere outside this file until
 * prodready-011 collapsed it — a dead export is the shape this repo keeps
 * growing, and an unused second entry point into the security policy is a
 * worse one than most.
 *
 * @param {{ isProd: boolean }} opts
 */
function buildCspDirectives({ isProd }) {
  // WHY PRODUCTION STILL SENDS 'unsafe-inline' (sec-009) — this is a known OPEN
  // gap, not an oversight, and it cannot be closed by deleting the token.
  //
  // This replaced `script-src 'self' ${isProd ? "" : "'unsafe-eval'"}
  // 'unsafe-inline'`, which READ as if production were the tightened case. The
  // ternary only ever governed 'unsafe-eval'. Nothing about the inline
  // allowance changed here; the misleading shape did.
  //
  //   * Every page this app serves carries dozens of inline
  //     `<script>self.__next_f.push(...)</script>` flight chunks that Next.js
  //     emits itself — 66 of them in the HTML of `/` alone. Next.js puts a nonce
  //     on its own inline scripts ONLY when the REQUEST already carries a CSP
  //     containing one: in the installed next@14.2.35 it parses
  //     `req.headers["content-security-policy"]`
  //     (next/dist/server/app-render/app-render.js:572). So a nonce has to be
  //     minted per request in middleware.ts.
  //   * Reading that nonce back for OUR inline script (the theme/locale
  //     bootstrap in app/layout.tsx) means calling `headers()` in the ROOT
  //     layout, which opts every route out of static generation — the marketing
  //     page included, which app/layout.tsx deliberately keeps static and says
  //     so. And a statically prerendered page's inline scripts carry no nonce
  //     at all, so they are blocked the moment 'unsafe-inline' goes, with or
  //     without that layout change.
  //   * Per CSP3, 'unsafe-inline' is IGNORED as soon as the source list holds a
  //     nonce- or hash-source. So there is no incremental step: one `'sha256-…'`
  //     added for the bootstrap would blank every page.
  //
  // Closing it is one atomic trade — nonce in middleware, `headers()` in the
  // root layout, every route dynamically rendered — so it is the owner's call,
  // not a tidy-up. Until then the honest statement is that `script-src` stops
  // remote script loads and nothing inline. tests/security/csp-header.test.ts
  // pins the invariant that the token may only leave together with a nonce.
  //
  // 'unsafe-eval' is Next's dev compiler + HMR. It is never sent in production.
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (!isProd) scriptSrc.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    // NO GOOGLE FONTS ORIGIN (prodready-011). `style-src` allowed
    // fonts.googleapis.com and `font-src` allowed fonts.gstatic.com; neither
    // has a caller. `next/font/google` (app/layout.tsx, and
    // components/landing/fonts.ts for the landing display face) downloads the
    // faces at BUILD time and self-hosts them: every `src:url(…)` in the built
    // `.next/static/css/*.css` points at `/_next/static/media/*.woff2`, and no
    // prerendered page references either host. `next/og`'s edge route does
    // fetch fonts.googleapis.com, but that is a server-side `fetch`, which no
    // CSP governs.
    //
    // 'unsafe-inline' stays on `style-src`: React style attributes and Next's
    // own injected <style> blocks are inline, and unlike script there is no
    // injected-CSS sink here worth the breakage.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://ui-avatars.com https://images.unsplash.com",
    "font-src 'self' data:",
    // 'self' covers RSC/Server-Action fetches + the same-origin Sentry tunnel
    // (/monitoring). The explicit sentry.io ingest hosts are a fallback so
    // browser-side error reporting still works when the tunnel isn't active
    // (partial Sentry config) instead of being silently blocked by CSP.
    "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io",
    // All three would otherwise be INHERITED from `default-src 'self'`, which
    // is not wrong but is looser than this app needs, and moves the day
    // `default-src` does.
    //
    // 'none' for the first two because nothing here embeds a plugin or a frame:
    // there is no <object>, <embed> or <iframe> in the tree, `next/image` is off
    // (see next.config.js) and LemonSqueezy checkout is a hosted redirect
    // (lib/actions/billing.ts), not an overlay script + iframe.
    //
    // `worker-src 'self'` and not 'none' (prodready-011): the PWA registers
    // /sw.js (components/providers.tsx), which is same-origin. Declaring it is a
    // no-op on behaviour — undeclared, `worker-src` fell back through an
    // undeclared `child-src` to `default-src 'self'`, so 'self' was already the
    // effective value. It is now pinned there.
    //
    // `child-src` stays undeclared, and is inert now that both directives that
    // fall back through it are explicit. It must NOT become 'none': that is the
    // one spelling that would kill the service worker.
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}

/**
 * The header value. Directive order is cosmetic; CSP is a set.
 *
 * @param {{ isProd: boolean }} opts
 * @returns {string}
 */
function buildCspHeader(opts) {
  return buildCspDirectives(opts).join("; ");
}

module.exports = { buildCspHeader };
