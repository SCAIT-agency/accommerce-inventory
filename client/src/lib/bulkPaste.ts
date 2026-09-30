export interface BulkPasteColumn<T> {
  key: keyof T;
  label: string;
  parse: (raw: string) => { ok: true; value: T[keyof T] } | { ok: false; error: string };
}

export interface BulkPasteRow<T> {
  raw: string[];
  values: Partial<T>;
  errors: Partial<Record<keyof T, string>>;
  isValid: boolean;
}

export function parseBulkPaste<T>(text: string, columns: BulkPasteColumn<T>[]): BulkPasteRow<T>[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    const raw = line.split("\t");
    const values: Partial<T> = {};
    const errors: Partial<Record<keyof T, string>> = {};

    if (raw.length !== columns.length) {
      // Every column gets the same error so the whole row renders as invalid
      // in a preview table keyed by column, not just the first cell.
      for (const col of columns) {
        errors[col.key] = `expected ${columns.length} columns, got ${raw.length}`;
      }
      return { raw, values, errors, isValid: false };
    }

    columns.forEach((col, i) => {
      const result = col.parse(raw[i]);
      if (result.ok) {
        values[col.key] = result.value;
      } else {
        errors[col.key] = result.error;
      }
    });

    return { raw, values, errors, isValid: Object.keys(errors).length === 0 };
  });
}
