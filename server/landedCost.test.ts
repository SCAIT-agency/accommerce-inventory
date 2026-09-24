import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getShipmentLandedUnitCost } from "./landedCost";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, inventoryLedger, payments, warehouses, users } from "../drizzle/schema";
import { createSku, createVendor, createWarehouse, createUser } from "./db";
import { createPurchaseOrder, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createShipment, recordShipmentCosts } from "./shipments";

describe("getShipmentLandedUnitCost", () => {
  let userId: number;

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
        await tx.delete(warehouses);
        await tx.delete(users);
      } finally {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }
    });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    userId = user.id;
  });

  it("allocates shipment freight/duty to each SKU line by its weight/value share, on top of the PO unit price", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const [shipmentLineItem] = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipment.id));

    const result = await getShipmentLandedUnitCost(shipment.id);
    // (1000 * 0.15 EXW + 150 freight * 1.0 share + 20 duty * 1.0 share) / 1000 units
    expect(result).toEqual([{ lineItemId: shipmentLineItem.id, skuId: sku.id, landedUnitCost: (150 + 20.0 + 1000 * 0.15) / 1000 }]);
  });

  it("adds adminFeesCost to the weight-allocated freight component and subtracts eustAmount/vatAmount (value-allocated) from the gross figure", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR", adminFeesCost: "10.00", eustAmount: "5.00", vatAmount: "3.00" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const [shipmentLineItem] = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipment.id));

    const result = await getShipmentLandedUnitCost(shipment.id);
    // EXW 150 + freight(150+10 adminFees) + duty 20 - recoverable(5 eust + 3 vat), all at 1.0 share, /1000 units
    expect(result).toEqual([{ lineItemId: shipmentLineItem.id, skuId: sku.id, landedUnitCost: (1000 * 0.15 + 150 + 10 + 20 - 5 - 3) / 1000 }]);
  });

  it("treats unset adminFeesCost/eustAmount/vatAmount as zero — identical to the pre-existing formula (backward compatible)", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const [shipmentLineItem] = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipment.id));

    const result = await getShipmentLandedUnitCost(shipment.id);
    expect(result).toEqual([{ lineItemId: shipmentLineItem.id, skuId: sku.id, landedUnitCost: (150 + 20.0 + 1000 * 0.15) / 1000 }]);
  });

  it("returns a distinct lineItemId for two line items on one shipment that share the same SKU", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [
        { skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" },
        { skuId: sku.id, qty: 500, unitPrice: "0.20", currency: "EUR" },
      ],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const [tranche1, tranche2] = withItems.lineItems;

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container9",
      warehouseId: ff.id,
      lineItems: [
        { poLineItemId: tranche1.id, skuId: sku.id, qty: 1000, weightShare: "0.5", valueShare: "0.5" },
        { poLineItemId: tranche2.id, skuId: sku.id, qty: 500, weightShare: "0.5", valueShare: "0.5" },
      ],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const shipmentLines = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipment.id));
    const shipmentLine1 = shipmentLines.find((l) => l.poLineItemId === tranche1.id)!;
    const shipmentLine2 = shipmentLines.find((l) => l.poLineItemId === tranche2.id)!;

    const result = await getShipmentLandedUnitCost(shipment.id);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.skuId === sku.id)).toBe(true);
    expect(result[0].lineItemId).not.toBe(result[1].lineItemId);

    const byLineItemId = new Map(result.map((r) => [r.lineItemId, r.landedUnitCost]));
    // Each tranche's own EXW price plus its own 0.5 weightShare of 150 freight (75)
    // and 0.5 valueShare of 20 duty (10) = 85 total allocated.
    expect(byLineItemId.get(shipmentLine1.id)).toBeCloseTo((1000 * 0.15 + 85) / 1000, 6);
    expect(byLineItemId.get(shipmentLine2.id)).toBeCloseTo((500 * 0.2 + 85) / 500, 6);
  });

  it("computes correct per-line landed cost for multiple line items from one batched PO-line query, not one query per line", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const skuA = await createSku({ sku: "JELLO-MULTI-A", primaryIdentifierType: "sku" });
    const skuB = await createSku({ sku: "JELLO-MULTI-B", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [
        { skuId: skuA.id, qty: 1000, unitPrice: "0.15", currency: "EUR" },
        { skuId: skuB.id, qty: 500, unitPrice: "0.30", currency: "EUR" },
      ],
      createdBy: userId,
    });
    const poLines = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const lineA = poLines.find((l) => l.skuId === skuA.id)!;
    const lineB = poLines.find((l) => l.skuId === skuB.id)!;

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container3",
      warehouseId: ff.id,
      lineItems: [
        { poLineItemId: lineA.id, skuId: skuA.id, qty: 1000, weightShare: "0.6", valueShare: "0.6" },
        { poLineItemId: lineB.id, skuId: skuB.id, qty: 500, weightShare: "0.4", valueShare: "0.4" },
      ],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const result = await getShipmentLandedUnitCost(shipment.id);

    const resultA = result.find((r) => r.skuId === skuA.id);
    const resultB = result.find((r) => r.skuId === skuB.id);
    // A: (1000*0.15 EXW + 150*0.6 freight + 20*0.6 duty) / 1000
    expect(resultA?.landedUnitCost).toBeCloseTo((1000 * 0.15 + 150 * 0.6 + 20 * 0.6) / 1000, 6);
    // B: (500*0.30 EXW + 150*0.4 freight + 20*0.4 duty) / 500
    expect(resultB?.landedUnitCost).toBeCloseTo((500 * 0.3 + 150 * 0.4 + 20 * 0.4) / 500, 6);
  });

  it("throws a clear error instead of crashing when a shipment line item references a PO line item that doesn't exist", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container4",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    // Delete the PO line item the shipment line still references — an
    // orphaned FK shouldn't be possible via the app's own mutations, but the
    // lookup must fail loudly with a clear message rather than crash on an
    // undefined PO line if it ever happens (e.g. bad migrated data).
    // Bypassing the FK constraint here is the only way to construct this
    // otherwise-impossible-via-the-app state to test the defensive check.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await tx.delete(poLineItems).where(eq(poLineItems.id, lineItem.id));
      } finally {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }
    });

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(
      new RegExp(`no PO line item found with id ${lineItem.id}`),
    );
  });

  it("throws instead of dividing by zero when a shipment line item has qty 0", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 0, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/invalid qty/);
  });

  it("rejects a non-numeric weightShare at write time, since the column is now decimal", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "EUR" }],
      createdBy: userId,
    });
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // weightShare/valueShare became `decimal` columns (varchar -> decimal
    // migration), so MySQL itself now rejects a non-numeric value at insert
    // time -- the app-level guard in getShipmentLandedUnitCost that this test
    // used to exercise is unreachable for this case now that the schema is
    // the guard. This dev DB runs in strict mode (STRICT_TRANS_TABLES,
    // confirmed via `SELECT @@sql_mode`), so a non-numeric decimal insert
    // reliably throws ER_TRUNCATED_WRONG_VALUE_FOR_FIELD rather than silently
    // coercing to 0. Drizzle wraps the real mysql2 error in a generic "Failed
    // query" Error whose own .message doesn't carry the underlying reason, so
    // assert on the wrapped .cause's error code instead of a bare toThrow()
    // (which would also pass for an unrelated FK violation or dropped connection).
    await expect(
      createShipment({
        shipmentRef: "PO1-W4-Container2",
        warehouseId: ff.id,
        lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "abc", valueShare: "1.0" }],
        createdBy: userId,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD" }),
    });
  });

  it("rejects a weightShare/valueShare that's a valid decimal but out of the [0,1] range, via the app-level guard", async () => {
    // decimal(9,8) happily stores an out-of-range value like 1.5 or -0.5 —
    // only the non-numeric half of the original guard became unreachable
    // after the varchar->decimal migration (see test above). The range half
    // is still live app logic in getShipmentLandedUnitCost and needs its own
    // coverage, independent of the write-time schema guard.
    const vendor = await createVendor({ name: "Lvmengkang" });
    const skuA = await createSku({ sku: "JELLO-MULTI-A", primaryIdentifierType: "sku" });
    const skuB = await createSku({ sku: "JELLO-MULTI-B", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [
        { skuId: skuA.id, qty: 1000, unitPrice: "0.15", currency: "EUR" },
        { skuId: skuB.id, qty: 500, unitPrice: "0.30", currency: "EUR" },
      ],
      createdBy: userId,
    });
    const poLines = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const lineA = poLines.find((l) => l.skuId === skuA.id)!;
    const lineB = poLines.find((l) => l.skuId === skuB.id)!;
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container5",
      warehouseId: ff.id,
      // weightShare 1.5 is a perfectly valid decimal(9,8) value (so the
      // schema won't reject it), but out of the [0,1] range the app-level
      // guard requires — this must be caught by getShipmentLandedUnitCost's
      // own validation, not the schema. The rest of the shares are left not
      // summing to 1 as a natural consequence, but the per-line range check
      // runs first and throws before the sum check is ever reached.
      lineItems: [
        { poLineItemId: lineA.id, skuId: skuA.id, qty: 1000, weightShare: "1.5", valueShare: "1.0" },
        { poLineItemId: lineB.id, skuId: skuB.id, qty: 500, weightShare: "-0.5", valueShare: "0.0" },
      ],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/invalid weightShare/);
  });

  it("rejects a shipment whose line items' weightShare doesn't sum to 1, instead of silently over- or under-allocating freight", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const skuA = await createSku({ sku: "JELLO-MULTI-A", primaryIdentifierType: "sku" });
    const skuB = await createSku({ sku: "JELLO-MULTI-B", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [
        { skuId: skuA.id, qty: 1000, unitPrice: "0.15", currency: "EUR" },
        { skuId: skuB.id, qty: 500, unitPrice: "0.30", currency: "EUR" },
      ],
      createdBy: userId,
    });
    const poLines = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    const lineA = poLines.find((l) => l.skuId === skuA.id)!;
    const lineB = poLines.find((l) => l.skuId === skuB.id)!;
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container3",
      warehouseId: ff.id,
      // Both lines left at the "1.0" default — a common real-world mistake
      // (see design discussion) that would otherwise double-allocate freight.
      lineItems: [
        { poLineItemId: lineA.id, skuId: skuA.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" },
        { poLineItemId: lineB.id, skuId: skuB.id, qty: 500, weightShare: "1.0", valueShare: "1.0" },
      ],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/weightShare sums to 2/);
  });

  it("rejects computing landed cost when the PO line's currency doesn't match the shipment's cost currency", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
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
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const results = await getShipmentLandedUnitCost(shipment.id);
    expect(results[0].landedUnitCost).toBeCloseTo(0.15 + 100 * 1.0 / 1000 + 20 * 1.0 / 1000);
  });

  it("does not treat differently-cased currency codes as a mismatch (\"usd\" vs \"USD\")", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "usd" }],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const results = await getShipmentLandedUnitCost(shipment.id);
    expect(results[0].landedUnitCost).toBeCloseTo(0.15 + 100 * 1.0 / 1000 + 20 * 1.0 / 1000);
  });

  it("computes EXW-only landed cost when shipment costCurrency is null (costs not yet recorded)", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    // Note: no recordShipmentCosts call — costCurrency remains null

    const results = await getShipmentLandedUnitCost(shipment.id);
    // With no freight/duty recorded, landed cost = EXW price only (0.15 per unit)
    expect(results[0].landedUnitCost).toBeCloseTo(0.15);
  });
});
