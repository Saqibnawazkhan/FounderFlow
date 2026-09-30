/**
 * auth-016, the structural half: every value interpolated into an email's HTML
 * body goes through `escapeHtml`, and `escapeHtml` exists exactly once.
 *
 * WHY A SWEEP AND NOT FIVE MORE UNIT TESTS.
 * tests/lib/email/transactional-escaping.test.ts pins the five bodies that were
 * actually broken, with a poisoned customer name. It says nothing about the
 * sixth body somebody adds next month. The defect auth-016 describes is not "a
 * name was forgotten in three files" — it is that escaping here was a habit
 * rather than a rule, and habits are per-author. A `${…}` in an email body is
 * the boundary; this file is the rule at that boundary.
 *
 * AND WHY THE ONE-DEFINITION ASSERTION IS THE OTHER HALF. `escapeHtml` was
 * copy-pasted into THREE files (lib/email/templates/invite.ts:71,
 * notification.ts:90, security-notice.ts:342), byte-identical, each private to
 * its module. Three copies of a five-line security primitive is three chances
 * for one of them to drift — and the one that drifts is the one nobody re-reads,
 * because it looks like the two that are right. So the definition is now single
 * and shared (lib/email/html.ts), and a second definition anywhere under lib/
 * fails here.
 *
 * WHAT COUNTS AS ESCAPED, and why the allow-list is compared in BOTH
 * directions: an exception you can append to without anyone noticing is
 * decoration. A raw interpolation must be listed WITH a reason, and a listed
 * entry that is no longer raw fails too — so a reason cannot outlive the code it
 * excused (the same mechanism as PRE_AUTH_ENDPOINTS in
 * tests/lib/actions/action-auth-gates.test.ts and the NOT_YET_CONVERTED map in
 * tests/lib/layout/rtl.test.ts).
 *
 * The scanner is exercised against synthetic sources at the bottom, because
 * every assertion over the real tree reports an empty list — which is also what
 * a scanner that has stopped finding anything reports.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();

/**
 * The files that build an email body as HTML text. Kept explicit rather than
 * discovered, so that adding a new one is a decision — and the coverage test
 * below is what makes the list impossible to forget: any file under lib/ or app/
 * that builds an HTML email body and is not listed here fails, whether or not
 * it is the code that posts it.
 */
const EMAIL_BODY_FILES = [
  "lib/actions/email-change.ts",
  "lib/actions/password-reset.ts",
  "lib/email/templates/invite.ts",
  "lib/email/templates/notification.ts",
  "lib/email/templates/security-notice.ts",
  "lib/email/verification.ts",
];

/** Where the one shared escaper lives. */
const ESCAPER_MODULE = "lib/email/html.ts";

/**
 * Interpolations that are deliberately NOT escaped, keyed by file, each with the
 * reason it is safe. Expressions are matched after collapsing whitespace.
 *
 * Two kinds only:
 *   • a URL this app built itself — `appOrigin()` + a fixed path + a JWT or a
 *     UUID. No customer text reaches one, and escaping `&` inside an href would
 *     be wrong for the query strings a future link may carry.
 *   • an HTML fragment assembled a few lines above out of already-escaped
 *     pieces. Escaping it again would print its own tags.
 */
const ALLOWED_RAW: Record<string, Record<string, string>> = {
  "lib/actions/email-change.ts": {
    url: "appOrigin() + /verify-email-change + the signed token; no customer text in it.",
    "applied ? 'Your login email was changed' : 'Your login email is being changed'":
      "Two literal strings chosen by a boolean — there is no value to escape.",
  },
  "lib/actions/password-reset.ts": {
    url: "appOrigin() + /reset-password + the signed token; no customer text in it.",
  },
  "lib/email/templates/invite.ts": {
    "v.acceptUrl": "appOrigin() + /invite/ + a UUID token, built in lib/actions/team.ts.",
  },
  "lib/email/templates/notification.ts": {
    "v.actionUrl": "appOrigin() + an in-app path, built in lib/notify/email.ts.",
    "v.preferencesUrl": "appOrigin() + /settings, built in lib/notify/email.ts.",
  },
  "lib/email/templates/security-notice.ts": {
    "c.action.url": "appOrigin() + a fixed in-app path, chosen by `kind` in this file.",
    paragraphs: "An HTML fragment built above from escapeHtml()'d paragraphs.",
    // WAS: "its two values are escaped there" — false, and this file is the one
    // place a false reason must not survive. The fragment
    // (lib/email/templates/security-notice.ts:204-213) interpolates THREE
    // values, not two: `escapeHtml(c.action.label)` in the anchor text, and
    // `c.action.url` RAW twice — once in the href, once in the paste-this-link
    // paragraph. The URL is safe because of the `c.action.url` entry directly
    // above, which vouches for its provenance; it is not safe because this
    // fragment escaped it, and it does not.
    //
    // Worth knowing about the guard below: its both-directions check catches a
    // reason that is UNUSED, never one that is merely WRONG. A stale exception
    // fails the suite; a mistaken justification like the old wording sits here
    // indefinitely, read as settled. So these sentences are load-bearing prose
    // and deserve the same scrutiny as the code.
    button:
      "An HTML fragment built above. Its label is escapeHtml()'d there; " +
      "`c.action.url` appears raw twice and is covered by its own entry above.",
  },
  "lib/email/verification.ts": {
    url: "appOrigin() + /verify-email + the signed token; no customer text in it.",
  },
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* the scanner                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

type Interp = { expr: string; line: number };
type Template = { raw: string; line: number; interps: Interp[] };

/**
 * Every template literal in a source file, with its `${…}` expressions.
 *
 * A single character-state pass rather than a regex, because both shortcuts give
 * a wrong answer on the real files here: the doc comments in
 * lib/actions/email-change.ts quote `` `${linkBase()}/forgot-password` `` in
 * prose, so a regex over the raw text finds an "interpolation" in a comment; and
 * ordinary strings hold `"http://…"`, so a naive `//` comment strip eats the
 * rest of the line.
 *
 * REGEX LITERALS ARE SKIPPED, and that is not a nicety. The equivalent scanners
 * in tests/lib/actions/{reachability,action-auth-gates,use-server-exports} do
 * not, so a `"` inside a regex — `escapeHtml`'s own `.replace(/"/g, …)` is one —
 * reads as the start of a string literal and blanks the rest of the file. That
 * cost an hour on this very change: app/verify-email-change/page.tsx briefly
 * shape-checked an address with `[^\s<>"@]`, and reachability then reported
 * `confirmEmailChangeAction` as an action with no caller, because the call had
 * been blanked. A scanner that goes silently blind is worse than no scanner, so
 * this one handles it and the fixtures below pin it.
 */
function templateLiterals(src: string): Template[] {
  const BACKSLASH = String.fromCharCode(92);
  const out: Template[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  /**
   * Can a `/` here open a regex literal rather than divide? The last meaningful
   * character decides: after a value (identifier, `)`, `]`, number) it is
   * division; after an operator, a comma or an opening bracket it is a regex.
   *
   * Known limit, stated rather than hidden: `return /…/` and `typeof /…/` read as
   * division here, because the previous character is a letter. Both are
   * safe-for-now (a missed regex only matters if it CONTAINS a quote or a
   * backtick, and no scanned file has one) and both fail loudly rather than
   * quietly — a mis-scan makes this file's own fixtures or assertions move, not a
   * silent pass, because the six files it checks all have HTML templates in them.
   */
  function regexCanStartAfter(prev: string): boolean {
    return prev === "" || "(,=:[!&|?{};+-*%~^<>".indexOf(prev) >= 0;
  }

  /** Skips a regex literal, assuming `src[i]` is its opening slash. */
  function skipRegex(): void {
    i += 1;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === BACKSLASH) {
        i += 2;
        continue;
      }
      if (c === "\n") break; // unterminated — treat as division after all
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i += 1;
        break;
      }
      i += 1;
    }
    while (i < n && /[a-z]/.test(src[i])) i += 1; // flags
  }

  /** Reads one `${…}` body, assuming `src[i]` is the char after `${`. */
  function readExpr(): string {
    const start = i;
    let depth = 1;
    let prev = "";
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === "\n") line += 1;
      if (c === BACKSLASH) {
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        i += 1;
        while (i < n && src[i] !== q) {
          if (src[i] === BACKSLASH) i += 1;
          if (src[i] === "\n") line += 1;
          i += 1;
        }
        i += 1;
        prev = q;
        continue;
      }
      if (c === "/" && regexCanStartAfter(prev)) {
        skipRegex();
        prev = "/";
        continue;
      }
      if (c === "`") {
        readTemplate();
        prev = "`";
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      if (c === "{") depth += 1;
      if (c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    const expr = src.slice(start, i);
    i += 1; // past the closing }
    return expr;
  }

  /** Reads one template literal, assuming `src[i]` is its opening backtick. */
  function readTemplate(): Template {
    const openedAt = line;
    i += 1;
    let raw = "";
    const interps: Interp[] = [];
    while (i < n) {
      const c = src[i];
      if (c === BACKSLASH) {
        raw += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        break;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        const at = line;
        const expr = readExpr();
        interps.push({ expr, line: at });
        raw += "\u0000";
        continue;
      }
      if (c === "\n") line += 1;
      raw += c;
      i += 1;
    }
    const tmpl = { raw, line: openedAt, interps };
    out.push(tmpl);
    return tmpl;
  }

  let prev = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === BACKSLASH) i += 1;
        i += 1;
      }
      i += 1;
      prev = q;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prev)) {
      skipRegex();
      prev = "/";
      continue;
    }
    if (c === "`") {
      readTemplate();
      prev = "`";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }

  return out;
}

/** Does this template literal look like an email body rather than a URL or a key? */
const HTML_TAG =
  /<\/?(?:!doctype|html|head|body|div|p|h1|h2|h3|h4|table|tr|td|a|strong|em|b|hr|span|br|ul|ol|li|img)\b/i;

function isHtmlBody(t: Template): boolean {
  return HTML_TAG.test(t.raw);
}

/**
 * `const safeName = escapeHtml(...)` — the locals that are escaped by
 * construction, and therefore safe to interpolate bare.
 *
 * AN IDENTIFIER ASSIGNED FROM ANYTHING ELSE AS WELL IS NOT RETURNED. This map is
 * file-global — there is no scope analysis here — so without that rule one
 * `const name = escapeHtml(u.name)` inside one function would vouch for every
 * `${name}` in the file, including a different `name` in another function that
 * was never escaped. Shadowing like that is normal in these templates, so the
 * conservative answer is to trust a name only when EVERY assignment to it in the
 * file goes through the escaper. A name that is sometimes escaped and sometimes
 * not has to be written as `${escapeHtml(name)}` at the boundary, which is the
 * honest spelling anyway.
 */
function escapedLocals(src: string): string[] {
  const escaped = new Set<string>();
  const other = new Set<string>();
  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(escapeHtml\s*\()?/g;
  let m = re.exec(src);
  while (m !== null) {
    (m[2] ? escaped : other).add(m[1]);
    m = re.exec(src);
  }
  // `Array.from`, not `[...escaped]`: tsconfig sets `lib` but no `target`, so a
  // Set spread is TS2802 ("can only be iterated through when using
  // --downlevelIteration"). vitest transpiles with esbuild and does not care, so
  // this shape passes every test and fails `npm run typecheck` — the trap
  // CLAUDE.md records, walked into while fixing something else.
  return Array.from(escaped).filter((name) => !other.has(name));
}

/**
 * Is this interpolation's ENTIRE value one `escapeHtml(...)` call?
 *
 * Not `expr.includes("escapeHtml(")`, which is what this used to be. That
 * trusted any expression merely MENTIONING the escaper, so
 * `${cond ? escapeHtml(a) : b}` passed with `b` going to the customer raw — a
 * hole in the shape of the bug the whole file exists to prevent. The opening
 * paren's matching close must be the last character, so a call followed by any
 * concatenation is rejected and has to be escaped piecewise.
 */
function isFullyEscaped(expr: string): boolean {
  const t = expr.trim();
  const open = /^escapeHtml\s*\(/.exec(t);
  if (!open) return false;
  let depth = 0;
  for (let i = open[0].length - 1; i < t.length; i += 1) {
    if (t[i] === "(") depth += 1;
    else if (t[i] === ")") {
      depth -= 1;
      if (depth === 0) return i === t.length - 1;
    }
  }
  return false;
}

function normalize(expr: string): string {
  return expr.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

type Violation = { file: string; line: number; expr: string };

/** Every interpolation into an HTML body that is neither escaped nor allow-listed. */
function rawInterpolations(file: string, src: string): Violation[] {
  const locals = escapedLocals(src);
  const allowed = ALLOWED_RAW[file] ?? {};
  const bad: Violation[] = [];
  templateLiterals(src)
    .filter(isHtmlBody)
    .forEach((t) => {
      t.interps.forEach((it) => {
        const expr = normalize(it.expr);
        if (isFullyEscaped(it.expr)) return;
        if (/^[A-Za-z_$][\w$]*$/.test(expr) && locals.indexOf(expr) >= 0) return;
        if (Object.prototype.hasOwnProperty.call(allowed, expr)) return;
        bad.push({ file, line: it.line, expr });
      });
    });
  return bad;
}

/** Which allow-list entries a file's HTML bodies actually still need. */
function rawExpressions(file: string, src: string): string[] {
  const locals = escapedLocals(src);
  const found: string[] = [];
  templateLiterals(src)
    .filter(isHtmlBody)
    .forEach((t) => {
      t.interps.forEach((it) => {
        const expr = normalize(it.expr);
        if (isFullyEscaped(it.expr)) return;
        if (/^[A-Za-z_$][\w$]*$/.test(expr) && locals.indexOf(expr) >= 0) return;
        if (found.indexOf(expr) < 0) found.push(expr);
      });
    });
  return found;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel.split("/").join(sep)), "utf8");
}

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  readdirSync(join(ROOT, dir.split("/").join(sep)), { withFileTypes: true }).forEach((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next") return;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) tsFilesUnder(rel, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
  });
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────── */

describe("auth-016 — the escaping boundary for email HTML", () => {
  EMAIL_BODY_FILES.forEach((file) => {
    it(`${file} escapes every value it interpolates into an email body`, () => {
      const bad = rawInterpolations(file, read(file));
      expect(
        bad.map((v) => `${v.file}:${v.line} \${${v.expr}}`),
        `These values reach an email's HTML body unescaped. Wrap each in escapeHtml() ` +
          `from ${ESCAPER_MODULE}, or add it to ALLOWED_RAW in this file with the reason ` +
          `it cannot carry customer text.`
      ).toEqual([]);
    });
  });

  it("has no stale ALLOWED_RAW entries", () => {
    const stale: string[] = [];
    Object.keys(ALLOWED_RAW).forEach((file) => {
      const live = rawExpressions(file, read(file));
      Object.keys(ALLOWED_RAW[file]).forEach((expr) => {
        if (live.indexOf(expr) < 0) stale.push(`${file}: \${${expr}}`);
      });
    });
    expect(
      stale,
      "These exceptions no longer describe anything in the source — the expression is " +
        "escaped now, or gone. Delete the entry, so a reason cannot outlive its reason."
    ).toEqual([]);
  });
});

describe("auth-016 — one escapeHtml, not three", () => {
  it("is defined in exactly one module", () => {
    const definers = tsFilesUnder("lib").filter((rel) => {
      const src = read(rel);
      return (
        /(?:export\s+)?function\s+escapeHtml\b/.test(src) ||
        /(?:const|let)\s+escapeHtml\s*[:=]\s*(?:\(|function)/.test(src)
      );
    });
    expect(
      definers,
      "escapeHtml must live in one module and be imported. A second copy is a second " +
        "chance for one of them to drift, and the one that drifts is the one nobody re-reads."
    ).toEqual([ESCAPER_MODULE]);
  });

  it("is exported from that module and escapes all five characters", async () => {
    const { escapeHtml } = await import("@/lib/email/html");
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
    // The ampersand must be replaced FIRST, or the entities the other four
    // produce get their own `&` re-escaped into `&amp;lt;`.
    expect(escapeHtml("<")).toBe("&lt;");
  });
});

describe("auth-016 — the file list cannot go stale", () => {
  it("lists every file that builds an email body inline", () => {
    const suspects = tsFilesUnder("lib")
      .concat(tsFilesUnder("app"))
      .filter((rel) => EMAIL_BODY_FILES.indexOf(rel) < 0)
      .filter((rel) => {
        const src = read(rel);
        // NO `sendEmail(` REQUIREMENT, deliberately. It used to be one, and it
        // was blind to the file shape this very list already contains twice:
        // lib/email/templates/invite.ts and notification.ts never call
        // sendEmail — they RETURN { html, text } for lib/notify/email.ts and
        // lib/actions/team.ts to send. Both were covered only because somebody
        // hand-listed them, which is exactly the coverage this test exists to
        // stop depending on, so a seventh template of the same shape was
        // invisible. Building an email body is the property that matters; who
        // posts it is not.
        //
        // MEASURED, NOT ASSUMED: with the gate removed this assertion still
        // reports an empty list over the whole of lib/ and app/, so the wider
        // net adds no noise today. isHtmlBody is what keeps it that way — it
        // demands a real tag from HTML_TAG, so a template holding a URL, a
        // class name or an i18n key does not qualify.
        return templateLiterals(src).some(isHtmlBody);
      });
    expect(
      suspects,
      "This file builds an HTML email body but is not in EMAIL_BODY_FILES, so " +
        "nothing checks its interpolations. Add it to the list. (Returning the body " +
        "for someone else to post still counts — invite.ts and notification.ts do " +
        "exactly that.)"
    ).toEqual([]);
  });
});

describe("the scanner itself", () => {
  const FIXTURE = "fixture.ts";

  function scanSource(src: string): Violation[] {
    return rawInterpolations(FIXTURE, src);
  }

  it("flags a bare interpolation in an HTML body", () => {
    const src = "const html = `<p>Hi ${user.name},</p>`;";
    expect(scanSource(src).map((v) => v.expr)).toEqual(["user.name"]);
  });

  it("accepts an escaped one", () => {
    const src = "const html = `<p>Hi ${escapeHtml(user.name)},</p>`;";
    expect(scanSource(src)).toEqual([]);
  });

  it("accepts a local assigned from escapeHtml", () => {
    const src = ["const safe = escapeHtml(v.name);", "const html = `<p>Hi ${safe},</p>`;"].join(
      "\n"
    );
    expect(scanSource(src)).toEqual([]);
  });

  it("flags a conditional where only one branch is escaped", () => {
    // B-07, found by adversarial verification. The check used to be
    // `expr.includes("escapeHtml(")`, so an expression that merely MENTIONED the
    // escaper was trusted whole — and this is the shape where that matters: `b`
    // reaches the customer raw, inside a file whose entire purpose is to make
    // that impossible. Deleting `isFullyEscaped`'s length check turns this red.
    const src = "const html = `<p>Hi ${cond ? escapeHtml(a) : b},</p>`;";
    expect(scanSource(src).map((v) => v.expr)).toEqual(["cond ? escapeHtml(a) : b"]);
  });

  it("flags a call with something concatenated after it", () => {
    const src = "const html = `<p>${escapeHtml(a) + suffix}</p>`;";
    expect(scanSource(src).map((v) => v.expr)).toEqual(["escapeHtml(a) + suffix"]);
  });

  it("accepts nested parens inside the escaped expression", () => {
    // The strict form must not overshoot: this IS fully escaped, and rejecting
    // it would push authors back toward the loose check.
    const src = "const html = `<p>${escapeHtml(pick(a, b))}</p>`;";
    expect(scanSource(src)).toEqual([]);
  });

  it("does not trust a local that is ALSO assigned from something unescaped", () => {
    // B-07's second half. `escapedLocals` is file-global, so one escaped
    // assignment used to vouch for every `${name}` in the file — including a
    // shadowing `name` in another function that never touched the escaper.
    // BOTH sites are reported, the escaped one included, and that is the
    // intended answer rather than a rough edge. There is no scope analysis here,
    // so the scanner cannot tell which `${name}` it is looking at — and the safe
    // direction for a security guard is to stop trusting the identifier entirely
    // and make the author write `${escapeHtml(name)}` at each boundary. The
    // alternative, trusting both, is the hole this closes.
    const src = [
      "function a() { const name = escapeHtml(v.name); return `<p>${name}</p>`; }",
      "function b() { const name = v.name; return `<p>${name}</p>`; }",
    ].join("\n");
    expect(scanSource(src).map((v) => v.expr)).toEqual(["name", "name"]);
  });

  it("ignores a template literal quoted inside a comment", () => {
    const src = [
      "/* prose that mentions `<p>Hi ${user.name}</p>` in passing */",
      "const html = `<p>ok</p>`;",
    ].join("\n");
    expect(scanSource(src)).toEqual([]);
  });

  it("is not fooled by a // inside a string", () => {
    const src = [
      'const base = "http://localhost:3000";',
      "const html = `<p>${user.name}</p>`;",
    ].join("\n");
    expect(scanSource(src).map((v) => v.expr)).toEqual(["user.name"]);
  });

  it("is not blinded by a double quote inside a regex literal", () => {
    // This is the exact shape that broke tests/lib/actions/reachability.test.ts
    // during this change: the `"` opens a string there, and everything after it
    // — including the HTML body — is blanked, so the sweep reports nothing and
    // looks like it passed.
    const src = ['const re = /"/g;', "const html = `<p>${user.name}</p>`;"].join("\n");
    expect(scanSource(src).map((v) => v.expr)).toEqual(["user.name"]);
  });

  it("does not mistake a division by a quote-free denominator for a regex", () => {
    const src = ["const half = total / 2;", "const html = `<p>${half}</p>`;"].join("\n");
    expect(scanSource(src).map((v) => v.expr)).toEqual(["half"]);
  });

  it("ignores template literals that are not HTML", () => {
    const src = "const key = `user:${id}`;";
    expect(scanSource(src)).toEqual([]);
  });

  it("reports the line the interpolation is on, not the line the literal opened", () => {
    const src = ["const html = `<div>", "  <p>Hi ${user.name}</p>", "</div>`;"].join("\n");
    expect(scanSource(src).map((v) => v.line)).toEqual([2]);
  });

  it("survives a nested template literal inside an expression", () => {
    const src = "const html = `<p>${escapeHtml(`${a} ${b}`)}</p><p>${c}</p>`;";
    expect(scanSource(src).map((v) => v.expr)).toEqual(["c"]);
  });
});
