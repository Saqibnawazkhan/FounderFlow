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

/** Find the first header column whose name contains any of `candidates`
 *  (headers are expected already lowercased/trimmed). Returns -1 if none. */
export function findColumn(headers: string[], candidates: string[]): number {
  return headers.findIndex((h) => candidates.some((c) => h.includes(c)));
}
