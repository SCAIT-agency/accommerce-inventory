import { describe, it, expect } from "vitest";
import { transformSheetExport, reconcileMigration } from "./migrate-from-sheet";

describe("transformSheetExport", () => {
  it("maps a Control Tower Inventory Ledger row into a normalized ledger event, keyed by SKU code and warehouse code", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" },
    ];
    const result = transformSheetExport(rows);
    expect(result.ledgerEvents).toEqual([
      { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", eventType: "receipt", qty: 1000, unitCost: 0.42, date: new Date("2026-06-16"), sourceRef: "PO1-W1" },
    ]);
  });
});

describe("reconcileMigration", () => {
  it("passes when migrated SOH matches the Sheet's totals for every SKU/warehouse", () => {
    const result = reconcileMigration(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150827 },
    );
    return expect(result).resolves.toEqual({ passed: true, mismatches: [] });
  });

  it("fails and lists the mismatch when migrated SOH diverges from the Sheet", () => {
    const result = reconcileMigration(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150000 },
    );
    return expect(result).resolves.toEqual({
      passed: false,
      mismatches: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", expected: 150827, actual: 150000, diff: -827 }],
    });
  });

  it("lists every mismatch, not just the first, when multiple SKU/warehouse totals diverge", () => {
    const result = reconcileMigration(
      [
        { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 },
        { sku: "JELLO-CAL-500", warehouseCode: "MUTUAL-CH", sohFromSheet: 4200 },
        { sku: "JELLO-MAG-250", warehouseCode: "FF-DE", sohFromSheet: 900 },
      ],
      {
        getMigratedSoh: async (sku, warehouseCode) => {
          if (sku === "JELLO-CAL-500" && warehouseCode === "FF-DE") return 150000;
          if (sku === "JELLO-CAL-500" && warehouseCode === "MUTUAL-CH") return 4200;
          if (sku === "JELLO-MAG-250" && warehouseCode === "FF-DE") return 800;
          throw new Error("unexpected sku/warehouse");
        },
      },
    );
    return expect(result).resolves.toEqual({
      passed: false,
      mismatches: [
        { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", expected: 150827, actual: 150000, diff: -827 },
        { sku: "JELLO-MAG-250", warehouseCode: "FF-DE", expected: 900, actual: 800, diff: -100 },
      ],
    });
  });
});
