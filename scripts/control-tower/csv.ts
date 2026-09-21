// RFC-4180 CSV parsing plus the value normalizers every Control Tower tab
// needs. gviz's CSV export quotes every cell and formats numbers the way the
// Sheet displays them ("50,040", "3,534.78"), so parsing and normalizing are
// kept together here as the single boundary between "text from Google" and
// "typed values the exporter reasons about".

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Same strict shape the migration transforms already enforce
// (scripts/migrate-from-sheet.ts DECIMAL_PATTERN) — a value that passes here
// is guaranteed to pass there, so no row can be quarantined for formatting
// the exporter itself introduced.
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

export function normalizeNumber(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  const cleaned = s.replace(/,/g, "");
  if (!NUMBER_PATTERN.test(cleaned)) throw new Error(`not a number: "${raw}"`);
  return cleaned;
}

export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`not an ISO date: "${raw}"`);
  return s;
}

export function normalizeBool(raw: string): boolean {
  return raw.trim().toUpperCase() === "TRUE";
}
