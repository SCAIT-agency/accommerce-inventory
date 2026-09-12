import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments } from "../drizzle/schema";
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts } from "./shipments";
import { createSku, createVendor } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";

beforeEach(async () => {
  // Real FKs now tie these tables together, but each test file only cleans
  // its own tables at the start of each test (no afterAll anywhere in this
  // suite) — so a row left by another file's last test can otherwise block
  // these deletes regardless of order. Disabling FK checks for the cleanup
  // makes this file's reset order-independent again.
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db.delete(changeLog);
  await db.delete(payments);
  await db.delete(shipmentLineItems);
  await db.delete(shipments);
  await db.delete(poLineItems);
  await db.delete(purchaseOrders);
  await db.delete(skus);
  await db.delete(vendors);
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
});

async function seedPoWithLineItem() {
  const vendor = await createVendor({ name: "MBS Logistics" });
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const po = await createPurchaseOrder({
    poNumber: "PO1-W4",
    vendorId: vendor.id,
    lineItems: [{ skuId: sku.id, qty: 90000, unitPrice: "0.15", currency: "USD" }],
    createdBy: 1,
  });
  const withItems = await getPurchaseOrderWithLineItemsHelper(po.id);
  return { po, lineItemId: withItems.lineItems[0].id, skuId: sku.id };
}

// local re-import to avoid a circular test dependency
import { getPurchaseOrderWithLineItems as getPurchaseOrderWithLineItemsHelper } from "./purchaseOrders";

describe("shipments", () => {
  it("creates a shipment carrying a weight/value-allocated share of a PO line item", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 45000, weightShare: "0.5", valueShare: "0.5" }],
      createdBy: 1,
    });
    const withItems = await getShipmentWithLineItems(shipment.id);
    expect(withItems.lineItems[0].weightShare).toBe("0.5");
  });

  it("records freight/duty cost on a shipment for later per-line landed-cost allocation", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
    const updated = await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );
    expect(updated.freightCost).toBe("4200.00");
    expect(updated.costCurrency).toBe("EUR");
  });

  it("logs change_log entries with a required reason when shipment costs are recorded", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );
    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(2);
    const freightEntry = entries.find((e) => e.field === "freightCost");
    const dutyEntry = entries.find((e) => e.field === "dutyCost");
    expect(freightEntry?.oldValue).toBeNull();
    expect(freightEntry?.newValue).toBe("4200.00");
    expect(freightEntry?.reasonCategory).toBe("freight_rate_change");
    expect(dutyEntry?.oldValue).toBeNull();
    expect(dutyEntry?.newValue).toBe("980.00");
    expect(dutyEntry?.reasonCategory).toBe("freight_rate_change");
  });

  it("blocks marking a shipment departed without a planned depart date first", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: 1 })).rejects.toThrow(/planned depart date/);
  });

  it("logs the shipment's real prior actualDepartDate as oldValue, not a hardcoded null, when marking departed again", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-10-05"), {
      reasonCategory: "logistics_delay",
      changedBy: 1,
    });
    const firstActualDate = new Date("2026-10-06");
    await markShipmentDeparted(shipment.id, firstActualDate, { changedBy: 1 });
    await db.delete(changeLog);

    const correctedActualDate = new Date("2026-10-07");
    await markShipmentDeparted(shipment.id, correctedActualDate, { changedBy: 1 });

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].field).toBe("actualDepartDate");
    expect(entries[0].oldValue).toBe(firstActualDate.toISOString());
    expect(entries[0].newValue).toBe(correctedActualDate.toISOString());
  });

  it("logs a change_log entry with a logistics_delay reason when the planned depart date slips", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-10-05"), {
      reasonCategory: "logistics_delay",
      changedBy: 1,
    });
    const entries = await db.select().from(changeLog);
    expect(entries[0].reasonCategory).toBe("logistics_delay");
  });

  it("accepts an optional vendor reference and initial status for migration use", async () => {
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      vendorReference: "MBS-DEBIT-SZDN26080711",
      initialStatus: "delivered",
      lineItems: [],
      createdBy: 1,
    });
    expect(shipment.vendorReference).toBe("MBS-DEBIT-SZDN26080711");
    expect(shipment.status).toBe("delivered");
  });

  it("rejects a shipment line item referencing a nonexistent PO line item", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    await expect(
      createShipment({
        shipmentRef: "PO1-W4-Container2",
        lineItems: [{ poLineItemId: 999999, skuId: sku.id, qty: 100, weightShare: "1.0", valueShare: "1.0" }],
        createdBy: 1,
      }),
    ).rejects.toThrow();
  });
});
