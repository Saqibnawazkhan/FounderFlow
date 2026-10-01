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
   * `worker-src` must stay INHERITED. The PWA registers /sw.js
   * (components/providers.tsx), and `worker-src` falls back to `child-src` and
   * then `default-src 'self'`. `frame-src 'none'` does not touch that chain,
   * but `child-src 'none'` would kill the service worker.
   */
  it("narrows neither child-src nor worker-src", () => {
    expect(prod.has("child-src")).toBe(false);
    expect(prod.has("worker-src")).toBe(false);
  });

  it("keeps the anti-injection directives that do not depend on inline scripts", () => {
    expect(prod.get("default-src")).toEqual(["'self'"]);
    expect(prod.get("base-uri")).toEqual(["'self'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
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
