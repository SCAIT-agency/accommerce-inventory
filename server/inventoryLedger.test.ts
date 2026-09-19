import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { inventoryLedger, skus, warehouses } from "../drizzle/schema";
import { recordLedgerEvent, getSoh, getSohByWarehouse } from "./inventoryLedger";
import { createSku, createWarehouse } from "./db";

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
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("inventory ledger", () => {
  it("computes SOH as the running sum of receipt/sale events, never a stored field", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1-W1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -120, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-2026-09-02" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -80, unitCost: null, date: new Date("2026-09-03"), sourceRef: "shopify-2026-09-03" });

    expect(await getSoh(sku.id, ff.id)).toBe(800);
    expect(await getSoh(sku.id, ff.id, new Date("2026-09-02"))).toBe(880);
  });

  it("never blends two warehouses into one SOH figure", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1-W1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: mutual.id, eventType: "receipt", qty: 300, unitCost: "0.45", date: new Date("2026-09-01"), sourceRef: "PO1-Local" });

    const byWarehouse = await getSohByWarehouse(sku.id);
    expect(byWarehouse).toEqual([
      { warehouseId: ff.id, soh: 1000 },
      { warehouseId: mutual.id, soh: 300 },
    ]);
  });

  it("rejects a sale event that would drive SOH below zero", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await expect(
      recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -80, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-2026-09-02" }),
    ).rejects.toThrow(/negative/i);

    // the rejected event must not have been written
    expect(await getSoh(sku.id, ff.id)).toBe(50);
  });

  it("still allows a sale that exactly zeroes out SOH", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-2026-09-02" });

    expect(await getSoh(sku.id, ff.id)).toBe(0);
  });

  it("rejects a ledger event referencing a nonexistent SKU", async () => {
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await expect(
      recordLedgerEvent({ skuId: 999999, warehouseId: ff.id, eventType: "receipt", qty: 10, unitCost: "0.42", date: new Date(), sourceRef: "PO1" }),
    ).rejects.toThrow();
  });

  it("rejects a ledger event referencing a nonexistent warehouse", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    await expect(
      recordLedgerEvent({ skuId: sku.id, warehouseId: 999999, eventType: "receipt", qty: 10, unitCost: "0.42", date: new Date(), sourceRef: "PO1" }),
    ).rejects.toThrow();
  });

  it("pins every pool connection's session timezone to UTC via SET time_zone command", async () => {
    // Directly verify that the pool's connection event handler has set the session
    // timezone to UTC. This test proves the SET time_zone command was executed,
    // independent of whether the server's *default* timezone also happens to be UTC.
    const result = await db.execute(sql`SELECT @@session.time_zone as tz`);
    // MySQL returns the timezone as either '+00:00' (if set explicitly) or the
    // server's default (e.g. 'UTC', 'SYSTEM'). We explicitly set '+00:00', so expect that.
    expect(result[0][0].tz).toBe("+00:00");
  });
});
