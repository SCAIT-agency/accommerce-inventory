import { useMemo, useState } from "react";
import { parseBulkPaste, type BulkPasteColumn } from "../lib/bulkPaste";

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
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ okCount: number; total: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Keyed by index into `rows` (not `validRows`) so each failed row's message
  // lands back on the row the user actually sees in the preview table.
  const [rowServerErrors, setRowServerErrors] = useState<Record<number, string>>({});

  // Always re-derived from the current textarea content, so a paste fixed up
  // after a Preview can never be submitted stale.
  const rows = useMemo(() => parseBulkPaste(text, columns), [text, columns]);

  const validRowsWithIndex = rows.map((row, index) => ({ row, index })).filter((r) => r.row.isValid);
  const validRows = validRowsWithIndex.map((r) => r.row);
  const canSubmit = rows.length > 0 && validRows.length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    setRowServerErrors({});
    try {
      const outcomes = await onSubmit(validRows.map((r) => r.values as T));
      const okCount = outcomes.filter((o) => o.ok).length;
      setResult({ okCount, total: outcomes.length });

      const newRowServerErrors: Record<number, string> = {};
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          const original = validRowsWithIndex[outcome.index];
          if (original) newRowServerErrors[original.index] = outcome.error;
        }
      }
      setRowServerErrors(newRowServerErrors);

      if (okCount > 0) {
        onImported();
      }
      // Only clear the input on full success — a partial failure leaves the
      // text and preview in place so the user can see/fix/retry the rows
      // that didn't make it (e.g. a unique-constraint clash on re-import).
      if (okCount === outcomes.length) {
        setText("");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
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
        onChange={(e) => {
          setText(e.target.value);
          // Previous submit feedback is tied to the rows as they stood at
          // submit time — once the text changes, those row positions may no
          // longer mean the same thing, so drop it rather than show stale info.
          setResult(null);
          setSubmitError(null);
          setRowServerErrors({});
        }}
        rows={6}
        style={{ width: "100%", fontFamily: "monospace" }}
      />
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
                  <td>
                    {row.isValid ? "✓" : "✗"}
                    {rowServerErrors[i] && <div style={{ color: "var(--critical)" }}>{rowServerErrors[i]}</div>}
                  </td>
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
          {submitError && <div style={{ color: "var(--critical)" }}>Failed to record: {submitError}</div>}
        </>
      )}
    </div>
  );
}
