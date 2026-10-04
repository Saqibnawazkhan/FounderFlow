import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildStrictTransportSecurity } from "@/lib/security/hsts";

/**
 * prodready-023 — what `Strict-Transport-Security` is allowed to promise
 * BEFORE anybody has seen it on a served response.
 *
 * HSTS is the only security header in this app that a browser remembers. CSP,
 * X-Frame-Options and the rest apply to the response that carries them and
 * nothing else; a wrong one is fixed by the next deploy. A wrong HSTS is cached
 * by every client that received it, for the whole `max-age`, and the only way
 * to withdraw it is to serve `max-age=0` over WORKING HTTPS to that same
 * client — which is exactly what is unavailable in the situation where you need
 * to withdraw it.
 *
 * The value shipped from the day it was written as
 * `max-age=63072000; includeSubDomains; preload`: two years, every subdomain,
 * and an announcement that the domain is ready to be hard-coded into browser
 * binaries. It is sent only under `NODE_ENV === "production"`, so no local run
 * has ever emitted it, and `scripts/qa-production-readiness.mjs:258` records it
 * as "absent — prod-only branch, never exercised before launch". An unverified
 * two-year commitment is the one kind of security header worth being timid
 * about, so the value now sits on the first rung of a ramp and these tests pin
 * which rung it is on.
 *
 * Each rung is one edit in lib/security/hsts.js plus one edit here, and the
 * assertion that blocks each rung says what must be verified first.
 */

/** The value's directives, lowercased, in the order they are sent. */
function directives(header: string): string[] {
  return header
    .split(";")
    .map(function (part) {
      return part.trim().toLowerCase();
    })
    .filter(function (part) {
      return part !== "";
    });
}

function maxAge(header: string): number {
  const match = /(?:^|;)\s*max-age\s*=\s*(\d+)/i.exec(header);
  if (match === null) {
    throw new Error(`no max-age in "${header}" — RFC 6797 makes the directive mandatory`);
  }
  return Number(match[1]);
}

const dev = buildStrictTransportSecurity({ isProd: false });
/** `""` stands in for "no header", which the first test below rules out. */
const prod = buildStrictTransportSecurity({ isProd: true }) ?? "";

describe("HSTS: who gets the header", () => {
  /**
   * The header must never reach a `next dev` response. HSTS is keyed on HOST
   * and ignores the PORT, so one pinned `localhost` forces https on every
   * other project this machine serves from localhost, for the whole max-age.
   * A browser ignores the header over plain http (RFC 6797 §8.1), so today's
   * `next dev` could not be pinned anyway — but a developer who puts a TLS
   * proxy in front of localhost could, and that is unrecoverable from here.
   */
  it("sends nothing in development, so no browser ever pins localhost", () => {
    expect(dev).toBeNull();
  });

  it("sends a well-formed header on a built deploy", () => {
    expect(prod, "a built deploy sends no HSTS header at all").not.toBe("");
    expect(prod, "doubled space").not.toMatch(/ {2}/);
    expect(prod, "empty directive").not.toMatch(/;\s*;|;\s*$/);
    expect(maxAge(prod)).toBeGreaterThan(0);
  });
});

describe("HSTS: the rung this value is on", () => {
  /**
   * RUNG 4 of the ladder in lib/security/hsts.js. `preload` is a request to be
   * baked into browser binaries via hstspreload.org; removal from that list
   * takes months of release trains. Delete this assertion only once the header
   * has been observed on a real HTTPS response from the canonical domain
   * (`curl -sI https://<domain>/ | grep -i strict-transport`) and rungs 2 and 3
   * have shipped.
   */
  it("does not announce preload for a header nobody has yet seen served", () => {
    expect(directives(prod)).not.toContain("preload");
  });

  /**
   * RUNG 2. `includeSubDomains` extends the commitment to hosts this repo
   * cannot enumerate — a status page, a docs host, a legacy http redirect. That
   * is a DNS question, so it is answered by a human, not by a test.
   */
  it("does not extend the commitment to subdomains nobody has enumerated", () => {
    expect(directives(prod)).not.toContain("includesubdomains");
  });

  /**
   * RUNG 3. While the ramp is unverified the commitment must expire on its own,
   * so a wrong rung costs a day rather than two years. Raise this ceiling in
   * the same edit that raises `MAX_AGE_SECONDS`, and only after the header has
   * been seen working.
   */
  it("keeps max-age short enough to expire by itself while unverified", () => {
    expect(
      maxAge(prod),
      "max-age was raised past the unverified ceiling. Confirm the header on a real " +
        "HTTPS response and that every http entry point redirects to https, then raise " +
        "this number and MAX_AGE_SECONDS together"
    ).toBeLessThanOrEqual(2 * 86400);
  });

  /**
   * The rule that outlives the three pins above. hstspreload.org accepts a
   * domain only with `max-age` >= 31536000 AND `includeSubDomains` AND
   * `preload`, so a value that says `preload` with anything less is a
   * commitment that buys nothing: browsers still cache it, the list still
   * rejects the submission.
   */
  it("would only ship preload with what the preload list actually requires", () => {
    const parts = directives(prod);
    if (parts.indexOf("preload") === -1) return;
    expect(parts, "preload without includeSubDomains is rejected by the list").toContain(
      "includesubdomains"
    );
    expect(maxAge(prod), "preload needs max-age >= 31536000").toBeGreaterThanOrEqual(31536000);
  });
});

describe("HSTS: the wiring (a value nothing sends is not a header)", () => {
  const nextConfig = readFileSync(join(process.cwd(), "next.config.js"), "utf8");

  it("is what next.config.js actually sends", () => {
    expect(nextConfig).toContain("buildStrictTransportSecurity");
    expect(nextConfig).toContain('"Strict-Transport-Security"');
  });

  /**
   * The value may not drift back into next.config.js, where `NODE_ENV` makes
   * the production branch untestable — which is how it spent its whole life
   * unexamined. Same argument as lib/security/csp.js.
   *
   * SCOPED TO HSTS ON PURPOSE. This assertion used to be
   * `expect(nextConfig).not.toMatch(/max-age=/)` over the whole file, which is
   * a trap: `headers()` here applies to `/:path*` and is the natural home for a
   * future `Cache-Control: …, max-age=…`, and that entirely unrelated header
   * would have failed an HSTS test under the message "an inline max-age literal
   * is back in next.config.js" — sending the reader hunting for a regression
   * that does not exist. So the check is now two narrow ones: no line may carry
   * an HSTS-shaped literal, and the header's value must still come from the
   * module.
   */
  it("is not duplicated inline in next.config.js", () => {
    const inlined = nextConfig.split("\n").filter(function (line) {
      // `includeSubDomains` and `preload` belong to no other header, and a
      // `max-age=` only counts when it shares a line with HSTS itself.
      if (/includesubdomains/i.test(line)) return true;
      return /max-age=/i.test(line) && /strict-transport/i.test(line);
    });
    expect(
      inlined,
      "an inline Strict-Transport-Security literal is back in next.config.js, where the " +
        "NODE_ENV branch makes it untestable. The value belongs in lib/security/hsts.js"
    ).toEqual([]);

    // The positive half, which catches the same drift even if it is spread over
    // several lines: the header still has to be built by the module.
    expect(
      nextConfig,
      "next.config.js no longer sends buildStrictTransportSecurity's value as the " +
        "Strict-Transport-Security header, so these tests pin a string nothing serves"
    ).toMatch(/"Strict-Transport-Security",\s*value:\s*hstsHeader\b/);
  });
});
