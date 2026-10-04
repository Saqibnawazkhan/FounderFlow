/**
 * Minimal CSV parser for the transaction importer (F2). Handles the subset
 * of RFC 4180 that spreadsheet exports actually produce: quoted fields,
 * escaped quotes (`""`), embedded commas/newlines inside quotes, and CRLF or
 * LF line endings. Blank lines are dropped. Not a general CSV library — just
 * enough to read an export reliably.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  // Flush the trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop entirely-blank lines (e.g. a trailing newline or spacer rows).
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/**
 * Matching a spreadsheet's header against the names we expect
 * (transactions-ledger-014).
 *
 * This used to be one line — the first header, in header order, that CONTAINS
 * any candidate anywhere in it:
 *
 *     headers.findIndex((h) => candidates.some((c) => h.includes(c)))
 *
 * A substring scan with no preference for a header that is actually named what
 * we are looking for, which picks the wrong column whenever a file carries both:
 *
 *     date,subtotal,amount        amount candidates include "total", and
 *                                 "subtotal" comes first → the SUBTOTAL won
 *     date,allocation,category    category candidates include "cat", and
 *                                 "allocation" contains it → the ALLOCATION won
 *
 * Neither produces an error of any kind, and the importer's preview rendered the
 * wrong column's values exactly as confidently as the right one's. So ranking is
 * the first half of the fix and REPORTING the choice is the second: `detectColumn`
 * returns how well it matched and which other columns matched just as well, so
 * the caller can show the mapping and let the customer re-point it. The
 * substring tier is kept rather than dropped — "Amount (PKR)" and "Grand Total"
 * are real exports — it just no longer outranks a column named "amount".
 */

/** How a header matched a candidate name, best first. `substring` is the weak
 *  and dangerous one: "subtotal" contains "total", "allocation" contains "cat". */
export type ColumnMatchQuality = "exact" | "prefix" | "substring" | "none";

/** Index order matters: it is the tier ranking. */
const QUALITY_BY_TIER = ["exact", "prefix", "substring"] as const;

export type ColumnMatch = {
  /** The header we settled on, or -1 when nothing matched at all. */
  index: number;
  quality: ColumnMatchQuality;
  /**
   * Other headers that matched at the SAME tier — the columns we rejected on a
   * tiebreak rather than on evidence. Empty when the winner was decisive. A
   * caller showing a mapping should name these, because this is the state in
   * which a silent pick is a coin toss over somebody's money.
   */
  rivals: number[];
};

type HeaderScore = { tier: number; candidate: number };

/** The best (lowest) tier this header reaches, and the earliest candidate that
 *  got it there. `null` when the header matches nothing. */
function scoreHeader(header: string, candidates: string[]): HeaderScore | null {
  let best: HeaderScore | null = null;
  for (let c = 0; c < candidates.length; c++) {
    const name = candidates[c];
    // An empty candidate would otherwise match every header via `includes("")`
    // and claim column 0 whatever the file holds.
    if (!name) continue;
    const tier = header === name ? 0 : header.startsWith(name) ? 1 : header.includes(name) ? 2 : -1;
    if (tier < 0) continue;
    if (!best || tier < best.tier) best = { tier, candidate: c };
  }
  return best;
}

/**
 * Pick the header for one field. Ranked by match quality first, then by
 * candidate order (the lists are written most-canonical-first, so "amount"
 * outranks "cost"), then by the column's position in the file.
 *
 * `headers` are expected already lowercased/trimmed.
 */
export function detectColumn(headers: string[], candidates: string[]): ColumnMatch {
  const scores = headers.map((h) => scoreHeader(h, candidates));

  let index = -1;
  let best: HeaderScore | null = null;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!s) continue;
    const better =
      !best || s.tier < best.tier || (s.tier === best.tier && s.candidate < best.candidate);
    if (better) {
      best = s;
      index = i;
    }
  }
  if (!best) return { index: -1, quality: "none", rivals: [] };

  const rivals: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (i !== index && s && s.tier === best.tier) rivals.push(i);
  }
  return { index, quality: QUALITY_BY_TIER[best.tier], rivals };
}

/** `detectColumn`'s index alone, for callers that only need the column.
 *  Returns -1 if nothing matched. */
export function findColumn(headers: string[], candidates: string[]): number {
  return detectColumn(headers, candidates).index;
}
