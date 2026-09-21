import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { inventoryLedger, skus, warehouses, appSettings } from "../drizzle/schema";
import { recordLedgerEvent, getSoh, getSohForSkus, ALLOW_BACKORDERS_SETTING, replayLedgerEventsFifo } from "./inventoryLedger";
import { createSku, createWarehouse, setAppSetting } from "./db";

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
      await tx.delete(appSettings);
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

  it("lets a sale drive SOH negative when the instance allows backorders", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await setAppSetting(ALLOW_BACKORDERS_SETTING, "true");

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -80, unitCost: null, date: new Date("2026-06-16"), sourceRef: "backorder-day-1" });

    expect(await getSoh(sku.id, ff.id)).toBe(-80);
  });

  it("keeps the strict guard when the setting holds any value other than \"true\"", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await setAppSetting(ALLOW_BACKORDERS_SETTING, "false");

    await expect(
      recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -1, unitCost: null, date: new Date("2026-06-16"), sourceRef: "x" }),
    ).rejects.toThrow(/negative/i);
  });

  it("pins every pool connection's session timezone to UTC via SET time_zone command", async () => {
    // Directly verify that the pool's connection event handler has set the session
    // timezone to UTC. This test proves the SET time_zone command was executed,
    // independent of whether the server's *default* timezone also happens to be UTC.
    const [rows] = await db.execute(sql`SELECT @@session.time_zone as tz`);
    // MySQL returns the timezone as either '+00:00' (if set explicitly) or the
    // server's default (e.g. 'UTC', 'SYSTEM'). We explicitly set '+00:00', so expect that.
    // drizzle's mysql2 execute() always types its result as the raw driver
    // tuple [ResultSetHeader, FieldPacket[]] regardless of the query shape, so
    // the actual row array must be cast through `unknown` first.
    expect((rows as unknown as { tz: string }[])[0].tz).toBe("+00:00");
  });

  it("round-trips an inventory_ledger timestamp through the pinned-UTC session without drift", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const written = new Date("2026-09-10T23:59:59.999Z");

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 10, unitCost: "0.42", date: written, sourceRef: "PO1" });

    const [row] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(row.date.toISOString()).toBe(written.toISOString());
  });

  it("negative-SOH guard sees same-day events regardless of insertion order or anchor time", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: new Date("2026-09-10T14:00:00.000Z"), sourceRef: "PO1" });
    // A whole-day sales aggregate, anchored at end-of-day per recordSalesActual's convention.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -80, unitCost: null, date: new Date("2026-09-10T23:59:59.999Z"), sourceRef: "sales_actual:manual" });

    // A same-day correction with an earlier real timestamp than the day-close
    // sale above — must still see that sale in its own solvency check.
    await expect(
      recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: -30, unitCost: null, date: new Date("2026-09-10T15:00:00.000Z"), sourceRef: "manual-correction" }),
    ).rejects.toThrow(/negative/i);

    const soh = await getSoh(sku.id, ff.id);
    expect(soh).toBe(20); // 100 - 80; the rejected adjustment never landed
  });

  it("returns per-SKU/per-warehouse SOH breakdowns for multiple SKUs in one call, omitting a SKU with no ledger history entirely", async () => {
    const skuA = await createSku({ sku: "JELLO-A", primaryIdentifierType: "sku" });
    const skuB = await createSku({ sku: "JELLO-B", primaryIdentifierType: "sku" });
    const skuC = await createSku({ sku: "JELLO-C", primaryIdentifierType: "sku" }); // no ledger rows at all
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

    await recordLedgerEvent({ skuId: skuA.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: skuA.id, warehouseId: mutual.id, eventType: "receipt", qty: 300, unitCost: "0.45", date: new Date("2026-09-01"), sourceRef: "PO1-Local" });
    await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-1" });

    const result = await getSohForSkus([skuA.id, skuB.id, skuC.id]);

    // arrayContaining (order-agnostic, since MySQL never guarantees GROUP BY
    // row order) plus an explicit length check — arrayContaining alone
    // wouldn't catch a spurious extra warehouse entry for skuA.
    expect(result.get(skuA.id)).toHaveLength(2);
    expect(result.get(skuA.id)).toEqual(
      expect.arrayContaining([
        { warehouseId: ff.id, soh: 1000 },
        { warehouseId: mutual.id, soh: 300 },
      ]),
    );
    expect(result.get(skuB.id)).toEqual([{ warehouseId: ff.id, soh: 450 }]);
    expect(result.has(skuC.id)).toBe(false);
  });

  it("returns an empty map for an empty skuIds array, without querying the database", async () => {
    const result = await getSohForSkus([]);
    expect(result.size).toBe(0);
  });

  it("getRemainingBatches reports oldest-first remaining stock after a partial sale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 200, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -150, unitCost: null, date: new Date("2026-09-10"), sourceRef: "shopify-2026-09-10" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-05"), sourceRef: "PO2", unitCost: 2.5, remainingQty: 150 },
    ]);
  });

  it("getRemainingBatches leaves an untouched newer batch alone when the older one fully covers a sale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 200, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -60, unitCost: null, date: new Date("2026-09-03"), sourceRef: "shopify-2026-09-03" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-01"), sourceRef: "PO1", unitCost: 2.0, remainingQty: 40 },
      { batchDate: new Date("2026-09-05"), sourceRef: "PO2", unitCost: 2.5, remainingQty: 200 },
    ]);
  });

  it("getRemainingBatches treats a positive adjustment as its own batch and a negative adjustment as FIFO consumption", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: 20, unitCost: "1.90", date: new Date("2026-09-03"), sourceRef: "manual-recount" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: -30, unitCost: null, date: new Date("2026-09-06"), sourceRef: "manual-shrinkage" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-01"), sourceRef: "PO1", unitCost: 2.0, remainingQty: 70 },
      { batchDate: new Date("2026-09-03"), sourceRef: "manual-recount", unitCost: 1.9, remainingQty: 20 },
    ]);
  });

  it("getRemainingBatches returns an empty array for a fully-depleted SKU", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -100, unitCost: null, date: new Date("2026-09-10"), sourceRef: "shopify-2026-09-10" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([]);
  });

  it("getRemainingBatches's remaining quantities sum to getSoh for the same SKU/warehouse", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "1.10", date: new Date("2026-09-08"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -220, unitCost: null, date: new Date("2026-09-12"), sourceRef: "shopify-2026-09-12" });

    const { getRemainingBatches, getSoh } = await import("./inventoryLedger");
    const batches = await getRemainingBatches(sku.id, ff.id);
    const totalRemaining = batches.reduce((sum, b) => sum + b.remainingQty, 0);
    const soh = await getSoh(sku.id, ff.id);

    expect(totalRemaining).toBe(soh);
  });

  it("accepts an ordinary receipt event with all new correction columns left null", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    const [row] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(row.lineItemId).toBeNull();
    expect(row.correctsEventId).toBeNull();
    expect(row.changedBy).toBeNull();
    expect(row.reasonCategory).toBeNull();
    expect(row.reasonNote).toBeNull();
  });

  it("replayLedgerEventsFifo reports which batch sourceRefs a negative adjustment actually consumed", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "batch-A" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "2.00", date: new Date("2026-09-02"), sourceRef: "batch-B" });
    // Consumes all of batch-A (50) plus 20 units of batch-B — a case
    // engineered to span two batches, so the reported sourceRefs must
    // include both, not just the first one touched.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: -70, unitCost: null, date: new Date("2026-09-03"), sourceRef: "write-off" });

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id)).orderBy(inventoryLedger.date, inventoryLedger.id);
    const touched: Set<string | null>[] = [];
    replayLedgerEventsFifo(events, undefined, (_event, _cost, touchedSourceRefs) => {
      touched.push(touchedSourceRefs);
    });

    expect(touched).toHaveLength(1);
    expect(touched[0]).toEqual(new Set(["batch-A", "batch-B"]));
  });

  it("replayLedgerEventsFifo's onSaleConsumed callback still fires with just cost, unaffected by the new third parameter", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.50", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -40, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id)).orderBy(inventoryLedger.date, inventoryLedger.id);
    let reportedCost = -1;
    replayLedgerEventsFifo(events, (_event, consumedCost) => { reportedCost = consumedCost; });

    expect(reportedCost).toBeCloseTo(40 * 0.5, 6);
  });
});
