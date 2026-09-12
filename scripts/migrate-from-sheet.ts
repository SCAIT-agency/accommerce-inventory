export interface SheetExportRow {
  sku: string;
  warehouse: string;
  event_type: string;
  qty: string;
  unit_cost: string;
  date: string;
  source_ref: string;
}

export interface TransformedLedgerEvent {
  sku: string;
  warehouseCode: string;
  eventType: "receipt" | "sale" | "adjustment";
  qty: number;
  unitCost: number;
  date: Date;
  sourceRef: string;
}

export interface TransformedMigrationData {
  ledgerEvents: TransformedLedgerEvent[];
}

export function transformSheetExport(rows: SheetExportRow[]): TransformedMigrationData {
  return {
    ledgerEvents: rows.map((r) => ({
      sku: r.sku,
      warehouseCode: r.warehouse,
      eventType: r.event_type as "receipt" | "sale" | "adjustment",
      qty: parseFloat(r.qty),
      unitCost: parseFloat(r.unit_cost),
      date: new Date(r.date),
      sourceRef: r.source_ref,
    })),
  };
}

export interface SkuWarehouseTotal {
  sku: string;
  warehouseCode: string;
  sohFromSheet: number;
}

export interface ReconciliationDeps {
  getMigratedSoh: (sku: string, warehouseCode: string) => Promise<number>;
}

export interface Mismatch {
  sku: string;
  warehouseCode: string;
  expected: number;
  actual: number;
  diff: number;
}

export async function reconcileMigration(
  sheetTotals: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
): Promise<{ passed: boolean; mismatches: Mismatch[] }> {
  const mismatches: Mismatch[] = [];
  for (const total of sheetTotals) {
    const actual = await deps.getMigratedSoh(total.sku, total.warehouseCode);
    if (actual !== total.sohFromSheet) {
      mismatches.push({
        sku: total.sku,
        warehouseCode: total.warehouseCode,
        expected: total.sohFromSheet,
        actual,
        diff: actual - total.sohFromSheet,
      });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}
