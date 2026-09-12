// server/nightlyExport.test.ts
import { describe, it, expect } from "vitest";
import { generateCsvExport } from "./nightlyExport";

describe("generateCsvExport", () => {
  it("renders rows as CSV with a header row matching the first row's keys", () => {
    const rows = [
      { id: 1, sku: "JELLO-CAL-500", status: "active" },
      { id: 2, sku: "JELLO-MIX-250", status: "inactive" },
    ];
    const csv = generateCsvExport(rows);
    expect(csv).toBe(
      "id,sku,status\n1,JELLO-CAL-500,active\n2,JELLO-MIX-250,inactive",
    );
  });

  it("quotes a field that contains a comma", () => {
    const csv = generateCsvExport([{ id: 1, notes: "delayed, per artwork" }]);
    expect(csv).toBe('id,notes\n1,"delayed, per artwork"');
  });

  it("returns just a header-less empty string for an empty table", () => {
    expect(generateCsvExport([])).toBe("");
  });
});
