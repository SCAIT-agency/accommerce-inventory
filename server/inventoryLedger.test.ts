import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { inventoryLedger, skus, warehouses, appSettings, users } from "../drizzle/schema";
import { recordLedgerEvent, getSoh, getSohForSkus, ALLOW_BACKORDERS_SETTING, replayLedgerEventsFifo, correctLedgerReceipt, getRemainingBatches } from "./inventoryLedger";
import { createSku, createWarehouse, setAppSetting, createUser } from "./db";

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
      // Correction tests create a `users` row per test (changedBy is a real
      // FK); users.email is unique, so without this delete the second such
      // test in the file would collide on the same address.
      await tx.delete(users);
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

  it("correctLedgerReceipt appends a reversal and a replacement receipt, leaving the original row untouched", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    const result = await correctLedgerReceipt(
      original.id,
      { qty: 90 },
      { changedBy: user.id, reasonNote: "recount found 10 units short" },
    );

    expect(result.consumedFromOtherBatches).toBe(false);

    const [unchangedOriginal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, original.id));
    expect(unchangedOriginal.qty).toBe(100);
    expect(unchangedOriginal.eventType).toBe("receipt");

    const [reversal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.reversalId));
    expect(reversal.eventType).toBe("adjustment");
    expect(reversal.qty).toBe(-100);
    expect(parseFloat(reversal.unitCost ?? "0")).toBeCloseTo(1.0, 6);
    expect(reversal.correctsEventId).toBe(original.id);
    expect(reversal.reasonCategory).toBe("data_correction");
    expect(reversal.reasonNote).toBe("recount found 10 units short");
    expect(reversal.changedBy).toBe(user.id);

    const [corrected] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.correctedId));
    expect(corrected.eventType).toBe("receipt");
    expect(corrected.qty).toBe(90);
    expect(parseFloat(corrected.unitCost ?? "0")).toBeCloseTo(1.0, 6);
    expect(corrected.correctsEventId).toBe(original.id);

    expect(await getSoh(sku.id, ff.id)).toBe(90);
  });

  it("correctLedgerReceipt can correct unitCost only, leaving qty unchanged", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    const result = await correctLedgerReceipt(
      original.id,
      { unitCost: "1.50" },
      { changedBy: user.id, reasonNote: "freight invoice restated" },
    );

    const [corrected] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.correctedId));
    expect(corrected.qty).toBe(100);
    expect(parseFloat(corrected.unitCost ?? "0")).toBeCloseTo(1.5, 6);
    expect(await getSoh(sku.id, ff.id)).toBe(100);
  });

  it("correctLedgerReceipt reports consumedFromOtherBatches when the original batch was already sold through", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "batch-A" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "2.00", date: new Date("2026-09-02"), sourceRef: "batch-B" });
    // Sells all 50 of batch-A before the correction runs.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-03"), sourceRef: "shopify" });

    const [batchAEvent] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "batch-A"));

    // Correcting batch-A's qty now: its reversal (-50) must draw from
    // batch-B, since batch-A itself has 0 remaining.
    const result = await correctLedgerReceipt(
      batchAEvent.id,
      { qty: 40 },
      { changedBy: user.id, reasonNote: "recount" },
    );

    expect(result.consumedFromOtherBatches).toBe(true);
  });

  it("correctLedgerReceipt rejects correcting a non-receipt event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -10, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });
    const [saleEvent] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "sale"));

    await expect(
      correctLedgerReceipt(saleEvent.id, { qty: 5 }, { changedBy: user.id, reasonNote: "test" }),
    ).rejects.toThrow(/is not a receipt/);
  });

  it("correctLedgerReceipt rejects correcting an event that no longer exists", async () => {
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });
    await expect(
      correctLedgerReceipt(999999, { qty: 5 }, { changedBy: user.id, reasonNote: "test" }),
    ).rejects.toThrow(/no ledger event found/);
  });

  it("correctLedgerReceipt rejects correcting an already-corrected event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    await correctLedgerReceipt(original.id, { qty: 90 }, { changedBy: user.id, reasonNote: "first correction" });

    await expect(
      correctLedgerReceipt(original.id, { qty: 80 }, { changedBy: user.id, reasonNote: "second attempt on the original" }),
    ).rejects.toThrow(/already been corrected/);
  });

  it("correctLedgerReceipt rejects a no-op correction", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    await expect(
      correctLedgerReceipt(original.id, { qty: 100 }, { changedBy: user.id, reasonNote: "no real change" }),
    ).rejects.toThrow(/changes nothing/);
  });

  it("correctLedgerReceipt rejects a correction that would drive SOH negative, unless allowNegativeSoh is set", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    // Sells 95 of the wrongly-large 100 -- correcting down to 10 would need
    // to reverse all 100 units, but only 5 remain unsold.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -95, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "receipt"));

    await expect(
      correctLedgerReceipt(original.id, { qty: 10 }, { changedBy: user.id, reasonNote: "actual receipt was only 10" }),
    ).rejects.toThrow(/negative/i);

    const result = await correctLedgerReceipt(
      original.id,
      { qty: 10 },
      { changedBy: user.id, reasonNote: "actual receipt was only 10", allowNegativeSoh: true },
    );
    expect(await getSoh(sku.id, ff.id)).toBe(10 - 95);
    // The reversal could not be absorbed by the original batch's own
    // remaining 5 units — the honest answer for a caller deciding whether to
    // warn the operator is "yes, this touched stock beyond that batch".
    expect(result.consumedFromOtherBatches).toBe(true);
  });

  it("correctLedgerReceipt corrects a months-old receipt today without tripping the guard/replay ordering asymmetry", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    // The reversal this correction writes is dated *today*, while the receipt
    // it reverses is months old and partly sold through. The negative-stock
    // guard evaluates end-of-today SOH; the FIFO replay processes events in
    // strict (date, id) order. Both must agree that this is fine.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-06-01"), sourceRef: "PO-JUNE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.20", date: new Date("2026-07-01"), sourceRef: "PO-JULY" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -60, unitCost: null, date: new Date("2026-08-15"), sourceRef: "shopify" });
    const [june] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "PO-JUNE"));

    const result = await correctLedgerReceipt(june.id, { qty: 95 }, { changedBy: user.id, reasonNote: "recount" });

    expect(await getSoh(sku.id, ff.id)).toBe(100 + 100 - 60 - 100 + 95);
    // The ledger must still replay cleanly afterwards — a correction that
    // leaves getRemainingBatches throwing would break SOH views and Daily COGS.
    const batches = await getRemainingBatches(sku.id, ff.id);
    expect(batches.reduce((sum, b) => sum + b.remainingQty, 0)).toBe(await getSoh(sku.id, ff.id));
    // The June batch had only 40 of its 100 units left, so reversing all 100
    // necessarily reached past it.
    expect(result.consumedFromOtherBatches).toBe(true);
  });

  it("correctLedgerReceipt handles two same-day corrections of two different receipts for one sku/warehouse", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-05"), sourceRef: "PO2" });
    const [first] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "PO1"));
    const [second] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "PO2"));

    const firstResult = await correctLedgerReceipt(first.id, { qty: 90 }, { changedBy: user.id, reasonNote: "recount PO1" });
    const secondResult = await correctLedgerReceipt(second.id, { qty: 80 }, { changedBy: user.id, reasonNote: "recount PO2" });

    expect(firstResult.consumedFromOtherBatches).toBe(false);
    expect(secondResult.consumedFromOtherBatches).toBe(false);
    expect(await getSoh(sku.id, ff.id)).toBe(100 + 100 - 100 + 90 - 100 + 80);
    const batches = await getRemainingBatches(sku.id, ff.id);
    expect(batches.reduce((sum, b) => sum + b.remainingQty, 0)).toBe(await getSoh(sku.id, ff.id));
  });

  it("correctLedgerReceipt refuses a reversal that end-of-day SOH covers but FIFO stock at its own timestamp does not", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -30, unitCost: null, date: new Date("2026-09-05"), sourceRef: "shopify" });
    // A receipt stamped at the very end of today: visible to the day-granular
    // negative-stock guard (which looks at end-of-day SOH = 120), invisible to
    // the FIFO replay at the correction's own wall-clock timestamp, where only
    // PO1's remaining 20 units exist. This is the exact ordering asymmetry
    // documented above getRemainingBatches.
    const endOfToday = new Date(`${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`);
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.10", date: endOfToday, sourceRef: "PO2-LATE" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "PO1"));

    await expect(
      correctLedgerReceipt(original.id, { qty: 40 }, { changedBy: user.id, reasonNote: "recount" }),
    ).rejects.toThrow(/allowNegativeSoh/);

    // Refused, not half-written: the whole transaction rolled back.
    const rows = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(rows).toHaveLength(3);
    expect(await getSoh(sku.id, ff.id)).toBe(120);
    await expect(getRemainingBatches(sku.id, ff.id)).resolves.toHaveLength(2);
  });

  it("correctLedgerReceipt rejects a no-op correction written at a different decimal scale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    // Stored as "1.00000000" by the decimal(18,8) column — the same number the
    // caller is passing, just written at a different scale.
    expect(original.unitCost).toBe("1.00000000");

    await expect(
      correctLedgerReceipt(original.id, { unitCost: "1.00" }, { changedBy: user.id, reasonNote: "same cost, restated" }),
    ).rejects.toThrow(/changes nothing/);
  });

  it("correctLedgerReceipt rejects a negative or fractional corrected qty", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    await expect(
      correctLedgerReceipt(original.id, { qty: -5 }, { changedBy: user.id, reasonNote: "typo" }),
    ).rejects.toThrow(/whole number/);
    await expect(
      correctLedgerReceipt(original.id, { qty: 12.5 }, { changedBy: user.id, reasonNote: "typo" }),
    ).rejects.toThrow(/whole number/);
    await expect(
      correctLedgerReceipt(original.id, { unitCost: "not-a-number" }, { changedBy: user.id, reasonNote: "typo" }),
    ).rejects.toThrow(/unitCost/);
    // Exponent notation would sail past the no-op check, which can only
    // normalize what the decimal(18,8) column stores as written.
    await expect(
      correctLedgerReceipt(original.id, { unitCost: "1e-9" }, { changedBy: user.id, reasonNote: "typo" }),
    ).rejects.toThrow(/plain decimal notation/);
  });

  it("correctLedgerReceipt rejects a unitCost change that rounds away below the column's 8-decimal scale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "10.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(original.unitCost).toBe("10.00000000");

    // 9 decimal places against a decimal(18,8) column: the replacement row
    // would store "10.00000000", byte-identical to the original.
    await expect(
      correctLedgerReceipt(original.id, { unitCost: "10.000000001" }, { changedBy: user.id, reasonNote: "sub-scale noise" }),
    ).rejects.toThrow(/changes nothing/);

    // The first digit the column actually keeps is still a real change.
    const result = await correctLedgerReceipt(
      original.id,
      { unitCost: "10.00000001" },
      { changedBy: user.id, reasonNote: "one unit of the last stored decimal" },
    );
    const [corrected] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.correctedId));
    expect(corrected.unitCost).toBe("10.00000001");
  });

  it("correctLedgerReceipt rejects an empty or whitespace-only reasonNote", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    await expect(
      correctLedgerReceipt(original.id, { qty: 90 }, { changedBy: user.id, reasonNote: "" }),
    ).rejects.toThrow(/reasonNote is required/);
    await expect(
      correctLedgerReceipt(original.id, { qty: 90 }, { changedBy: user.id, reasonNote: "   " }),
    ).rejects.toThrow(/reasonNote is required/);

    // Nothing was written by either attempt.
    const rows = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(rows).toHaveLength(1);
  });
});
