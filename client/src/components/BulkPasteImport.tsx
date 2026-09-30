import { useState } from "react";
import { parseBulkPaste, type BulkPasteColumn, type BulkPasteRow } from "../lib/bulkPaste";

export function BulkPasteImport<T>({
  columns,
  onSubmit,
  onImported,
}: {
  columns: BulkPasteColumn<T>[];
  onSubmit: (rows: T[]) => Promise<({ index: number; ok: true } | { index: number; ok: false; error: string })[]>;
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BulkPasteRow<T>[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ okCount: number; total: number } | null>(null);

  const handleParse = () => setRows(parseBulkPaste(text, columns));

  const validRows = rows.filter((r) => r.isValid);
  const canSubmit = rows.length > 0 && validRows.length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const outcomes = await onSubmit(validRows.map((r) => r.values as T));
      const okCount = outcomes.filter((o) => o.ok).length;
      setResult({ okCount, total: outcomes.length });
      if (okCount > 0) {
        setText("");
        setRows([]);
        onImported();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p>
        Paste rows copied from Excel/Sheets — expected columns, in order: {columns.map((c) => c.label).join(" · ")}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ width: "100%", fontFamily: "monospace" }}
      />
      <button onClick={handleParse} disabled={text.trim().length === 0}>
        Preview
      </button>
      {rows.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                {columns.map((c) => <th key={String(c.key)}>{c.label}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ background: row.isValid ? undefined : "var(--critical-soft)" }}>
                  {columns.map((c) => (
                    <td key={String(c.key)}>
                      {row.raw[columns.indexOf(c)] ?? ""}
                      {row.errors[c.key] && <div style={{ color: "var(--critical)" }}>{row.errors[c.key]}</div>}
                    </td>
                  ))}
                  <td>{row.isValid ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={!canSubmit} onClick={handleSubmit}>
            Record {validRows.length} row{validRows.length === 1 ? "" : "s"}
          </button>
          {result && (
            <p>Recorded {result.okCount} of {result.total}.</p>
          )}
        </>
      )}
    </div>
  );
}
