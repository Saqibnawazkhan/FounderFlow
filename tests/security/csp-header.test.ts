import { describe, expect, it } from "vitest";

import { buildCspHeader } from "@/lib/security/csp";

/**
 * sec-009 — what the Content-Security-Policy must actually say in production.
 *
 * The policy used to be a template literal inside next.config.js, where
 * `isProd` is captured from `NODE_ENV` at module load. That made the production
 * branch untestable (a test process is `NODE_ENV=test`) and it hid a dead
 * conditional: `script-src 'self' ${isProd ? "" : "'unsafe-eval'"}
 * 'unsafe-inline'` reads as if it tightens in production, but the ternary only
 * governed 'unsafe-eval' — 'unsafe-inline' was unconditional.
 */

/** Split a header value into `directive -> source list`. */
function parse(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const directive of header.split(";")) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [name, ...sources] = parts;
    expect(out.has(name), `duplicate directive "${name}"`).toBe(false);
    out.set(name, sources);
  }
  return out;
}

const prod = parse(buildCspHeader({ isProd: true }));
const dev = parse(buildCspHeader({ isProd: false }));

describe("CSP: production script-src", () => {
  it("never allows eval", () => {
    expect(prod.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("allows remote scripts from nowhere but our own origin", () => {
    const sources = prod.get("script-src") ?? [];
    const hosts = sources.filter((s) => !s.startsWith("'"));
    expect(hosts).toEqual([]);
    expect(sources).toContain("'self'");
  });

  /**
   * The load-bearing invariant, and the reason 'unsafe-inline' is still here.
   *
   * Every page this app serves carries dozens of inline
   * `<script>self.__next_f.push(...)</script>` flight chunks that Next.js emits
   * itself, and Next nonces those only when the REQUEST already carries a CSP
   * with a nonce. So deleting 'unsafe-inline' WITHOUT putting a nonce in its
   * place does not harden the app, it blanks it. Per CSP3 the reverse is also
   * true: a nonce-source makes browsers ignore 'unsafe-inline', so the two must
   * never both be present or the nonce is theatre.
   */
  it("carries exactly one of 'unsafe-inline' or a nonce, never both and never neither", () => {
    const sources = prod.get("script-src") ?? [];
    const inline = sources.includes("'unsafe-inline'");
    const nonce = sources.some((s) => s.startsWith("'nonce-"));
    expect(inline || nonce, "script-src allows no inline script at all").toBe(true);
    expect(inline && nonce, "a nonce makes 'unsafe-inline' ignored — drop one").toBe(false);
  });

  /**
   * Same reason, inverted: a hash-source ALSO makes 'unsafe-inline' ignored, so
   * adding one `'sha256-…'` for app/layout.tsx's bootstrap script to "narrow"
   * the policy would block all of Next's inline chunks. There is no incremental
   * step here.
   */
  it("mixes no hash-source into a policy that still relies on 'unsafe-inline'", () => {
    const sources = prod.get("script-src") ?? [];
    if (!sources.includes("'unsafe-inline'")) return;
    expect(sources.filter((s) => /^'sha(256|384|512)-/.test(s))).toEqual([]);
  });
});

describe("CSP: directives that must be declared, not inherited", () => {
  // Both of these fall back to `default-src 'self'` when undeclared, which is
  // not wrong but is looser than this app needs: nothing here embeds a plugin
  // or a frame.
  it("forbids plugin embeds outright", () => {
    expect(prod.get("object-src")).toEqual(["'none'"]);
    expect(dev.get("object-src")).toEqual(["'none'"]);
  });

  it("forbids framing anything", () => {
    expect(prod.get("frame-src")).toEqual(["'none'"]);
    expect(dev.get("frame-src")).toEqual(["'none'"]);
  });

  /**
   * prodready-011 — `worker-src` is the third script sink, and it was the one
   * left inheriting. Declaring it `'self'` is a NO-OP on behaviour: undeclared,
   * `worker-src` falls back to `child-src` (also undeclared) and then to
   * `default-src 'self'`, so the effective value was already `'self'`. What
   * changes is that it no longer moves when `default-src` does.
   *
   * `'self'` and not `'none'`: the PWA registers /sw.js
   * (components/providers.tsx:80), which is same-origin and therefore allowed.
   * The earlier note here claimed `worker-src` "must stay INHERITED" because
   * `child-src 'none'` would kill the service worker — true of `child-src`, but
   * it was never an argument against `worker-src 'self'`.
   *
   * scripts/qa-production-readiness.mjs:252 has required all three of
   * object-src/frame-src/worker-src to be declared since ce5b25b, and failed on
   * this one.
   */
  it("declares worker-src rather than inheriting it, and still permits /sw.js", () => {
    expect(prod.get("worker-src")).toEqual(["'self'"]);
    expect(dev.get("worker-src")).toEqual(["'self'"]);
  });

  /**
   * `child-src` stays undeclared, and is now inert either way: `frame-src` and
   * `worker-src` are both explicit, so nothing falls back through it.
   */
  it("does not narrow child-src", () => {
    expect(prod.has("child-src")).toBe(false);
    expect(dev.has("child-src")).toBe(false);
  });

  it("keeps the anti-injection directives that do not depend on inline scripts", () => {
    expect(prod.get("default-src")).toEqual(["'self'"]);
    expect(prod.get("base-uri")).toEqual(["'self'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
  });
});

/**
 * prodready-011 — every remote origin in the policy must have a caller.
 *
 * An allowance nobody uses is not free: it is a host an injected `<link>`,
 * `@import` or `@font-face` can still reach, and it makes the policy read as
 * though the app talks to places it does not.
 *
 * `next/font/google` (app/layout.tsx:2 — Inter, JetBrains_Mono,
 * Playfair_Display; components/landing/fonts.ts:15 — Outfit) downloads the
 * faces at BUILD time and self-hosts them. Verified against the built output
 * rather than inferred: every `src:url(…)` in `.next/static/css/*.css` points at
 * `/_next/static/media/*.woff2`, and no prerendered HTML in `.next/server`
 * references either Google host. (`next/og`'s edge route does fetch
 * fonts.googleapis.com, but that is a server-side `fetch`, which no CSP
 * governs.)
 */
describe("CSP: remote origins", () => {
  /** `data:` and `blob:` are scheme-only sources, not origins. Both are in use. */
  const LOCAL_SCHEMES = ["data:", "blob:"];

  /**
   * A source is REMOTE unless it is a CSP keyword (`'self'`, `'none'`,
   * `'unsafe-inline'`, a nonce-source, a hash-source) or one of the two
   * scheme-only sources above — however that remote source is spelled.
   *
   * The predicate here used to be `s.includes("://")`, and that was a hole
   * rather than a shorthand: a CSP host-source needs no scheme, so adding
   * `cdn.example.com` to `style-src` or `font-src` passed every case in this
   * file silently. Measured, not assumed: with that predicate the mutated
   * policy was 15/15 green, and with this one it is red. A bare scheme
   * (`https:`) is caught now too — it is the widest source there is.
   */
  const isRemoteSource = (s: string) => !s.startsWith("'") && !LOCAL_SCHEMES.includes(s);

  const remoteHosts = (directive: string, policy: Map<string, string[]>) =>
    (policy.get(directive) ?? []).filter(isRemoteSource);

  it("allows no remote stylesheet or font origin", () => {
    expect(remoteHosts("style-src", prod)).toEqual([]);
    expect(remoteHosts("font-src", prod)).toEqual([]);
    expect(remoteHosts("style-src", dev)).toEqual([]);
    expect(remoteHosts("font-src", dev)).toEqual([]);
  });

  it("names Google Fonts in no directive at all, since next/font self-hosts", () => {
    for (const isProd of [true, false]) {
      expect(buildCspHeader({ isProd })).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  /**
   * An INVENTORY of every remote origin the policy still allows, not an
   * endorsement of each — so a new one cannot be added, in any spelling
   * `isRemoteSource` above recognises, without this test naming it, and so the
   * ones here are written down rather than remembered.
   *
   *   connect-src sentry.io / *.ingest.sentry.io — JUSTIFIED. The browser SDK
   *     (sentry.client.config.ts) posts events to ingest directly whenever the
   *     same-origin /monitoring tunnel is not active, which is today's state
   *     (the tunnel needs the withSentryConfig wrapper, which needs the upload
   *     trio — see next.config.js).
   *
   *   img-src ui-avatars.com / images.unsplash.com — NO CALLER FOUND. Neither
   *     host appears anywhere in the tree outside lib/security/csp.js and this
   *     file. The reason is NOT a missing avatar column: an earlier version of
   *     this comment said there was none, and that was false — `avatar String?`
   *     is prisma/schema.prisma:82, selected in lib/actions/chat.ts:273 and
   *     :1423 and mapped through lib/queries/users.ts:25. The reason is that
   *     nothing RENDERS it. components/ui/avatar.tsx takes a `name` and draws
   *     initials in a <div>; components/tasks/task-detail-modal.tsx:333 hands it
   *     a name, not a URL; `next/image` is imported nowhere in the app; and the
   *     only <img> in the tree is the local brand mark
   *     (components/brand-mark.tsx:34, a /brand-mark.png src). So the column is
   *     a stored field no element displays, and these two origins are reachable
   *     by injected markup only. Left in place because prodready-011 scoped
   *     itself to the font origins, and recorded here so the next pass can drop
   *     them deliberately instead of rediscovering them. They are image sinks,
   *     not script sinks.
   */
  it("allows exactly this set of remote origins and no others", () => {
    // `.forEach` on the Map, not `for…of` — see the ES5 note at the foot of
    // this file.
    const inventory = (policy: Map<string, string[]>) => {
      const all: string[] = [];
      policy.forEach((sources) => {
        sources.filter(isRemoteSource).forEach((s) => all.push(s));
      });
      return all.sort();
    };
    const expected = [
      "https://*.ingest.sentry.io",
      "https://*.sentry.io",
      "https://images.unsplash.com",
      "https://ui-avatars.com",
    ];
    // Both policies, not just prod: dev is prod plus one script-src token, so
    // an origin that appears in only one of them is a mistake either way.
    expect(inventory(prod)).toEqual(expected);
    expect(inventory(dev)).toEqual(expected);
  });
});

describe("CSP: the header itself", () => {
  it("gives dev, and only dev, the eval the Next dev compiler needs", () => {
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
  });

  it("emits no empty directive and no stray whitespace", () => {
    for (const isProd of [true, false]) {
      const header = buildCspHeader({ isProd });
      expect(header, "doubled space").not.toMatch(/ {2}/);
      expect(header, "empty directive").not.toMatch(/;\s*;|;\s*$/);
      // `.forEach`, not `for…of`: tsconfig.json sets no `target`, so it is ES5
      // and iterating a Map is a typecheck error that vitest does not reproduce.
      parse(header).forEach((sources, name) => {
        expect(sources.length, `${name} has no sources`).toBeGreaterThan(0);
      });
    }
  });

  it("differs between dev and prod in exactly one token", () => {
    const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
    expect(only(dev.get("script-src") ?? [], prod.get("script-src") ?? [])).toEqual([
      "'unsafe-eval'",
    ]);
    expect(only(prod.get("script-src") ?? [], dev.get("script-src") ?? [])).toEqual([]);
  });
});
