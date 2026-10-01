/**
 * ONE source scanner for every structural guard in this suite.
 *
 * WHY THIS FILE EXISTS. Ten guards had grown their own copy of "blank the
 * comments before you grep", and two distinct defects were living in those
 * copies. Both had the same consequence — a guard that silently stops reading
 * part of the file it is guarding — and both were found by an agent losing an
 * hour to a wrong answer rather than by review:
 *
 *   A49. The `neutralize()` in tests/lib/actions/{reachability,
 *        action-auth-gates,use-server-exports} had no notion of a regex
 *        literal, so the double quote in a character class such as
 *        `[^ <>"@]` opened a string literal and blanked every character to the
 *        next quote — to end of file, if there was no next quote. Measured:
 *        `app/verify-email-change/page.tsx` shape-checked an address that way
 *        and `reachability` reported `confirmEmailChangeAction` as an endpoint
 *        with no caller while the call sat a few lines below the regex. The
 *        dangerous direction is the other one: in `action-auth-gates` a blanked
 *        region swallows an `export async function` declaration, and an UNGATED
 *        endpoint then passes the sweep.
 *
 *   A40. The two-regex `stripComments` — blank block comments, then blank line
 *        comments — ran the block pattern over text that still contained line
 *        comments, so a line comment that happened to contain a block-comment
 *        OPENER started a block the pattern closed at the next block-comment
 *        closer.
 *
 *        MEASURED, and the earlier figure quoted here was wrong in a way worth
 *        recording. It claimed "18 code lines invisible in lib/actions/team.ts
 *        and 17 in lib/auth/channel-permissions.ts". Only the second file is
 *        affected at all: the line comment at lib/auth/channel-permissions.ts:98
 *        contains `lib/queries/**`, the next block-comment closer is at :115, so the old
 *        stripper blanked :98-:115 — eighteen lines, SIX of them real code, and
 *        those six are `visibleChannelWhere`'s `return { companyId, OR: [...] }`,
 *        i.e. the channel-visibility predicate itself. In lib/actions/team.ts the
 *        only unpaired opener is `/invite/*` in the line comment at :981 and
 *        there is no block-comment closer ANYWHERE after it, so the lazy pattern never matched
 *        and nothing was blanked. The wrong number came from a report and was
 *        propagated into FaultsAudit A40 and two comments before an adversarial
 *        verifier checked it against the tree.
 *
 * Both are the same root cause: comments, strings and regex literals can only
 * be told apart by reading the file left to right, once, carrying state. Any
 * pair of independent regexes gets at least one of the three wrong.
 *
 * A NOTE ON WHY THIS IS NOT A `*.test.ts` FILE. Importing a helper out of
 * another test file re-registers that file's `describe` blocks inside the
 * importer: the suite would run action-auth-gates twice and report its failures
 * against whatever imported it. `vitest.config.ts` collects only
 * `tests/**` files ending `.test.ts`/`.test.tsx`, so a plain `.ts` module here
 * is shared code and not a second suite. That is what made nine copies look
 * like the lesser evil; it was never a reason to copy the scanner, only a
 * reason not to import it from a test.
 *
 * WHAT THIS DOES NOT DO, stated so the next reader does not assume it:
 *
 *   - It is not a parser. JSX text is not distinguished from code, so an
 *     apostrophe in a sentence rendered as JSX still reads as a string quote.
 *     Every caller here already lived with that, and source-scan.test.ts pins
 *     it as known behaviour rather than leaving it to be rediscovered.
 *   - `codeOnly` blanks the CONTENTS of a template literal, including any
 *     interpolation inside it. A call that only ever appears inside an
 *     interpolation is invisible to a caller-counting guard. That was true of
 *     all nine copies too; the template-aware scanner that does handle it lives
 *     in tests/lib/email/escape-boundary.test.ts, which needs the
 *     interpolations themselves.
 *
 * Both functions preserve the length of the input and every newline in it, so
 * an offset or a line number taken from the result still points at the same
 * place in the original. Several callers slice function bodies out by offset;
 * physically deleting a comment would move all of them.
 */

const BACKSLASH = String.fromCharCode(92);

/**
 * `"ts"` for TypeScript/TSX (line comments, template literals, regex
 * literals); `"css"` for stylesheets, which have block comments and strings and
 * none of the other three. The distinction is load-bearing: `app/globals.css`
 * is scanned by the RTL guard, and CSS is full of `/` characters that are
 * division-or-nothing (`font: 12px/1.5`, `calc(100% / 3)`, `grid-area: 1 / 2`).
 * Reading one of those as the start of a regex literal skips real text.
 */
export type Dialect = "ts" | "css";

/** Identifier characters, for reading the word before a `/` back out. */
const IDENT = /[A-Za-z0-9_$]/;

/**
 * After one of these, a `/` opens a regex literal rather than dividing. Taken
 * from the scanner in tests/lib/email/escape-boundary.test.ts, which this one
 * generalises.
 */
const OPERATORS_BEFORE_REGEX = "(,=:[!&|?{};+-*%~^>";

/*
 * `<` IS DELIBERATELY NOT IN THAT SET, and leaving it in was a live false
 * negative in the three guards that read `codeOnly`.
 *
 * escape-boundary's original had it, harmlessly — that scanner only ever reads
 * lib/email/** and lib/actions/*.ts, which contain no JSX. Generalised to .tsx
 * it is a hole: in `</Tag>` the `/` is preceded by `<`, so it satisfied
 * `regexCanStart`, and `skipRegex` then ran forward to the next unescaped slash
 * outside a character class. Two closing tags on one line — or a closing tag and
 * a self-closing one — therefore SKIPPED everything between them, so comments in
 * that span were never blanked and, for `codeOnly`, neither were string
 * contents. That is the dangerous direction for reachability,
 * action-auth-gates and use-server-exports: an action name surviving inside an
 * unblanked string credits a caller that does not exist, and an endpoint
 * vanishing from a sweep passes it.
 *
 * `>` STAYS, because `=> /re/.test(x)` in a filter callback is ordinary code and
 * the character before that `/` is `>`. Nothing legitimate puts a regex
 * immediately after `<`: `a < /re/.test(b)` is legal JavaScript and absurd, and
 * trading it for a JSX false negative in a security guard is the wrong way
 * round. Pinned by "does not mistake a JSX closing tag for a regex" below.
 */

/**
 * ...and after one of these words. escape-boundary's version stopped at
 * operators and documented `return` followed by a literal as a known miss;
 * naming the keywords closes it, and `treats division as division` in the tests
 * pins the other direction (an identifier or a number before `/` is still
 * division).
 */
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
  "throw",
]);

function regexCanStart(prev: string, prevWord: string): boolean {
  if (prev === "") return true; // start of file
  if (IDENT.test(prev)) return KEYWORDS_BEFORE_REGEX.has(prevWord);
  return OPERATORS_BEFORE_REGEX.indexOf(prev) >= 0;
}

/**
 * Index just past the regex literal whose opening `/` is at `at`. A `/` inside
 * a character class does not close it — one literal can contain a slash that
 * way — and neither does an escaped one.
 *
 * An unterminated literal (a newline first) returns the newline's index, which
 * means "this was division after all": the characters are skipped rather than
 * blanked, so nothing is lost from the output either way.
 */
function skipRegex(src: string, at: number): number {
  const n = src.length;
  let i = at + 1;
  let inClass = false;
  while (i < n) {
    const c = src[i];
    if (c === BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === "\n") return i;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i += 1;
      break;
    }
    i += 1;
  }
  while (i < n && /[a-z]/.test(src[i])) i += 1; // flags
  return i;
}

function scan(src: string, keepStrings: boolean, dialect: Dialect): string {
  const out = src.split("");
  const n = src.length;
  const ts = dialect === "ts";
  let i = 0;
  /** Last significant (non-whitespace, non-comment) code character. */
  let prev = "";
  /** ...and, when that character is an identifier character, its whole word. */
  let prevWord = "";

  /** Blank [from, to), leaving newlines so line numbering survives. */
  function blank(from: number, to: number): void {
    for (let k = from; k < to && k < n; k += 1) {
      if (src[k] !== "\n") out[k] = " ";
    }
  }

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // Comments FIRST, both kinds, before the regex check — otherwise the `;`
    // ending a statement makes the slash of the doc comment below it look like
    // the start of a regex literal.
    //
    // `src[i - 1] !== ":"` keeps a bare `https://…` intact. It is the same
    // carve-out the two-regex version spelled with a lookbehind, and it matters
    // because a URL can appear outside a string literal: in a CSS `url(...)`,
    // and in JSX text. A `case` label followed by a comment has a space before
    // the slashes, so that is still read as a comment.
    if (ts && c === "/" && c2 === "/" && src[i - 1] !== ":") {
      const start = i;
      while (i < n && src[i] !== "\n") i += 1;
      blank(start, i);
      continue;
    }
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      blank(start, i);
      continue;
    }

    if (c === '"' || c === "'" || (ts && c === "`")) {
      const quote = c;
      const contentStart = i + 1;
      i += 1;
      while (i < n) {
        if (src[i] === BACKSLASH) {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i += 1;
      }
      if (!keepStrings) blank(contentStart, Math.min(i, n));
      i += 1; // past the closing quote (or past the end, if unterminated)
      prev = quote;
      prevWord = "";
      continue;
    }

    if (ts && c === "/" && regexCanStart(prev, prevWord)) {
      i = skipRegex(src, i);
      prev = "/";
      prevWord = "";
      continue;
    }

    if (IDENT.test(c)) {
      const start = i;
      while (i < n && IDENT.test(src[i])) i += 1;
      prevWord = src.slice(start, i);
      prev = src[i - 1];
      continue;
    }

    if (!/\s/.test(c)) {
      prev = c;
      prevWord = "";
    }
    i += 1;
  }

  return out.join("");
}

/**
 * Comments blanked, string literals left intact. Use this when the thing being
 * looked for IS a string — a `"use server"` directive, an `import` specifier, a
 * `className` — or when only the prose needs to go.
 */
export function stripComments(src: string, dialect: Dialect = "ts"): string {
  return scan(src, true, dialect);
}

/**
 * Comments blanked AND the contents of every string literal blanked, so what is
 * left is code and nothing else. Use this when looking for a declaration or a
 * call: a telemetry tag that names an action inside a string must not count as
 * a caller of it.
 */
export function codeOnly(src: string, dialect: Dialect = "ts"): string {
  return scan(src, false, dialect);
}

/** `"css"` for a stylesheet, `"ts"` for everything else this suite scans. */
export function dialectFor(pathOrName: string): Dialect {
  return /\.css$/i.test(pathOrName) ? "css" : "ts";
}
