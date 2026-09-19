import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { computeFifoCogs, getShipmentLandedUnitCost } from "./landedCost";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, inventoryLedger, payments } from "../drizzle/schema";
import { createSku, createVendor } from "./db";
import { createPurchaseOrder, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createShipment, recordShipmentCosts } from "./shipments";

describe("computeFifoCogs", () => {
  it("consumes the oldest batch first, splitting a sale across two batches when the first is exhausted", () => {
    const receipts = [
      { qty: 100, unitCost: 2.0, date: new Date("2026-09-01") },
      { qty: 200, unitCost: 2.5, date: new Date("2026-09-05") },
    ];
    const saleEvents = [{ qty: 150, date: new Date("2026-09-10") }];

    const result = computeFifoCogs(receipts, saleEvents);

    expect(result.totalCogs).toBeCloseTo(100 * 2.0 + 50 * 2.5, 2);
    expect(result.remainingBatches).toEqual([{ qty: 150, unitCost: 2.5, date: new Date("2026-09-05") }]);
  });

  it("throws if total sale quantity exceeds total received quantity (would go negative)", () => {
    const receipts = [{ qty: 50, unitCost: 2.0, date: new Date("2026-09-01") }];
    const saleEvents = [{ qty: 80, date: new Date("2026-09-10") }];
    expect(() => computeFifoCogs(receipts, saleEvents)).toThrow(/insufficient stock/);
  });

  it("ignores receipts dated after the sale event (can't sell what hasn't landed yet)", () => {
    const receipts = [
      { qty: 100, unitCost: 2.0, date: new Date("2026-09-10") },
    ];
    const saleEvents = [{ qty: 10, date: new Date("2026-09-05") }];
    expect(() => computeFifoCogs(receipts, saleEvents)).toThrow(/insufficient stock/);
  });
});

describe("getShipmentLandedUnitCost", () => {
  beforeEach(async () => {
    // Real FKs now tie these tables together, but each test file only cleans
    // its own tables at the start of each test (no afterAll anywhere in this
    // suite) — so a row left by another file's last test can otherwise block
    // these deletes regardless of order. Disabling FK checks for the cleanup
    // makes this file's reset order-independent again.
    //
    // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
    // deletes, and the toggle-on all land on the same pooled connection from
    // `db` (mysql.createPool). A real db.transaction pins one connection for
    // its whole duration, which is exactly the guarantee this needs.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await tx.delete(shipmentLineItems);
        await tx.delete(shipments);
        await tx.delete(poLineItems);
        await tx.delete(purchaseOrders);
        await tx.delete(payments);
        await tx.delete(inventoryLedger);
        await tx.delete(skus);
        await tx.delete(vendors);
      } finally {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }
    });
  });

  it("allocates shipment freight/duty to each SKU line by its weight/value share, on top of the PO unit price", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: 1,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    const result = await getShipmentLandedUnitCost(shipment.id);
    // (1000 * 0.15 EXW + 150 freight * 1.0 share + 20 duty * 1.0 share) / 1000 units
    expect(result).toEqual([{ skuId: sku.id, landedUnitCost: (150 + 20.0 + 1000 * 0.15) / 1000 }]);
  });

  it("throws instead of dividing by zero when a shipment line item has qty 0", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: 1,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 0, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/invalid qty/);
  });

  it("rejects computing landed cost when the PO line's currency doesn't match the shipment's cost currency", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: 1,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/currency/i);
  });

  it("still computes landed cost correctly when currencies match (no regression)", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: 1,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    const results = await getShipmentLandedUnitCost(shipment.id);
    expect(results[0].landedUnitCost).toBeCloseTo(0.15 + 100 * 1.0 / 1000 + 20 * 1.0 / 1000);
  });
});
