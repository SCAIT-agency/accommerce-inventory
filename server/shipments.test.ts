import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments, warehouses, users } from "../drizzle/schema";
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, correctShipmentReceiptQty, correctShipmentLandedCost } from "./shipments";
import { createSku, createVendor, createWarehouse, createUser } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { listChangeLog } from "./changeLog";
import { getSoh } from "./inventoryLedger";
import { inventoryLedger } from "../drizzle/schema";

let ffWarehouseId: number;
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
      await tx.delete(changeLog);
      await tx.delete(payments);
      // markShipmentArrived writes receipts here, and the correction tests
      // below write reversal/replacement rows that point at each other via
      // correctsEventId (a self-referencing FK) — so these have to go before
      // the shipmentLineItems they reference, and cannot be left for another
      // file's plain, FK-checked DELETE to trip over.
      await tx.delete(inventoryLedger);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(skus);
      await tx.delete(vendors);
      await tx.delete(warehouses);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  ffWarehouseId = ff.id;
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

async function seedPoWithLineItem() {
  const vendor = await createVendor({ name: "MBS Logistics" });
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const po = await createPurchaseOrder({
    poNumber: "PO1-W4",
    vendorId: vendor.id,
    lineItems: [{ skuId: sku.id, qty: 90000, unitPrice: "0.15", currency: "USD" }],
    createdBy: userId,
  });
  const withItems = await getPurchaseOrderWithLineItemsHelper(po.id);
  return { po, lineItemId: withItems.lineItems[0].id, skuId: sku.id };
}

// Walks a freshly created shipment through the full planned -> delivered
// sequence, so a test that only cares about the resulting ledger receipts
// doesn't repeat six setup calls.
async function driveShipmentToDelivered(shipmentId: number, arrivalDate = new Date("2026-09-20")) {
  await updateShipmentPlannedDepartDate(shipmentId, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
  await markShipmentDeparted(shipmentId, new Date("2026-09-02"), { changedBy: userId });
  await updateShipmentStatus(shipmentId, "in_transit", { changedBy: userId });
  await updateShipmentStatus(shipmentId, "customs", { changedBy: userId });
  await recordShipmentCosts(shipmentId, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
  await markShipmentArrived(shipmentId, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" });
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
      createdBy: userId,
    });
    const withItems = await getShipmentWithLineItems(shipment.id);
    expect(withItems.lineItems[0].weightShare).toBe("0.50000000");
  });

  it("records freight/duty cost on a shipment for later per-line landed-cost allocation", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    const updated = await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    expect(updated.freightCost).toBe("4200.0000");
    expect(updated.costCurrency).toBe("EUR");
  });

  it("logs change_log entries with a required reason when shipment costs are recorded", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(2);
    const freightEntry = entries.find((e) => e.field === "freightCost");
    const dutyEntry = entries.find((e) => e.field === "dutyCost");
    expect(freightEntry?.oldValue).toBeNull();
    // Normalized for audit comparison (see normalizeDecimalForAudit) — drops
    // trailing zeros from the caller-supplied "4200.00"/"980.00" strings.
    expect(freightEntry?.newValue).toBe("4200");
    expect(freightEntry?.reasonCategory).toBe("freight_rate_change");
    expect(dutyEntry?.oldValue).toBeNull();
    expect(dutyEntry?.newValue).toBe("980");
    expect(dutyEntry?.reasonCategory).toBe("freight_rate_change");
  });

  it("does not log a spurious change when recordShipmentCosts is called twice with the identical logical value", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    // Second call repeats the same logical cost values. Read back from the
    // DB, freightCost/dutyCost are now zero-padded ("4200.0000"); the raw
    // caller string here is "4200.00" — without normalization these would
    // look like a real change even though nothing changed.
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "4200.00", dutyCost: "980.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const entries = await db.select().from(changeLog).orderBy(changeLog.id);
    expect(entries).toHaveLength(4);
    const secondCallEntries = entries.slice(2);
    for (const entry of secondCallEntries) {
      expect(entry.oldValue).toBe(entry.newValue);
    }
  });

  it("blocks marking a shipment departed without a planned depart date first", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: userId })).rejects.toThrow(/planned depart date/);
  });

  it("logs actualDepartDate changes in the change_log with correct oldValue", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-10-05"), {
      reasonCategory: "logistics_delay",
      changedBy: userId,
    });
    const firstActualDate = new Date("2026-10-06");
    await markShipmentDeparted(shipment.id, firstActualDate, { changedBy: userId });

    const entries = await db.select().from(changeLog);
    const actualDepartureDateEntry = entries.find((e) => e.field === "actualDepartDate");
    expect(actualDepartureDateEntry).toBeDefined();
    expect(actualDepartureDateEntry?.oldValue).toBeNull();
    expect(actualDepartureDateEntry?.newValue).toBe(firstActualDate.toISOString().slice(0, 10));
  });

  it("logs a change_log entry with a logistics_delay reason when the planned depart date slips", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-10-05"), {
      reasonCategory: "logistics_delay",
      changedBy: userId,
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
      createdBy: userId,
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
      createdBy: userId,
    });
    const withItems = await getShipmentWithLineItems(shipment.id);
    expect(withItems.freightCost).toBe("4200.0000");
    expect(withItems.dutyCost).toBe("980.0000");
    expect(withItems.costCurrency).toBe("EUR");
  });

  it("rejects a shipment line item referencing a nonexistent PO line item", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    await expect(
      createShipment({
        shipmentRef: "PO1-W4-Container2",
        warehouseId: ffWarehouseId,
        lineItems: [{ poLineItemId: 999999, skuId: sku.id, qty: 100, weightShare: "1.0", valueShare: "1.0" }],
        createdBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("updateShipmentStatus rejects a nonexistent shipment id with a clear error instead of crashing on a missing row", async () => {
    await expect(updateShipmentStatus(999999, "in_transit", { changedBy: userId })).rejects.toThrow(/no shipment found with id 999999/);
  });

  it("markShipmentDeparted rejects a nonexistent shipment id with a clear error instead of crashing on a missing row", async () => {
    await expect(markShipmentDeparted(999999, new Date(), { changedBy: userId })).rejects.toThrow(/no shipment found with id 999999/);
  });

  it("rejects updating the planned depart date of a nonexistent shipment with a clear error", async () => {
    await expect(
      updateShipmentPlannedDepartDate(999999, new Date(), { reasonCategory: "logistics_delay", changedBy: userId }),
    ).rejects.toThrow(/no shipment found/);
  });

  it("rejects recording costs for a nonexistent shipment with a clear error", async () => {
    await expect(
      recordShipmentCosts(999999, { freightCost: "100.00", dutyCost: "50.00", costCurrency: "EUR" }, { reasonCategory: "logistics_delay", changedBy: userId }),
    ).rejects.toThrow(/no shipment found/);
  });

  it("rejects setting customs status for a nonexistent shipment with a clear error", async () => {
    await expect(
      setShipmentCustomsStatus(999999, "cleared", { reasonCategory: "customs_hold", changedBy: userId }),
    ).rejects.toThrow(/no shipment found/);
  });

  it("rejects correcting the actual depart date for a nonexistent shipment with a clear error", async () => {
    await expect(
      correctShipmentActualDepartDate(999999, new Date(), { reasonCategory: "logistics_delay", changedBy: userId }),
    ).rejects.toThrow(/no shipment found/);
  });

  it("rejects an invalid shipment status transition", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(updateShipmentStatus(shipment.id, "customs", { changedBy: userId })).rejects.toThrow(/invalid transition/);
  });

  it("rejects transitioning to 'departed' via updateShipmentStatus even though it's listed as a valid transition — that path belongs to markShipmentDeparted only", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(updateShipmentStatus(shipment.id, "departed", { changedBy: userId })).rejects.toThrow(/markShipmentDeparted/);
  });

  it("rejects transitioning to 'delivered' via updateShipmentStatus even though it's listed as a valid transition — that path belongs to markShipmentArrived only", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "customs", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(updateShipmentStatus(shipment.id, "delivered", { changedBy: userId })).rejects.toThrow(/markShipmentArrived/);
  });

  it("accepts a valid shipment status transition and logs it", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });

    const updated = await getShipmentWithLineItems(shipment.id);
    expect(updated.status).toBe("in_transit");

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("status");
    expect(entries[0].newValue).toBe("in_transit");
  });

  it("markShipmentDeparted still rejects a shipment with no planned depart date, via the same transition table", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: userId })).rejects.toThrow(/planned depart date/);
  });

  it("markShipmentDeparted rejects an invalid status transition via VALID_SHIPMENT_TRANSITIONS", async () => {
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      initialStatus: "in_transit",
      warehouseId: ffWarehouseId,
      lineItems: [],
      createdBy: userId,
    });
    // Set plannedDepartDate so the pre-existing guard passes, but status is in_transit where departed is not allowed
    await db.update(shipments).set({ plannedDepartDate: new Date() }).where(eq(shipments.id, shipment.id));

    await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: userId })).rejects.toThrow(/invalid transition/);
  });

  it("accepts an optional reason category on a status transition and logs it", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId, reasonCategory: "logistics_delay", reasonNote: undefined });

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("status");
    expect(entries[0].reasonCategory).toBe("logistics_delay");
  });

  it("still allows a status transition with no reason category (optional)", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].reasonCategory).toBeNull();
  });

  it("records a customs status change with a required reason category", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await setShipmentCustomsStatus(shipment.id, "held", { changedBy: userId, reasonCategory: "customs_hold" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.customsStatus).toBe("held");

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("customsStatus");
    expect(entries[0].oldValue).toBe("not_declared");
    expect(entries[0].newValue).toBe("held");
    expect(entries[0].reasonCategory).toBe("customs_hold");
  });

  it("records an actual arrival date with the real prior value", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "customs", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );
    const arrivalDate = new Date("2026-10-15");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.actualArrivalDate?.toISOString()).toBe(arrivalDate.toISOString());

    const entries = await listChangeLog("shipment", shipment.id);
    const arrivalEntry = entries.find((e) => e.field === "actualArrivalDate");
    expect(arrivalEntry).toBeDefined();
    expect(arrivalEntry?.oldValue).toBeNull();
  });

  it("corrects an already-recorded actual depart date with a required reason category", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await db.update(shipments).set({ actualDepartDate: new Date("2026-09-01") }).where(eq(shipments.id, shipment.id));

    const correctedDate = new Date("2026-09-03");
    await correctShipmentActualDepartDate(shipment.id, correctedDate, { changedBy: userId, reasonCategory: "logistics_delay" });

    const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updated.actualDepartDate?.toISOString()).toBe(correctedDate.toISOString());

    const entries = await listChangeLog("shipment", shipment.id);
    expect(entries[0].field).toBe("actualDepartDate");
    expect(entries[0].oldValue).toBe(new Date("2026-09-01").toISOString().slice(0, 10));
  });

  it("rejects correcting a depart date that was never set — that's a first-time set, not a correction", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await expect(
      correctShipmentActualDepartDate(shipment.id, new Date("2026-09-03"), { changedBy: userId, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow();
  });

  it("markShipmentArrived throws if freight/duty costs aren't recorded yet", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container5",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/freight\/duty costs must be recorded first/);
  });

  it("markShipmentArrived writes one receipt ledger event per line item, at the shipment's landed cost", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container6",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const arrivalDate = new Date("2026-09-20");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" });

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

    const [updatedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updatedShipment.status).toBe("delivered");
  });

  it("rejects a second markShipmentArrived call on an already-arrived shipment, without doubling the receipt", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container8",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const arrivalDate = new Date("2026-09-20");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" });
    const sohAfterFirst = await getSoh(skuId, ffWarehouseId, arrivalDate);

    await expect(
      markShipmentArrived(shipment.id, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/invalid transition from delivered to delivered/);

    const sohAfterSecond = await getSoh(skuId, ffWarehouseId, arrivalDate);
    expect(sohAfterSecond).toBe(sohAfterFirst);
  });

  it("markShipmentArrived writes two separate correct receipts when a shipment has two line items for the same SKU", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W5",
      vendorId: vendor.id,
      lineItems: [
        { skuId: sku.id, qty: 45000, unitPrice: "0.15", currency: "USD" },
        { skuId: sku.id, qty: 45000, unitPrice: "0.18", currency: "USD" },
      ],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItemsHelper(po.id);
    const [tranche1, tranche2] = withItems.lineItems;

    const shipment = await createShipment({
      shipmentRef: "PO1-W5-Container1",
      warehouseId: ffWarehouseId,
      lineItems: [
        { poLineItemId: tranche1.id, skuId: sku.id, qty: 45000, weightShare: "0.5", valueShare: "0.5" },
        { poLineItemId: tranche2.id, skuId: sku.id, qty: 45000, weightShare: "0.5", valueShare: "0.5" },
      ],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const arrivalDate = new Date("2026-09-20");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: userId, reasonCategory: "logistics_delay" });

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    const receipts = events.filter((e) => e.eventType === "receipt");
    expect(receipts).toHaveLength(2);

    // Each tranche carries its own freight/duty allocation: 0.5 weightShare of 900 freight (450)
    // plus 0.5 valueShare of 100 duty (50) = 500, on top of its own EXW price.
    const expectedCost1 = (45000 * 0.15 + 500) / 45000;
    const expectedCost2 = (45000 * 0.18 + 500) / 45000;
    const costs = receipts.map((r) => parseFloat(r.unitCost ?? "0")).sort((a, b) => a - b);
    expect(costs[0]).toBeCloseTo(Math.min(expectedCost1, expectedCost2), 6);
    expect(costs[1]).toBeCloseTo(Math.max(expectedCost1, expectedCost2), 6);

    const soh = await getSoh(sku.id, ffWarehouseId, arrivalDate);
    expect(soh).toBe(90000);
  });

  it("markShipmentArrived does not write a partial receipt if getShipmentLandedUnitCost throws", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container7",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    // seedPoWithLineItem's PO line is priced in USD; recording costs in EUR
    // creates the currency mismatch getShipmentLandedUnitCost rejects.
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/currency/i);

    const soh = await getSoh(skuId, ffWarehouseId);
    expect(soh).toBe(0);
  });

  it("markShipmentArrived records lineItemId on every receipt event it writes", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container9",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const [receipt] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    expect(receipt.lineItemId).toBe(lineItems[0].id);
  });

  it("correctShipmentReceiptQty corrects a wrong receipt quantity via the shipment + line item", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container10",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const result = await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 89000, {
      changedBy: userId,
      reasonNote: "recount found 1000 short",
    });

    expect(result.consumedFromOtherBatches).toBe(false);
    expect(await getSoh(skuId, ffWarehouseId)).toBe(89000);
  });

  it("correctShipmentReceiptQty corrects the same line item a second time, via the first correction's replacement receipt", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container11",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const first = await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 89000, {
      changedBy: userId,
      reasonNote: "recount found 1000 short",
    });
    expect(await getSoh(skuId, ffWarehouseId)).toBe(89000);

    // The replacement receipt the first correction wrote carries a non-null
    // correctsEventId. It is nonetheless the line item's current, eligible
    // receipt — a second correction must find and correct it, not report
    // "no uncorrected receipt found".
    const second = await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 88000, {
      changedBy: userId,
      reasonNote: "second recount, 1000 short again",
    });

    expect(second.consumedFromOtherBatches).toBe(false);
    expect(await getSoh(skuId, ffWarehouseId)).toBe(88000);

    const [secondReversal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, second.reversalId));
    // The second correction reversed the FIRST correction's replacement
    // receipt (89000), not the original 90000 one.
    expect(secondReversal.correctsEventId).toBe(first.correctedId);
    expect(secondReversal.qty).toBe(-89000);
  });

  it("correctShipmentReceiptQty disambiguates two line items sharing one SKU on the same shipment", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po1 = await createPurchaseOrder({ poNumber: "PO1", vendorId: vendor.id, lineItems: [{ skuId: sku.id, qty: 50000, unitPrice: "0.15", currency: "USD" }], createdBy: userId });
    const po2 = await createPurchaseOrder({ poNumber: "PO2", vendorId: vendor.id, lineItems: [{ skuId: sku.id, qty: 40000, unitPrice: "0.16", currency: "USD" }], createdBy: userId });
    const po1WithItems = await getPurchaseOrderWithLineItemsHelper(po1.id);
    const po2WithItems = await getPurchaseOrderWithLineItemsHelper(po2.id);

    const shipment = await createShipment({
      shipmentRef: "Pooled-Container1",
      warehouseId: ffWarehouseId,
      lineItems: [
        { poLineItemId: po1WithItems.lineItems[0].id, skuId: sku.id, qty: 50000, weightShare: "0.55555556", valueShare: "0.55172414" },
        { poLineItemId: po2WithItems.lineItems[0].id, skuId: sku.id, qty: 40000, weightShare: "0.44444444", valueShare: "0.44827586" },
      ],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const firstLine = lineItems.find((li) => li.qty === 50000)!;
    const secondLine = lineItems.find((li) => li.qty === 40000)!;

    // Correcting only the first line item must leave the second untouched --
    // proving lineItemId, not skuId, disambiguated which receipt to correct.
    await correctShipmentReceiptQty(shipment.id, firstLine.id, 49000, { changedBy: userId, reasonNote: "recount" });

    expect(await getSoh(sku.id, ffWarehouseId)).toBe(49000 + 40000);
    const secondLineReceipts = await db
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.lineItemId, secondLine.id), eq(inventoryLedger.eventType, "receipt")));
    expect(secondLineReceipts).toHaveLength(1);
    expect(secondLineReceipts[0].correctsEventId).toBeNull();
  });

  it("correctShipmentReceiptQty rejects a nonexistent shipment/line item combination", async () => {
    await expect(
      correctShipmentReceiptQty(999999, 999999, 10, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no shipment found with id 999999/);

    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container12",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await expect(
      correctShipmentReceiptQty(shipment.id, 999999, 10, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no line item 999999 found on shipment/);

    // Real shipment, real line item, but nothing has arrived yet — so no
    // receipt exists to correct.
    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    await expect(
      correctShipmentReceiptQty(shipment.id, lineItems[0].id, 10, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no uncorrected receipt found/);
  });

  it("correctShipmentLandedCost recomputes and corrects landed cost for every line item after a freight/duty restatement", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container13",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const result = await correctShipmentLandedCost(
      shipment.id,
      { freightCost: "1800.00" },
      { changedBy: userId, reasonNote: "real freight invoice arrived, double the estimate" },
    );

    expect(result.corrections).toHaveLength(1);
    const [updatedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updatedShipment.freightCost).toBe("1800.0000");
    // dutyCost wasn't passed — it must survive untouched, and still be
    // allocated into the recomputed landed cost below.
    expect(updatedShipment.dutyCost).toBe("100.0000");

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    const correctedReceipt = events.find((e) => e.id === result.corrections[0].correctedId)!;
    // (90000 * 0.15 EXW + 1800 freight * 1.0 share + 100 duty * 1.0 share) / 90000
    expect(parseFloat(correctedReceipt.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 1800 + 100) / 90000, 4);
    // A cost-only correction reverses and re-receives the same quantity.
    expect(await getSoh(skuId, ffWarehouseId)).toBe(90000);

    const history = await listChangeLog("shipment", shipment.id);
    const freightEntry = history.find((h) => h.field === "freightCost" && h.reasonCategory === "data_correction");
    expect(freightEntry).toBeDefined();
    expect(freightEntry?.oldValue).toBe("900");
    expect(freightEntry?.newValue).toBe("1800");
    // dutyCost wasn't part of this restatement, so it must not be audited as
    // one — only the fields actually passed are written and logged.
    expect(history.some((h) => h.field === "dutyCost" && h.reasonCategory === "data_correction")).toBe(false);
  });

  it("correctShipmentLandedCost corrects every line item on a multi-line shipment, each with its own share", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const sku1 = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const sku2 = await createSku({ sku: "JELLO-STRAW-100", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W5",
      vendorId: vendor.id,
      lineItems: [
        { skuId: sku1.id, qty: 50000, unitPrice: "0.15", currency: "USD" },
        { skuId: sku2.id, qty: 40000, unitPrice: "0.16", currency: "USD" },
      ],
      createdBy: userId,
    });
    const poWithItems = await getPurchaseOrderWithLineItemsHelper(po.id);
    const poLine1 = poWithItems.lineItems.find((li) => li.skuId === sku1.id)!;
    const poLine2 = poWithItems.lineItems.find((li) => li.skuId === sku2.id)!;
    const shipment = await createShipment({
      shipmentRef: "PO1-W5-Container1",
      warehouseId: ffWarehouseId,
      lineItems: [
        { poLineItemId: poLine1.id, skuId: sku1.id, qty: 50000, weightShare: "0.6", valueShare: "0.5" },
        { poLineItemId: poLine2.id, skuId: sku2.id, qty: 40000, weightShare: "0.4", valueShare: "0.5" },
      ],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const result = await correctShipmentLandedCost(
      shipment.id,
      { freightCost: "1800.00", dutyCost: "200.00" },
      { changedBy: userId, reasonNote: "final forwarder invoice and customs assessment" },
    );

    expect(result.corrections).toHaveLength(2);
    const correctedIds = new Set(result.corrections.map((c) => c.correctedId));
    const events = await db.select().from(inventoryLedger);
    const corrected = events.filter((e) => correctedIds.has(e.id));
    const forSku1 = corrected.find((e) => e.skuId === sku1.id)!;
    const forSku2 = corrected.find((e) => e.skuId === sku2.id)!;
    expect(parseFloat(forSku1.unitCost ?? "0")).toBeCloseTo((50000 * 0.15 + 1800 * 0.6 + 200 * 0.5) / 50000, 6);
    expect(parseFloat(forSku2.unitCost ?? "0")).toBeCloseTo((40000 * 0.16 + 1800 * 0.4 + 200 * 0.5) / 40000, 6);
    expect(await getSoh(sku1.id, ffWarehouseId)).toBe(50000);
    expect(await getSoh(sku2.id, ffWarehouseId)).toBe(40000);
  });

  it("correctShipmentLandedCost corrects a line item that was already corrected once, via its replacement receipt", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container14",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const qtyCorrection = await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 89000, {
      changedBy: userId,
      reasonNote: "recount found 1000 short",
    });

    // The qty correction's replacement receipt carries a non-null
    // correctsEventId but is the line item's current, still-correctable
    // receipt — a landed-cost restatement must correct THAT one, not report
    // "no uncorrected receipt found".
    const result = await correctShipmentLandedCost(
      shipment.id,
      { dutyCost: "200.00" },
      { changedBy: userId, reasonNote: "customs re-assessed the duty" },
    );

    expect(result.corrections).toHaveLength(1);
    const [reversal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.corrections[0].reversalId));
    expect(reversal.correctsEventId).toBe(qtyCorrection.correctedId);
    expect(reversal.qty).toBe(-89000);
    const [correctedReceipt] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.corrections[0].correctedId));
    // Qty carries over from the receipt being corrected (89000, not the
    // original 90000); only the unit cost changes.
    expect(correctedReceipt.qty).toBe(89000);
    expect(parseFloat(correctedReceipt.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 900 + 200) / 90000, 6);
    expect(await getSoh(skuId, ffWarehouseId)).toBe(89000);
  });

  it("correctShipmentLandedCost rolls back entirely if one line item's correction fails", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container15",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    // A second line item added to the shipment AFTER it was delivered: it
    // carries no ledger receipt, so correctShipmentLandedCost finds zero
    // candidates for it and must fail the whole transaction. Zero freight/
    // value shares keep the share sums at 1, so the recompute itself is valid
    // and the failure is genuinely the missing receipt.
    await db.insert(shipmentLineItems).values({
      shipmentId: shipment.id,
      poLineItemId: lineItemId,
      skuId,
      qty: 1000,
      weightShare: "0",
      valueShare: "0",
    });

    await expect(
      correctShipmentLandedCost(shipment.id, { dutyCost: "200.00" }, { changedBy: userId, reasonNote: "test rollback" }),
    ).rejects.toThrow(/no uncorrected receipt found/);

    // freightCost/dutyCost on the shipments row must be unchanged — the
    // update inside the failed transaction must have rolled back too.
    const [unchangedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchangedShipment.dutyCost).toBe("100.0000");
    expect(unchangedShipment.freightCost).toBe("900.0000");
    // Nor may the audit trail or the ledger keep anything: whichever order the
    // loop visited the two line items in, no correction rows survive.
    const history = await listChangeLog("shipment", shipment.id);
    expect(history.some((h) => h.reasonCategory === "data_correction")).toBe(false);
    const events = await db.select().from(inventoryLedger);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("receipt");
    expect(events[0].correctsEventId).toBeNull();
    expect(await getSoh(skuId, ffWarehouseId)).toBe(90000);
  });

  // Shared fixture for the skip/rollback pair below: a delivered two-line
  // shipment whose second line carries a zero weight share, so a freight-only
  // restatement provably cannot move its landed cost.
  async function seedShipmentWithAZeroFreightShareLine(shipmentRef: string) {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const movingSku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const unchangedSku = await createSku({ sku: "JELLO-STRAW-100", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W6",
      vendorId: vendor.id,
      lineItems: [
        { skuId: movingSku.id, qty: 50000, unitPrice: "0.15", currency: "USD" },
        { skuId: unchangedSku.id, qty: 40000, unitPrice: "0.16", currency: "USD" },
      ],
      createdBy: userId,
    });
    const poWithItems = await getPurchaseOrderWithLineItemsHelper(po.id);
    const movingPoLine = poWithItems.lineItems.find((li) => li.skuId === movingSku.id)!;
    const unchangedPoLine = poWithItems.lineItems.find((li) => li.skuId === unchangedSku.id)!;
    const shipment = await createShipment({
      shipmentRef,
      warehouseId: ffWarehouseId,
      lineItems: [
        { poLineItemId: movingPoLine.id, skuId: movingSku.id, qty: 50000, weightShare: "1.00000000", valueShare: "0.5" },
        // All of the freight is allocated to the first line, so restating
        // freight alone leaves this line's landed cost exactly where it is.
        { poLineItemId: unchangedPoLine.id, skuId: unchangedSku.id, qty: 40000, weightShare: "0.00000000", valueShare: "0.5" },
      ],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);
    return { shipment, movingSku, unchangedSku, unchangedPoLineId: unchangedPoLine.id };
  }

  it("correctShipmentLandedCost skips a line whose landed cost is unchanged instead of failing the whole restatement", async () => {
    const { shipment, movingSku, unchangedSku } = await seedShipmentWithAZeroFreightShareLine("PO1-W6-Container1");

    const [unchangedReceiptBefore] = await db
      .select()
      .from(inventoryLedger)
      .where(eq(inventoryLedger.skuId, unchangedSku.id));

    const result = await correctShipmentLandedCost(
      shipment.id,
      { freightCost: "1800.00" },
      { changedBy: userId, reasonNote: "final forwarder invoice" },
    );

    // Only the line whose cost actually moved is corrected. The zero-share
    // line is skipped, not failed -- and not silently reported as corrected.
    expect(result.corrections).toHaveLength(1);
    const [correctedReceipt] = await db
      .select()
      .from(inventoryLedger)
      .where(eq(inventoryLedger.id, result.corrections[0].correctedId));
    expect(correctedReceipt.skuId).toBe(movingSku.id);
    expect(parseFloat(correctedReceipt.unitCost ?? "0")).toBeCloseTo((50000 * 0.15 + 1800 * 1 + 100 * 0.5) / 50000, 6);

    // The skipped line's receipt is provably untouched: same row, same id,
    // same cost, and no reversal/replacement written against it.
    const unchangedEvents = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, unchangedSku.id));
    expect(unchangedEvents).toHaveLength(1);
    expect(unchangedEvents[0].id).toBe(unchangedReceiptBefore.id);
    expect(unchangedEvents[0].eventType).toBe("receipt");
    expect(unchangedEvents[0].correctsEventId).toBeNull();
    expect(unchangedEvents[0].unitCost).toBe(unchangedReceiptBefore.unitCost);
    expect(await getSoh(unchangedSku.id, ffWarehouseId)).toBe(40000);
    expect(await getSoh(movingSku.id, ffWarehouseId)).toBe(50000);

    // The restatement itself is committed and audited normally regardless of
    // how many lines needed a ledger correction.
    const [updatedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updatedShipment.freightCost).toBe("1800.0000");
    const history = await listChangeLog("shipment", shipment.id);
    const freightEntry = history.find((h) => h.field === "freightCost" && h.reasonCategory === "data_correction");
    expect(freightEntry?.oldValue).toBe("900");
    expect(freightEntry?.newValue).toBe("1800");
  });

  it("correctShipmentLandedCost still rolls the whole restatement back when a line fails for a reason other than being a no-op", async () => {
    const { shipment, movingSku, unchangedSku, unchangedPoLineId } =
      await seedShipmentWithAZeroFreightShareLine("PO1-W6-Container2");

    // A third line item added AFTER delivery: no ledger receipt exists for it,
    // which is NOT a no-op refusal. Skipping the zero-share line must not
    // widen into swallowing this one.
    await db.insert(shipmentLineItems).values({
      shipmentId: shipment.id,
      poLineItemId: unchangedPoLineId,
      skuId: unchangedSku.id,
      qty: 1000,
      weightShare: "0.00000000",
      valueShare: "0.00000000",
    });

    await expect(
      correctShipmentLandedCost(shipment.id, { freightCost: "1800.00" }, { changedBy: userId, reasonNote: "test rollback" }),
    ).rejects.toThrow(/no uncorrected receipt found/);

    const [unchangedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchangedShipment.freightCost).toBe("900.0000");
    const history = await listChangeLog("shipment", shipment.id);
    expect(history.some((h) => h.reasonCategory === "data_correction")).toBe(false);
    // Both original receipts survive untouched -- including the line that had
    // already been corrected before the failing line was reached.
    const events = await db.select().from(inventoryLedger);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === "receipt" && e.correctsEventId === null)).toBe(true);
    expect(await getSoh(movingSku.id, ffWarehouseId)).toBe(50000);
    expect(await getSoh(unchangedSku.id, ffWarehouseId)).toBe(40000);
  });

  it("correctShipmentLandedCost refuses a call that restates no cost field at all", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container16",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    await expect(
      correctShipmentLandedCost(shipment.id, {}, { changedBy: userId, reasonNote: "nothing to change" }),
    ).rejects.toThrow(/no cost fields provided/);
    // An explicit `undefined` is the same request as an empty object — it must
    // not reach the UPDATE as a column-less write.
    await expect(
      correctShipmentLandedCost(shipment.id, { freightCost: undefined }, { changedBy: userId, reasonNote: "nothing to change" }),
    ).rejects.toThrow(/no cost fields provided/);

    await expect(
      correctShipmentLandedCost(999999, { dutyCost: "10.00" }, { changedBy: userId, reasonNote: "no such shipment" }),
    ).rejects.toThrow(/no shipment found with id 999999/);
  });
});
