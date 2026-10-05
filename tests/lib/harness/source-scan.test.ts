/**
 * The scanner every structural guard reads its files through, and a sweep for
 * the copies of it that are still private.
 *
 * WHY IT HAS ITS OWN TEST FILE. Twenty guards in this suite answer a question of
 * the form "does the real tree contain X?", and all twenty answer it by blanking
 * the comments and then matching. A scanner that blanks too much reports an
 * empty list, and an empty list is exactly what a healthy tree reports — so
 * every one of those guards fails SILENT when the scanner is wrong. Two
 * independent instances of that were found in one day (audit A40 and A49), both
 * by someone losing an hour to a wrong answer rather than by review.
 *
 * So the scanner is not a utility. It is the sensor, and this file is its
 * calibration.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { codeOnly, dialectFor, normalizeEol, stripComments } from "./source-scan";

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, "tests");

/** The characters a TS source file spells a backslash and a newline with. */
const BS = String.fromCharCode(92);

describe("regex literals (audit A49)", () => {
  it("does not read a quote inside a regex literal as the start of a string", () => {
    // The measured case: app/verify-email-change/page.tsx shape-checked an
    // address with a character class containing a double quote. The old scanner
    // blanked from that quote to the next one — end of file, there being none —
    // and tests/lib/actions/reachability.test.ts then reported
    // confirmEmailChangeAction as an endpoint with no caller while the call sat
    // a few lines below.
    const src = [
      "const SHAPE = /[^<>" + '"' + "@]+/;",
      "export function ok(v: string) {",
      "  return SHAPE.test(v) ? confirmEmailChangeAction(v) : null;",
      "}",
    ].join("\n");
    expect(codeOnly(src)).toContain("confirmEmailChangeAction(v)");
    expect(stripComments(src)).toContain("confirmEmailChangeAction(v)");
  });

  it("does not let a regex literal swallow an export declaration", () => {
    // The direction that reaches a customer rather than costing an hour: in
    // tests/lib/actions/action-auth-gates.test.ts a blanked region hid the
    // `export async function` itself, so an endpoint with no session check
    // vanished from the sweep instead of being reported by it.
    const src = [
      '"use server";',
      "const SAFE = /[^" + '"' + "]+/;",
      "export async function sweepEverythingAction() {}",
    ].join("\n");
    expect(codeOnly(src)).toContain("export async function sweepEverythingAction");
  });

  it("handles a slash inside a character class, and the flags after the close", () => {
    // `/[^/]+/gi` is ONE literal: the inner slash is inside the class and does
    // not close it. Getting this wrong ends the literal early and reads the rest
    // of it as code — which is how a quote later on the line reopens the bug.
    const src = "const SEG = /[^/]+/gi;\nconst after = " + '"keep me"' + ";";
    expect(codeOnly(src)).toContain("const after =");
    expect(stripComments(src)).toContain("keep me");
  });

  it("handles an escaped slash and an escaped quote inside the literal", () => {
    const src =
      "const P = /" + BS + '/" ' + BS + '"/;' + "\nexport const tail = 1;\n" + 'const s = "x";';
    expect(codeOnly(src)).toContain("export const tail = 1;");
  });

  it("does not mistake a JSX closing tag for a regex", () => {
    // FOUND BY ADVERSARIAL VERIFICATION, in the scanner written to close A49.
    // `<` was in OPERATORS_BEFORE_REGEX (inherited from escape-boundary, which
    // only ever reads files with no JSX), so in `</Tag>` the `/` looked like the
    // start of a regex and skipRegex ran forward to the next slash. Two closing
    // tags on one line swallowed everything between them — comments left
    // unblanked, and for codeOnly string contents left unblanked too.
    //
    // That is the FALSE-NEGATIVE direction for the three guards that read
    // codeOnly: an action name surviving inside a string credits a caller that
    // does not exist, and an unguarded endpoint vanishes from a sweep. Restore
    // `<` to the operator set and this case goes red.
    const src = [
      "const el = (",
      "  <Row><Cell /></Row> // a trailing comment the scanner must still blank",
      ");",
      'const name = "sweepEverythingAction";',
    ].join("\n");

    expect(stripComments(src)).not.toContain("trailing comment");
    // The declaration after the tags is still visible…
    expect(codeOnly(src)).toContain("const name =");
    // …and the STRING after them is still blanked, which is the property a
    // reachability sweep depends on.
    expect(codeOnly(src)).not.toContain("sweepEverythingAction");
  });

  it("still reads a regex after an arrow, which is why `>` stays an operator", () => {
    // The other side of that trade: `=> /re/.test(x)` is ordinary code and the
    // character before the slash is `>`. Removing `>` too would reintroduce A49.
    const src = ['const hits = xs.filter((x) => /"/.test(x));', "const after = 1;"].join("\n");
    expect(codeOnly(src)).toContain("const after =");
  });

  it("treats division as division", () => {
    // The other direction. If an identifier or a number before a slash opened a
    // regex, `a / b` would skip to the next slash and take any quote with it.
    const src = "const r = total / count;\nconst label = " + '"kept"' + ";\n";
    expect(stripComments(src)).toContain('"kept"');
    expect(codeOnly(src)).toContain("const label =");
  });

  it("reads a regex after a keyword, not only after an operator", () => {
    // escape-boundary's scanner stopped at operators and documented this as a
    // known miss. `return /…/` is the common shape it missed, and a quote inside
    // such a literal is the A49 bug again.
    const src = "function ok(v: string) {\n  return /[^" + '"' + "]+/.test(v);\n}\nconst z = 1;\n";
    expect(codeOnly(src)).toContain("const z = 1;");
  });
});

describe("comments (audit A40)", () => {
  it("does not let a line comment that mentions a block opener blank the code below it", () => {
    // The two-regex shape blanked block comments FIRST, over text that still
    // contained line comments, so the opener inside a line comment started a
    // block that closed at the next block terminator. Measured over the real
    // tree: 18 code lines invisible in lib/actions/team.ts, 17 in
    // lib/auth/channel-permissions.ts.
    const src = [
      "const before = 1;",
      "// the opener /* in this sentence never closes on this line",
      'const middle = "ml-4";',
      "const after = 2;",
      "/* and the closer sits down here */",
      "const tail = 3;",
    ].join("\n");
    const stripped = stripComments(src);
    expect(stripped).toContain("const middle =");
    expect(stripped).toContain("const after = 2;");
    expect(stripped).toContain("const tail = 3;");
  });

  it("does not let a block comment that mentions a line opener hide the real closer", () => {
    const src = [
      "/* a block that mentions // and keeps going",
      "   until here */",
      "const x = 1;",
    ].join("\n");
    expect(stripComments(src)).toContain("const x = 1;");
  });

  it("does not treat a comment opener inside a string as a comment", () => {
    const src = 'const path = "/* not a comment */";\nconst after = 1;';
    expect(stripComments(src)).toContain("const after = 1;");
    // ...and the string itself is still there when strings are kept.
    expect(stripComments(src)).toContain("not a comment");
  });

  it("keeps a bare URL intact outside a string literal", () => {
    // A URL can appear outside any string: in a CSS url(), and in JSX text. The
    // two-regex version spelled this carve-out with a lookbehind; losing it
    // would blank the rest of the line every time.
    expect(stripComments("<p>https://founderflow.app/pricing</p>")).toContain("pricing");
    expect(
      stripComments("a { background: url(https://x.test/a.png) no-repeat; }", "css")
    ).toContain("no-repeat");
  });

  it("still blanks a comment that follows a case label", () => {
    // The URL carve-out only covers a colon IMMEDIATELY before the slashes, so
    // an ordinary trailing comment is unaffected.
    expect(stripComments("switch (k) {\n  case 1: // note about ml-4\n}")).not.toContain("ml-4");
  });
});

describe("strings", () => {
  it("codeOnly blanks the contents of a string but stripComments does not", () => {
    // The distinction both guards depend on: a telemetry tag that names an
    // action inside a string must not count as a caller of it, while a
    // `"use server"` directive IS a string and has to survive.
    const src = 'captureServerError(e, { action: "deleteMessageAction" });';
    expect(codeOnly(src)).not.toContain("deleteMessageAction");
    expect(codeOnly(src)).toContain("captureServerError(e, { action:");
    expect(stripComments(src)).toContain("deleteMessageAction");
  });

  it("does not end a string at an escaped quote", () => {
    const src = 'const a = "he said ' + BS + '"hi' + BS + '" to me";\nconst b = 2;';
    expect(codeOnly(src)).toContain("const b = 2;");
  });

  it("blanks a template literal's contents, interpolations included", () => {
    // Stated as known behaviour, not as a good outcome: a call that only ever
    // appears inside an interpolation is invisible to a caller-counting guard.
    // The template-aware scanner lives in tests/lib/email/escape-boundary.test.ts,
    // which needs the interpolations themselves; no caller here does.
    const src = "const html = `<p>${escapeHtml(name)}</p>`;\nconst z = 1;";
    expect(codeOnly(src)).not.toContain("escapeHtml");
    expect(codeOnly(src)).toContain("const z = 1;");
    expect(stripComments(src)).toContain("escapeHtml");
  });

  it("reads an apostrophe in JSX text as a quote, which is a known limit", () => {
    // Pinned so the next reader finds it here rather than in a wrong answer.
    // This is not a parser; every one of the guards that shares it already lived
    // with this, and none of them matches on prose inside an element.
    const src = "<p>It's fine</p>\n<span>done</span>";
    expect(codeOnly(src)).not.toContain("s fine");
  });
});

describe("offsets and line numbers", () => {
  it("preserves length exactly", () => {
    // Several callers slice a function body out by offset. Physically deleting a
    // comment moves every offset after it.
    const src = [
      "/** doc */",
      "// line",
      'const a = "text";',
      "const re = /[^" + '"' + "]/;",
      "`tpl ${x}`;",
    ].join("\n");
    expect(codeOnly(src)).toHaveLength(src.length);
    expect(stripComments(src)).toHaveLength(src.length);
  });

  it("preserves every newline, including inside a blanked block comment", () => {
    const src = "a\n/* one\ntwo\nthree */\nb";
    const stripped = stripComments(src);
    expect(stripped.split("\n")).toHaveLength(src.split("\n").length);
    expect(stripped.split("\n")[4]).toBe("b");
  });

  it("does not run off the end of an unterminated comment or string", () => {
    expect(() => codeOnly("const a = 1; /* never closed")).not.toThrow();
    expect(() => codeOnly('const a = "never closed')).not.toThrow();
    expect(() => codeOnly("const a = /never closed")).not.toThrow();
    expect(codeOnly("const a = 1; /* never closed")).toHaveLength(
      "const a = 1; /* never closed".length
    );
  });
});

describe("the css dialect", () => {
  it("does not read a stylesheet slash as the start of a regex literal", () => {
    // Every one of these is division-or-nothing in CSS. Reading the slash as a
    // regex opener skips to the next slash and takes any comment opener on the
    // way with it.
    const src = [
      ".a { font: 12px/1.5 system-ui; }",
      ".b { width: calc(100% / 3); }",
      ".c { grid-area: 1 / 2; }",
      "/* prose about text-left */",
      ".d { padding-inline-start: 1rem; }",
    ].join("\n");
    const stripped = stripComments(src, "css");
    expect(stripped).toContain("padding-inline-start");
    expect(stripped).not.toContain("text-left");
  });

  it("does not treat // as a comment in css, because css has no line comments", () => {
    // A browser ignores the whole declaration, not the rest of the line, so a
    // guard reading the file must see what the browser sees.
    expect(stripComments("a { color: red; } // b { color: blue; }", "css")).toContain("blue");
  });

  it("picks the dialect from the file name", () => {
    expect(dialectFor("app/globals.css")).toBe("css");
    expect(dialectFor("components/layout/topbar.tsx")).toBe("ts");
    expect(dialectFor("scripts/smoke-auth.mjs")).toBe("ts");
  });
});

// ---------------------------------------------------------------------------
// The sweep: which guards still carry a private copy
// ---------------------------------------------------------------------------

/**
 * Names that mean "I am blanking source before I match on it". A guard that
 * declares one of these locally is a guard whose sensor nobody else's test
 * covers, which is how A40 lived in sixteen files at once.
 */
const SCANNER_NAMES = ["stripComments", "codeOnly", "neutralize"];

/**
 * Guards that still declare their own, keyed by repo-relative path, with the
 * shape of the copy and the reason it has not moved yet.
 *
 * NOT a mute button. `every allowlisted file still declares its own scanner`
 * below fails the moment one is converted, so the entry has to be deleted in the
 * same change — the same mechanism as NOT_YET_CONVERTED in
 * tests/lib/layout/rtl.test.ts, and the reason that allowlist could be emptied
 * rather than forgotten.
 *
 * "block-regex-first" is the A40 shape: a block-comment regex applied to text
 * that still contains line comments. Those are defective today, not merely
 * duplicated. "char-state" copies are correct about comments but, unless noted,
 * still have A49 — no notion of a regex literal.
 *
 * NOT listed here and NOT an offender: tests/lib/email/escape-boundary.test.ts.
 * Its `templateLiterals` extracts template literals WITH their interpolations,
 * which is a different job from blanking them, so it declares none of the three
 * names below and the sweep never sees it. This scanner generalises its
 * character-state core; it does not replace it.
 *
 * Note the semantics trap for anyone clearing an entry: the local `codeOnly`
 * in this family does NOT blank string contents despite the name, so the drop-in
 * replacement is the shared `stripComments`, not the shared `codeOnly`. Swapping
 * in the wrong one blanks every string the guard was matching on and the guard
 * goes quietly green.
 */
const NOT_YET_SHARED = new Map<string, string>([
  [
    "tests/app/loading/skeleton-width.test.ts",
    "block-regex-first (A40) — parses page container width tokens",
  ],
  ["tests/app/reports/reports-period.test.ts", "block-regex-first (A40) — codeOnly family"],
  ["tests/app/shell/skip-link-target.test.tsx", "block-regex-first (A40) — skip-link href parse"],
  [
    "tests/components/auth-forms.test.tsx",
    "block-regex-first (A40), and it REMOVES comments rather than blanking them, so its line numbers already shift",
  ],
  [
    "tests/lib/architecture/decision-reachability.test.ts",
    "char-state, same two-argument neutralize as the three action guards had — A49",
  ],
  ["tests/lib/auth/durable-login-counter.test.ts", "char-state — A49"],
  ["tests/lib/auth/login-throttle.test.ts", "char-state — A49"],
  ["tests/lib/billing/checkout-gate.test.ts", "block-regex-first (A40) — zero-argument codeOnly()"],
  ["tests/lib/billing/webhook-route.test.ts", "block-regex-first (A40) — arrow-function codeOnly"],
  ["tests/lib/comments/mention-roster.test.ts", "char-state — A49"],
  ["tests/lib/cron/live-scope.test.ts", "block-regex-first (A40) — codeOnly family"],
  ["tests/lib/cron/sweep-route.test.ts", "char-state, nested inside a describe — A49"],
  ["tests/lib/db/export-coverage.test.ts", "block-regex-first (A40) — codeOnly family"],
  ["tests/lib/db/purge-invariants.test.ts", "block-regex-first (A40) — codeOnly family"],
  ["tests/lib/i18n/date-locale-reachability.test.ts", "block-regex-first (A40)"],
  ["tests/lib/i18n/document-language.test.ts", "block-regex-first (A40)"],
  ["tests/lib/layout/hover-reveal.test.ts", "block-regex-first (A40)"],
  ["tests/lib/queries/month-boundary.test.ts", "block-regex-first (A40) — codeOnly family"],
  ["tests/lib/time/sweep-reachability.test.ts", "block-regex-first (A40) — codeOnly family"],
]);

function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, found);
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function rel(file: string): string {
  return file
    .slice(ROOT.length + 1)
    .split(sep)
    .join("/");
}

/** A local declaration of a scanner, in any of the forms this suite uses. */
function declaresOwnScanner(source: string): string[] {
  // The source is read through the shared scanner so that this very file's
  // prose — which names all three functions repeatedly — cannot count as a
  // declaration. Without it the sweep reports itself.
  const code = stripComments(source);
  return SCANNER_NAMES.filter((name) => {
    const decl = new RegExp("(?:function|const|let)\\s+" + name + "\\s*[(=:]");
    return decl.test(code);
  });
}

describe("no guard keeps a private source scanner (audit A40 + A49)", () => {
  const files = testFiles(TESTS_DIR);

  it("indexed the whole suite, so an empty walk cannot read as clean", () => {
    // Guard-the-guard. Every assertion below is "the offender list is empty",
    // which a broken walk satisfies perfectly.
    expect(files.length).toBeGreaterThan(150);
    expect(files.map(rel)).toContain("tests/lib/layout/rtl.test.ts");
  });

  it("reports every unlisted file that declares one", () => {
    const offenders: string[] = [];
    files.forEach((file) => {
      const r = rel(file);
      if (NOT_YET_SHARED.has(r)) return;
      const names = declaresOwnScanner(readFileSync(file, "utf8"));
      if (names.length > 0) offenders.push(`${r} declares ${names.join(", ")}`);
    });

    expect(
      offenders,
      "These declare their own comment/string scanner instead of importing " +
        "tests/lib/harness/source-scan.ts. Two silent-failure bugs (A40, A49) " +
        "lived in copies of it; a copy is how the third will:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every allowlisted file still declares its own scanner", () => {
    // Staleness guard: a converted or deleted file fails here until its entry
    // goes, so the allowlist cannot outlive its reason.
    const stale: string[] = [];
    Array.from(NOT_YET_SHARED.entries()).forEach(([r, reason]) => {
      const file = join(ROOT, r.split("/").join(sep));
      let source = "";
      try {
        source = readFileSync(file, "utf8");
      } catch {
        stale.push(`${r} is gone (listed as: ${reason})`);
        return;
      }
      if (declaresOwnScanner(source).length === 0) {
        stale.push(`${r} no longer declares one (listed as: ${reason})`);
      }
    });

    expect(
      stale,
      "Delete these from NOT_YET_SHARED — an excuse that outlives its reason is " +
        "how the next one gets waved through:\n" +
        stale.join("\n")
    ).toEqual([]);
  });

  it("the guards already converted read their sources through tests/lib/harness/", () => {
    // The positive half. A sweep that only counts absences would be satisfied by
    // a guard that deleted its scanner and stopped stripping comments at all.
    //
    // Either shared module counts: action-auth-gates.test.ts imports
    // `gate-graph`, which builds its universe with `codeOnly`/`stripComments`, so
    // it reads through this scanner without naming it.
    const converted = [
      "tests/lib/actions/reachability.test.ts",
      "tests/lib/actions/action-auth-gates.test.ts",
      "tests/lib/actions/use-server-exports.test.ts",
      "tests/lib/layout/rtl.test.ts",
      "tests/lib/db/script-safety.test.ts",
      "tests/ops/page-auth.test.ts",
      "tests/ops/smoke-hygiene.test.ts",
    ];
    converted.forEach((r) => {
      const source = readFileSync(join(ROOT, r.split("/").join(sep)), "utf8");
      expect(source, `${r} no longer imports from tests/lib/harness/`).toMatch(
        /from "(?:\.\.\/)+(?:lib\/)?harness\/(?:source-scan|gate-graph)"/
      );
    });
  });
});

/*
 * CRLF, fed in DIRECTLY rather than read off disk.
 *
 * .gitattributes now pins the working tree to LF, which is the real fix for the
 * 2026-10-05 incident: with CRLF, `tests/ops/backup-workflow.test.ts` tried to
 * fold the pg_dump continuation on a backslash-newline, matched nothing, and
 * reported that the dump passes no `--schema` filter about a file carrying
 * `--schema=public` on the next line. Green on Linux CI, red on a Windows
 * checkout of the same commit — the worst shape a guard can have, because the
 * verdict depends on how the file was written rather than on what it says.
 *
 * These cases exist so that this scanner's own tolerance is tested INDEPENDENTLY
 * of that file. Reading a fixture off disk would be normalised by .gitattributes
 * before the scanner ever saw it, so the assertion would pass whether or not
 * `normalizeEol` existed — a green test over an untested defence, which is this
 * repo's single most recurrent defect. Building the CRLF in memory is the only
 * way to discriminate between the two fixes.
 */
describe("the scanner tolerates CRLF, independently of .gitattributes", () => {
  it("normalizeEol converts CRLF and lone CR, and leaves LF alone", () => {
    expect(normalizeEol("a\r\nb")).toBe("a\nb");
    expect(normalizeEol("a\rb")).toBe("a\nb");
    expect(normalizeEol("a\nb")).toBe("a\nb");
  });

  it("blanks a line comment that ends in CRLF, rather than running past it", () => {
    // Built in memory: with a \r before the newline, a scanner that ends a line
    // comment on "\n" only would still terminate here — but one that MEASURES
    // the line would carry the \r into the next token. The real failure this
    // guards is the caller's: `stripComments` must hand back LF so the caller's
    // own /\n/ anchors work.
    const out = stripComments("const a = 1; // note\r\nconst b = 2;\r\n");
    expect(out).toContain("const b = 2;");
    expect(out, "stripComments handed back a \\r, so the caller's \\n anchors miss").not.toContain(
      "\r"
    );
  });

  it("folds a shell-style continuation after CRLF — the exact 2026-10-05 failure", () => {
    // This is backup-workflow's `dumpInvocation` reduced to its essence: fold
    // backslash-newline, then read the command. With CRLF and no normalisation
    // the fold misses and the flags vanish.
    const crlf = '"$PG_DUMP" "$URL" \\\r\n  --schema=public \\\r\n  --no-owner\r\n';
    const folded = normalizeEol(crlf).replace(/\\\n\s*/g, " ");
    expect(folded, "the continuation did not fold, so every flag is invisible").toContain(
      "--schema=public"
    );
  });

  it("codeOnly still blanks string contents when the source is CRLF", () => {
    const out = codeOnly('const s = "secretName";\r\nfoo();\r\n');
    expect(out).toContain("foo()");
    expect(out, "a CRLF source slipped a string's contents past codeOnly").not.toContain(
      "secretName"
    );
  });

  it("dialectFor is unaffected by line endings, since it reads a path", () => {
    expect(dialectFor("a/b.css")).toBe("css");
    expect(dialectFor("a/b.tsx")).toBe("ts");
  });
});
