import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { skus, warehouses, salesActuals, inventoryLedger } from "../drizzle/schema";
import { parseShopifyExport, runDailyShopifyPull, type ShopifyExportRow } from "./shopifyDailyPull";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  // Real FKs now tie skus/warehouses to other tables, but each test file only
  // cleans its own tables at the start of each test (no afterAll anywhere in
  // this suite) — so a row left by another file's last test can otherwise
  // block these deletes regardless of order. Disabling FK checks for the
  // cleanup makes this file's reset order-independent again.
  //
  // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
  // deletes, and the toggle-on all land on the same pooled connection from
  // `db` (mysql.createPool). A real db.transaction pins one connection for
  // its whole duration, which is exactly the guarantee this needs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(salesActuals);
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
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

  it("skips a row that duplicates an already-imported SKU/warehouse/date/source, without double-counting SOH or COGS", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    const rows: ShopifyExportRow[] = [
      { sku: "JELLO-CAL-500", warehouse_code: "FF-DE", order_date: "2026-09-19", qty: "10" },
    ];
    const skuLookup = { "JELLO-CAL-500": sku.id };
    const warehouseLookup = { "FF-DE": ff.id };

    const firstRun = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
    expect(firstRun.imported).toBe(1);
    expect(firstRun.skipped).toEqual([]);

    const secondRun = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
    expect(secondRun.imported).toBe(0);
    expect(secondRun.skipped).toEqual([{ sku: "JELLO-CAL-500", reason: expect.stringContaining("duplicate") }]);

    const actualRows = await db.select().from(salesActuals);
    expect(actualRows).toHaveLength(1);
    const ledgerRows = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "sale"));
    expect(ledgerRows).toHaveLength(1);
  });
});
