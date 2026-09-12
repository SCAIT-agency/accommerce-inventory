import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { purchaseOrders, poLineItems, skus, vendors, changeLog } from "../drizzle/schema";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createSku, createVendor } from "./db";

beforeEach(async () => {
  await db.delete(changeLog);
  await db.delete(poLineItems);
  await db.delete(purchaseOrders);
  await db.delete(skus);
  await db.delete(vendors);
});

describe("purchase orders", () => {
  it("creates a draft PO with line items", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });

    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 200000, unitPrice: "0.15", currency: "USD" }],
      createdBy: 1,
    });

    expect(po.status).toBe("draft");
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    expect(withItems.lineItems).toHaveLength(1);
  });

  it("logs a change_log entry with the required reason when the planned ready date slips", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await updatePurchaseOrderPlannedReadyDate(po.id, new Date("2026-10-08"), {
      reasonCategory: "artwork_delay",
      changedBy: 1,
    });

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].reasonCategory).toBe("artwork_delay");
  });

  it("rejects an invalid status transition", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    await expect(updatePurchaseOrderStatus(po.id, "closed", { changedBy: 1 })).rejects.toThrow(/invalid transition/);
  });

  it("accepts an optional vendor reference and initial status for migration use", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      vendorReference: "LVM-INV-2026-0912",
      initialStatus: "shipped",
      lineItems: [],
      createdBy: 1,
    });
    expect(po.vendorReference).toBe("LVM-INV-2026-0912");
    expect(po.status).toBe("shipped");
  });

  it("defaults to draft status and a null vendor reference when neither is given", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO-2", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    expect(po.status).toBe("draft");
    expect(po.vendorReference).toBeNull();
  });
});
