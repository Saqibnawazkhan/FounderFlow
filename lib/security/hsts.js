/**
 * Strict-Transport-Security, built in one place.
 *
 * `next.config.js` is the only caller: it turns the string this returns into
 * the `Strict-Transport-Security` response header for every route, and sends no
 * such header at all when this returns `null`.
 *
 * WHY THIS IS `.js` AND NOT `.ts`, same as lib/security/csp.js: next.config.js
 * is plain CommonJS loaded by Node before any TypeScript tooling exists, so it
 * cannot `require` a `.ts` module. Keeping the value here instead of inline in
 * next.config.js is what lets tests/security/hsts-header.test.ts assert the
 * PRODUCTION value from a test process, where `NODE_ENV` is "test" and the
 * production branch would otherwise be unreachable.
 *
 * ── WHY THE VALUE IS SMALL, AND WHY THAT IS NOT A WEAKENING (prodready-023) ──
 *
 * From the day it was written until 2026-10-04 this header was, flatly:
 *
 *     max-age=63072000; includeSubDomains; preload
 *
 * Two years, every subdomain, and an announcement that the domain is ready to
 * be hard-coded into browser binaries — and it had never been observed on a
 * served response by anybody. `scripts/qa-production-readiness.mjs` reports it
 * as "absent — prod-only branch, never exercised before launch".
 *
 * HSTS is the one security header a browser REMEMBERS, which makes its value a
 * commitment rather than a setting. Every other header in next.config.js
 * applies to the response that carries it: get one wrong and the next deploy
 * fixes it. Once a client has cached `max-age=63072000; includeSubDomains`,
 * that client refuses plain HTTP for this host AND every subdomain of it for
 * two years, and the only way to withdraw it is to serve `max-age=0` over
 * WORKING HTTPS to that same client — precisely what is missing in the
 * situation where withdrawal is needed. A subdomain that cannot do HTTPS (a
 * status page, a docs host, a legacy http redirect) is simply unreachable for
 * everyone who ever loaded the app. `preload` is worse again: it is a request
 * to be baked into browser binaries via hstspreload.org, and removal from that
 * list takes months of release trains.
 *
 * So the value ships on the first rung of a ramp: real protection for returning
 * visitors, renewed on every visit, and a promise that expires by itself within
 * a day if the rung above turns out to be wrong. THE LADDER — each rung gated
 * on something a human has to look at, because none of it can be checked from
 * inside the repo:
 *
 *   1. `max-age=86400` (where we are today). Verify the header actually
 *      arrives, on the canonical domain, over real HTTPS:
 *        curl -sI https://<canonical-domain>/ | grep -i strict-transport
 *      and confirm every http entry point redirects to https.
 *   2. Add `includeSubDomains` — only after enumerating the subdomains of the
 *      canonical domain and confirming each serves HTTPS. That is a DNS
 *      question; nothing here can answer it.
 *   3. Raise `max-age` to 31536000 (one year) and leave it a release or two
 *      with nothing breaking.
 *   4. Add `preload` and submit at https://hstspreload.org. The list requires
 *      `max-age` >= 31536000 AND `includeSubDomains` AND `preload` together,
 *      which is why rung 4 cannot precede rungs 2 and 3.
 *
 * Each rung is one edit here plus one edit in
 * tests/security/hsts-header.test.ts, which pins the current rung so that
 * climbing is deliberate rather than a drive-by.
 *
 * ── WHY `next dev` GETS NO HEADER AT ALL ────────────────────────────────────
 *
 * `isProd` in next.config.js is `NODE_ENV === "production"`, so this covers
 * every `next build` output — production Vercel, preview deploys and a local
 * `next start` alike — and never `next dev`. Per RFC 6797 §8.1 a browser
 * ignores the header unless it arrives over a secure transport, so a local
 * `next start` on http://localhost could not pin anything even if it sent it.
 * The gate earns its place for the developer who puts a TLS proxy in front of
 * localhost: HSTS is keyed on host and IGNORES the port, so one pinned
 * `localhost` would force https on every other project served from localhost on
 * that machine, for the whole max-age, with no way to undo it from here.
 */

/**
 * Seconds a client should refuse plain HTTP for this host. Rung 1 of the ladder
 * above: one day, so an unverified commitment lapses on its own.
 */
const MAX_AGE_SECONDS = 86400;

/**
 * The header value, or `null` when no `Strict-Transport-Security` header should
 * be sent at all.
 *
 * @param {{ isProd: boolean }} opts
 * @returns {string | null}
 */
function buildStrictTransportSecurity({ isProd }) {
  if (!isProd) return null;
  return `max-age=${MAX_AGE_SECONDS}`;
}

module.exports = { buildStrictTransportSecurity, MAX_AGE_SECONDS };
