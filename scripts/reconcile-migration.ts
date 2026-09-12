import { transformSheetExport, reconcileMigration, type SheetExportRow, type SkuWarehouseTotal } from "./migrate-from-sheet";
import { createSku, createWarehouse, listSkus, listWarehouses } from "../server/db";
import { recordLedgerEvent, getSoh } from "../server/inventoryLedger";

export async function runMigration(exportRows: SheetExportRow[], sheetTotals: SkuWarehouseTotal[]) {
  const { ledgerEvents } = transformSheetExport(exportRows);

  const existingSkus = await listSkus();
  const existingWarehouses = await listWarehouses();
  const skuByCode = new Map(existingSkus.map((s) => [s.sku, s.id]));
  const warehouseByCode = new Map(existingWarehouses.map((w) => [w.code, w.id]));

  for (const event of ledgerEvents) {
    let skuId = skuByCode.get(event.sku);
    if (!skuId) {
      const created = await createSku({ sku: event.sku, primaryIdentifierType: "sku" });
      skuId = created.id;
      skuByCode.set(event.sku, skuId);
    }
    let warehouseId = warehouseByCode.get(event.warehouseCode);
    if (!warehouseId) {
      const created = await createWarehouse({ code: event.warehouseCode, name: event.warehouseCode });
      warehouseId = created.id;
      warehouseByCode.set(event.warehouseCode, warehouseId);
    }
    await recordLedgerEvent({
      skuId,
      warehouseId,
      eventType: event.eventType,
      qty: event.eventType === "sale" ? -Math.abs(event.qty) : event.qty,
      unitCost: event.eventType === "receipt" ? String(event.unitCost) : null,
      date: event.date,
      sourceRef: event.sourceRef,
    });
  }

  const result = await reconcileMigration(sheetTotals, {
    getMigratedSoh: async (sku, warehouseCode) => {
      const skuId = skuByCode.get(sku)!;
      const warehouseId = warehouseByCode.get(warehouseCode)!;
      return getSoh(skuId, warehouseId);
    },
  });

  if (!result.passed) {
    console.error("MIGRATION RECONCILIATION FAILED — do not proceed to parallel run:", result.mismatches);
    process.exit(1);
  }
  console.log(`Migration reconciled: ${sheetTotals.length} SKU/warehouse totals matched exactly.`);
}
