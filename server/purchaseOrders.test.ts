import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { purchaseOrders, poLineItems, skus, vendors, changeLog, users } from "../drizzle/schema";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createSku, createVendor, createUser } from "./db";

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
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(skus);
      await tx.delete(vendors);
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
});
