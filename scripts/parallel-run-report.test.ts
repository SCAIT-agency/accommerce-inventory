import { describe, it, expect } from "vitest";
import { generateParallelRunReport } from "./parallel-run-report";

describe("generateParallelRunReport", () => {
  it("flags any SKU/warehouse still diverging as not yet safe to cut over", async () => {
    const report = await generateParallelRunReport(
      [
        { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 },
        { sku: "JELLO-CAL-500", warehouseCode: "MUTUAL-CH", sohFromSheet: 7395 },
      ],
      { getMigratedSoh: async (_sku, wh) => (wh === "FF-DE" ? 150827 : 7000) },
    );
    expect(report.safeToCutOver).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].warehouseCode).toBe("MUTUAL-CH");
  });

  it("declares safe-to-cut-over only when every SKU/warehouse matches", async () => {
    const report = await generateParallelRunReport(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150827 },
    );
    expect(report.safeToCutOver).toBe(true);
  });

  it("throws when sheetSnapshot is empty to prevent false-positive safe-to-cut-over on unvalidated comparison", async () => {
    const promise = generateParallelRunReport(
      [],
      { getMigratedSoh: async () => 0 },
    );
    await expect(promise).rejects.toThrow("sheetSnapshot is empty");
  });
});
