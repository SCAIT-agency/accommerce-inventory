import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db } from "./dbClient";
import { purchaseOrders, poLineItems, skus, vendors, changeLog, users, shipments, shipmentLineItems, warehouses } from "../drizzle/schema";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, updatePurchaseOrderActualReadyDate, updatePurchaseOrderLinks, updatePoLineItemCostComponents, updatePoLineItemProduction, getPoLineItemProductionProgress, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createSku, createVendor, createUser, createWarehouse } from "./db";
import { createShipment } from "./shipments";

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
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

describe("purchase orders", () => {
  it("creates a draft PO with line items", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });

    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 200000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });

    expect(po.status).toBe("draft");
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    expect(withItems.lineItems).toHaveLength(1);
  });

  it("logs a change_log entry with the required reason when the planned ready date slips", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await updatePurchaseOrderPlannedReadyDate(po.id, "2026-10-08", {
      reasonCategory: "artwork_delay",
      changedBy: userId,
    });

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].reasonCategory).toBe("artwork_delay");
  });

  it("stores and reads back a planned ready date as an exact calendar day, no time-of-day drift", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await updatePurchaseOrderPlannedReadyDate(po.id, "2026-12-31", { reasonCategory: "artwork_delay", changedBy: userId });

    const updated = await getPurchaseOrderWithLineItems(po.id);
    expect(updated.plannedReadyDate).toBe("2026-12-31");
  });

  it("updates the status field and logs a matching change_log row", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await updatePurchaseOrderStatus(po.id, "confirmed", { reasonCategory: "vendor_price_change", changedBy: userId });

    const updated = await getPurchaseOrderWithLineItems(po.id);
    expect(updated.status).toBe("confirmed");

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].field).toBe("status");
    expect(entries[0].oldValue).toBe("draft");
    expect(entries[0].newValue).toBe("confirmed");
    expect(entries[0].reasonCategory).toBe("vendor_price_change");
  });

  it("rejects an invalid status transition", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    await expect(updatePurchaseOrderStatus(po.id, "closed", { changedBy: userId })).rejects.toThrow(/invalid transition/);
  });

  it("accepts an optional vendor reference and initial status for migration use", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      vendorReference: "LVM-INV-2026-0912",
      initialStatus: "shipped",
      lineItems: [],
      createdBy: userId,
    });
    expect(po.vendorReference).toBe("LVM-INV-2026-0912");
    expect(po.status).toBe("shipped");
  });

  it("defaults to draft status and a null vendor reference when neither is given", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO-2", vendorId: vendor.id, lineItems: [], createdBy: userId });
    expect(po.status).toBe("draft");
    expect(po.vendorReference).toBeNull();
  });

  it("rejects updating the status of a nonexistent purchase order with a clear error", async () => {
    await expect(
      updatePurchaseOrderStatus(999999, "confirmed", { changedBy: userId }),
    ).rejects.toThrow(/no purchase order found/);
  });

  it("rejects updating the planned ready date of a nonexistent purchase order with a clear error", async () => {
    await expect(
      updatePurchaseOrderPlannedReadyDate(999999, "2026-10-01", { reasonCategory: "logistics_delay", changedBy: userId }),
    ).rejects.toThrow(/no purchase order found/);
  });

  it("rejects getPurchaseOrderWithLineItems for a nonexistent purchase order with a clear error", async () => {
    await expect(getPurchaseOrderWithLineItems(999999)).rejects.toThrow(/no purchase order found with id 999999/);
  });

  it("updatePurchaseOrderLinks sets the reference link fields, unaudited", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    const updated = await updatePurchaseOrderLinks(po.id, {
      contractLink: "https://drive.google.com/contract",
      invoiceLink: "https://drive.google.com/invoice",
      addOnLink: "https://drive.google.com/addon",
    });

    expect(updated.contractLink).toBe("https://drive.google.com/contract");
    expect(updated.invoiceLink).toBe("https://drive.google.com/invoice");
    expect(updated.addOnLink).toBe("https://drive.google.com/addon");
    const history = await db.select().from(changeLog).where(eq(changeLog.entityId, po.id));
    expect(history).toHaveLength(0);
  });

  it("updatePurchaseOrderLinks only updates the fields actually passed, leaving others untouched", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    await updatePurchaseOrderLinks(po.id, { contractLink: "https://drive.google.com/contract" });

    const updated = await updatePurchaseOrderLinks(po.id, { invoiceLink: "https://drive.google.com/invoice" });

    expect(updated.contractLink).toBe("https://drive.google.com/contract");
    expect(updated.invoiceLink).toBe("https://drive.google.com/invoice");
  });

  it("rejects updatePurchaseOrderLinks for a nonexistent purchase order with a clear error", async () => {
    await expect(
      updatePurchaseOrderLinks(999999, { contractLink: "https://drive.google.com/contract" }),
    ).rejects.toThrow(/no purchase order found with id 999999/);
  });

  it("updatePoLineItemCostComponents recomputes unitPrice as the sum of all 4 components", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const updated = await updatePoLineItemCostComponents(
      line.id,
      { exwUnitPrice: "0.10", labTestUnitPrice: "0.02", inspectionUnitPrice: "0.01", addOnUnitPrice: "0.005" },
      { changedBy: userId, reasonNote: "final factory invoice breakdown" },
    );

    expect(updated.exwUnitPrice).toBe("0.10000000");
    expect(updated.labTestUnitPrice).toBe("0.02000000");
    expect(updated.inspectionUnitPrice).toBe("0.01000000");
    expect(updated.addOnUnitPrice).toBe("0.00500000");
    expect(parseFloat(updated.unitPrice)).toBeCloseTo(0.10 + 0.02 + 0.01 + 0.005, 8);
  });

  it("updatePoLineItemCostComponents merges with previously-set components instead of resetting them", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    await updatePoLineItemCostComponents(line.id, { exwUnitPrice: "0.10" }, { changedBy: userId, reasonNote: "EXW confirmed" });

    const updated = await updatePoLineItemCostComponents(line.id, { labTestUnitPrice: "0.02" }, { changedBy: userId, reasonNote: "lab test invoice arrived" });

    expect(updated.exwUnitPrice).toBe("0.10000000");
    expect(updated.labTestUnitPrice).toBe("0.02000000");
    expect(parseFloat(updated.unitPrice)).toBeCloseTo(0.12, 8);
  });

  it("updatePoLineItemCostComponents logs an audited change on the parent purchase order", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    await updatePoLineItemCostComponents(line.id, { exwUnitPrice: "0.10" }, { changedBy: userId, reasonCategory: "vendor_price_change", reasonNote: "renegotiated EXW" });

    const history = await db.select().from(changeLog).where(eq(changeLog.entityId, po.id));
    const entry = history.find((h) => h.field === "exwUnitPrice");
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe("purchase_order");
    expect(entry?.reasonCategory).toBe("vendor_price_change");
    expect(entry?.reasonNote).toBe("renegotiated EXW");
  });

  it("rejects updatePoLineItemCostComponents for a nonexistent line item with a clear error", async () => {
    await expect(
      updatePoLineItemCostComponents(999999, { exwUnitPrice: "0.10" }, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no PO line item found with id 999999/);
  });

  it("updatePoLineItemProduction sets qtyProduced and logs an audited change on the parent purchase order", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const updated = await updatePoLineItemProduction(line.id, 400, { changedBy: userId, reasonCategory: "production_delay", reasonNote: "first batch off the line" });

    expect(updated.qtyProduced).toBe(400);
    const history = await db.select().from(changeLog).where(eq(changeLog.entityId, po.id));
    const entry = history.find((h) => h.field === "qtyProduced");
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe("purchase_order");
    expect(entry?.oldValue).toBeNull();
    expect(entry?.newValue).toBe("400");
    expect(entry?.reasonCategory).toBe("production_delay");
  });

  it("rejects a negative or non-integer qtyProduced", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    await expect(
      updatePoLineItemProduction(line.id, -5, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/must be a non-negative whole number/);
    await expect(
      updatePoLineItemProduction(line.id, 4.5, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/must be a non-negative whole number/);
  });

  it("rejects updatePoLineItemProduction for a nonexistent line item with a clear error", async () => {
    await expect(
      updatePoLineItemProduction(999999, 100, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no PO line item found with id 999999/);
  });

  it("getPoLineItemProductionProgress computes remaining-to-produce and remaining-to-ship from real shipment line items", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
    await updatePoLineItemProduction(line.id, 700, { changedBy: userId, reasonNote: "700 produced so far" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await createShipment({
      shipmentRef: "PO3-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: line.id, skuId: sku.id, qty: 300, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });

    const progress = await getPoLineItemProductionProgress(line.id);

    expect(progress).toEqual({
      qtyOrdered: 1000,
      qtyProduced: 700,
      qtyRemainingToProduce: 300,
      qtyShipped: 300,
      qtyRemainingToShip: 400,
    });
  });

  it("getPoLineItemProductionProgress treats an unset qtyProduced as 0", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const [line] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const progress = await getPoLineItemProductionProgress(line.id);

    expect(progress).toEqual({
      qtyOrdered: 1000,
      qtyProduced: 0,
      qtyRemainingToProduce: 1000,
      qtyShipped: 0,
      qtyRemainingToShip: 0,
    });
  });

  it("rejects getPoLineItemProductionProgress for a nonexistent line item with a clear error", async () => {
    await expect(getPoLineItemProductionProgress(999999)).rejects.toThrow(/no PO line item found with id 999999/);
  });

  it("updatePurchaseOrderActualReadyDate logs a change_log entry with the required reason", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await updatePurchaseOrderActualReadyDate(po.id, "2026-10-08", { reasonCategory: "production_delay", changedBy: userId });

    const [updated] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    expect(updated.actualReadyDate).toBe("2026-10-08");
    const entries = await db.select().from(changeLog).where(eq(changeLog.entityId, po.id));
    expect(entries.find((e) => e.field === "actualReadyDate")?.reasonCategory).toBe("production_delay");
  });

  it("rejects updatePurchaseOrderActualReadyDate for a nonexistent purchase order with a clear error", async () => {
    await expect(
      updatePurchaseOrderActualReadyDate(999999, "2026-10-01", { reasonCategory: "logistics_delay", changedBy: userId }),
    ).rejects.toThrow(/no purchase order found/);
  });
});
