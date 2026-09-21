// Read one tab of a link-shared Google Sheet through the gviz JSON endpoint.
//
// JSON, not CSV, on purpose: the CSV export returns cells *formatted* the way
// the Sheet displays them (a landed cost of 2.0259266586730615 arrives as
// "2.0259"), and the reconciliation needs the Sheet's own full-precision
// numbers — a 4-dp cost is off by 4-6 cents per day of COGS. The JSON body
// carries the raw value `v` next to the formatted `f`.
//
// No auth: the Sheet is shared "Anyone with the link — Viewer". If sharing is
// ever revoked Google answers 200 with an HTML sign-in page, so the body is
// checked, not just the status.

export function gvizUrl(sheetId: string, title: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(title)}`;
}

interface GvizCell {
  v: string | number | boolean | null;
  f?: string;
}
interface GvizTable {
  cols: { label: string; type: string }[];
  rows: { c: (GvizCell | null)[] }[];
}

const DATE_LITERAL = /^Date\((\d+),(\d+),(\d+)(?:,.*)?\)$/;

/**
 * Canonical cell text: what a human would type into the platform. Numbers keep
 * full precision (JS shortest round-trip repr), dates become YYYY-MM-DD,
 * booleans TRUE/FALSE, blanks "". Everything downstream parses these strings
 * through the same normalizers the CSV fixtures go through.
 */
export function canonicalCell(cell: GvizCell | null, type: string): string {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  const v = cell.v;
  if (type === "boolean") return v ? "TRUE" : "FALSE";
  if (type === "date" || type === "datetime") {
    const m = typeof v === "string" ? DATE_LITERAL.exec(v) : null;
    if (!m) throw new Error(`unexpected date cell value ${JSON.stringify(v)}`);
    const [y, m0, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  if (type === "number") return typeof v === "number" ? String(v) : String(v);
  return String(v);
}

/** Parse the `google.visualization.Query.setResponse({...})` wrapper into header + rows of canonical strings. */
export function gvizJsonToRows(body: string, title: string): string[][] {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`gviz "${title}": no JSON object in body`);
  const parsed = JSON.parse(body.slice(start, end + 1)) as { status: string; errors?: { message: string }[]; table?: GvizTable };
  if (parsed.status !== "ok" || !parsed.table) {
    throw new Error(`gviz "${title}": status ${parsed.status} ${parsed.errors?.map((e) => e.message).join("; ") ?? ""}`);
  }
  const { cols, rows } = parsed.table;
  const types = cols.map((c) => c.type);
  const data = rows.map((r) => r.c.map((cell, i) => canonicalCell(cell, types[i])));
  // gviz treats the first row as a header only when it can; otherwise labels
  // are blank and the header sits in the first data row.
  const labelled = cols.some((c) => c.label !== "");
  const header = labelled ? cols.map((c) => c.label) : (data.shift() ?? []);
  return [header, ...data];
}

export async function fetchTabRows(sheetId: string, title: string): Promise<string[][]> {
  const res = await fetch(gvizUrl(sheetId, title));
  if (res.status !== 200) throw new Error(`gviz "${title}": HTTP ${res.status}`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(`gviz "${title}": got an HTML body instead of JSON — is the Sheet still link-shared?`);
  }
  return gvizJsonToRows(text, title);
}

export function liveTabFetcher(sheetId: string): (title: string) => Promise<string[][]> {
  return (title) => fetchTabRows(sheetId, title);
}
