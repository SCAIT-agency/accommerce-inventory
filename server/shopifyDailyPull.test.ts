import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { skus, warehouses, salesActuals, inventoryLedger } from "../drizzle/schema";
import { parseShopifyExport, runDailyShopifyPull } from "./shopifyDailyPull";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  await db.delete(salesActuals);
  await db.delete(inventoryLedger);
  await db.delete(skus);
  await db.delete(warehouses);
});

describe("daily Shopify pull", () => {
  it("parses raw export rows into normalized sale records", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse_code: "FF-DE", order_date: "2026-09-09", qty: "12" },
      { sku: "JELLO-CAL-500", warehouse_code: "FF-DE", order_date: "2026-09-09", qty: "3" },
    ];
    const parsed = parseShopifyExport(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", date: "2026-09-09", qty: 15 });
  });

  it("imports parsed sales through recordSalesActual, skipping rows for unknown SKUs instead of throwing", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    const rows = [
      { sku: "JELLO-CAL-500", warehouse_code: "FF-DE", order_date: "2026-09-09", qty: "15" },
      { sku: "UNKNOWN-SKU", warehouse_code: "FF-DE", order_date: "2026-09-09", qty: "5" },
    ];

    const result = await runDailyShopifyPull(rows, { "JELLO-CAL-500": sku.id }, { "FF-DE": ff.id });

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([{ sku: "UNKNOWN-SKU", reason: "unknown SKU" }]);

    const ledgerRows = await db.select().from(inventoryLedger);
    expect(ledgerRows).toHaveLength(2);
  });

  it("returns zero imported and no error for an empty export", async () => {
    const result = await runDailyShopifyPull([], {}, {});
    expect(result.imported).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});
