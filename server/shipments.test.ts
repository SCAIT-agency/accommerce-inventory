import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments, warehouses, users } from "../drizzle/schema";
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate } from "./shipments";
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
});
