import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments, warehouses } from "../drizzle/schema";
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate } from "./shipments";
import { createSku, createVendor, createWarehouse } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { listChangeLog } from "./changeLog";
import { getSoh } from "./inventoryLedger";
import { inventoryLedger } from "../drizzle/schema";

let ffWarehouseId: number;

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
      await tx.delete(changeLog);
      await tx.delete(payments);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(skus);
      await tx.delete(vendors);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  ffWarehouseId = ff.id;
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
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 45000, weightShare: "0.5", valueShare: "0.5" }],
      createdBy: 1,
    });
    const withItems = await getShipmentWithLineItems(shipment.id);
    expect(withItems.lineItems[0].weightShare).toBe("0.5");
  });

  it("records freight/duty cost on a shipment for later per-line landed-cost allocation", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    const updated = await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );
    expect(updated.freightCost).toBe("4200.00");
    expect(updated.costCurrency).toBe("EUR");
  });

  it("logs change_log entries with a required reason when shipment costs are recorded", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
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
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: 1 })).rejects.toThrow(/planned depart date/);
  });

  it("logs actualDepartDate changes in the change_log with correct oldValue", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-10-05"), {
      reasonCategory: "logistics_delay",
      changedBy: 1,
    });
    const firstActualDate = new Date("2026-10-06");
    await markShipmentDeparted(shipment.id, firstActualDate, { changedBy: 1 });

    const entries = await db.select().from(changeLog);
    const actualDepartureDateEntry = entries.find((e) => e.field === "actualDepartDate");
    expect(actualDepartureDateEntry).toBeDefined();
    expect(actualDepartureDateEntry?.oldValue).toBeNull();
    expect(actualDepartureDateEntry?.newValue).toBe(firstActualDate.toISOString().slice(0, 10));
  });

  it("logs a change_log entry with a logistics_delay reason when the planned depart date slips", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
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
      warehouseId: ffWarehouseId,
      lineItems: [],
      createdBy: 1,
    });
    expect(shipment.vendorReference).toBe("MBS-DEBIT-SZDN26080711");
    expect(shipment.status).toBe("delivered");
  });

  it("accepts optional freight/duty cost fields at creation time for migration use", async () => {
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      freightCost: "4200.00",
      dutyCost: "980.00",
      costCurrency: "EUR",
      warehouseId: ffWarehouseId,
      lineItems: [],
      createdBy: 1,
    });
    const withItems = await getShipmentWithLineItems(shipment.id);
    expect(withItems.freightCost).toBe("4200.00");
    expect(withItems.dutyCost).toBe("980.00");
    expect(withItems.costCurrency).toBe("EUR");
  });

  it("rejects a shipment line item referencing a nonexistent PO line item", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    await expect(
      createShipment({
        shipmentRef: "PO1-W4-Container2",
        warehouseId: ffWarehouseId,
        lineItems: [{ poLineItemId: 999999, skuId: sku.id, qty: 100, weightShare: "1.0", valueShare: "1.0" }],
        createdBy: 1,
      }),
    ).rejects.toThrow();
  });

  it("updateShipmentStatus rejects a nonexistent shipment id with a clear error instead of crashing on a missing row", async () => {
    await expect(updateShipmentStatus(999999, "in_transit", { changedBy: 1 })).rejects.toThrow(/no shipment found with id 999999/);
  });

  it("markShipmentDeparted rejects a nonexistent shipment id with a clear error instead of crashing on a missing row", async () => {
    await expect(markShipmentDeparted(999999, new Date(), { changedBy: 1 })).rejects.toThrow(/no shipment found with id 999999/);
  });

  it("rejects an invalid shipment status transition", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await expect(updateShipmentStatus(shipment.id, "delivered", { changedBy: 1 })).rejects.toThrow(/invalid transition/);
  });

  it("rejects transitioning to 'departed' via updateShipmentStatus even though it's listed as a valid transition — that path belongs to markShipmentDeparted only", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await expect(updateShipmentStatus(shipment.id, "departed", { changedBy: 1 })).rejects.toThrow(/markShipmentDeparted/);
  });

  it("accepts a valid shipment status transition and logs it", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });

    const updated = await getShipmentWithLineItems(shipment.id);
    expect(updated.status).toBe("in_transit");

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("status");
    expect(entries[0].newValue).toBe("in_transit");
  });

  it("markShipmentDeparted still rejects a shipment with no planned depart date, via the same transition table", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: 1 })).rejects.toThrow(/planned depart date/);
  });

  it("markShipmentDeparted rejects an invalid status transition via VALID_SHIPMENT_TRANSITIONS", async () => {
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      initialStatus: "in_transit",
      warehouseId: ffWarehouseId,
      lineItems: [],
      createdBy: 1,
    });
    // Set plannedDepartDate so the pre-existing guard passes, but status is in_transit where departed is not allowed
    await db.update(shipments).set({ plannedDepartDate: new Date() }).where(eq(shipments.id, shipment.id));

    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: 1 })).rejects.toThrow(/invalid transition/);
  });

  it("accepts an optional reason category on a status transition and logs it", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1, reasonCategory: "logistics_delay", reasonNote: undefined });

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("status");
    expect(entries[0].reasonCategory).toBe("logistics_delay");
  });

  it("still allows a status transition with no reason category (optional)", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].reasonCategory).toBeNull();
  });

  it("records a customs status change with a required reason category", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await setShipmentCustomsStatus(shipment.id, "held", { changedBy: 1, reasonCategory: "customs_hold" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.customsStatus).toBe("held");

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("customsStatus");
    expect(entries[0].oldValue).toBe("not_declared");
    expect(entries[0].newValue).toBe("held");
    expect(entries[0].reasonCategory).toBe("customs_hold");
  });

  it("records an actual arrival date with the real prior value", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );
    const arrivalDate = new Date("2026-10-15");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: 1, reasonCategory: "logistics_delay" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.actualArrivalDate?.toISOString()).toBe(arrivalDate.toISOString());

    const entries = await listChangeLog("shipment", shipment.id);
    const arrivalEntry = entries.find((e) => e.field === "actualArrivalDate");
    expect(arrivalEntry).toBeDefined();
    expect(arrivalEntry?.oldValue).toBeNull();
  });

  it("corrects an already-recorded actual depart date with a required reason category", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await db.update(shipments).set({ actualDepartDate: new Date("2026-09-01") }).where(eq(shipments.id, shipment.id));

    const correctedDate = new Date("2026-09-03");
    await correctShipmentActualDepartDate(shipment.id, correctedDate, { changedBy: 1, reasonCategory: "logistics_delay" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.actualDepartDate?.toISOString()).toBe(correctedDate.toISOString());

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("actualDepartDate");
    expect(entries[0].oldValue).toBe(new Date("2026-09-01").toISOString().slice(0, 10));
  });

  it("rejects correcting a depart date that was never set — that's a first-time set, not a correction", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 });
    await expect(
      correctShipmentActualDepartDate(shipment.id, new Date("2026-09-03"), { changedBy: 1, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow();
  });

  it("markShipmentArrived throws if freight/duty costs aren't recorded yet", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container5",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: 1, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/freight\/duty costs must be recorded first/);
  });

  it("markShipmentArrived writes one receipt ledger event per line item, at the shipment's landed cost", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container6",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    const arrivalDate = new Date("2026-09-20");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: 1, reasonCategory: "logistics_delay" });

    const soh = await getSoh(skuId, ffWarehouseId, arrivalDate);
    expect(soh).toBe(90000);

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    const receipt = events.find((e) => e.eventType === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt?.warehouseId).toBe(ffWarehouseId);
    expect(receipt?.qty).toBe(90000);
    expect(receipt?.sourceRef).toBe("PO1-W4-Container6");
    // (90000 * 0.15 EXW + 900 freight * 1.0 share + 100 duty * 1.0 share) / 90000
    expect(parseFloat(receipt?.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 900 + 100) / 90000, 4);
  });

  it("markShipmentArrived does not write a partial receipt if getShipmentLandedUnitCost throws", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container7",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });
    // seedPoWithLineItem's PO line is priced in USD; recording costs in EUR
    // creates the currency mismatch getShipmentLandedUnitCost rejects.
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: 1, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/currency/i);

    const soh = await getSoh(skuId, ffWarehouseId);
    expect(soh).toBe(0);
  });
});
