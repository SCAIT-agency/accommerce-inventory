import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { purchaseOrders, poLineItems, skus, vendors, changeLog, users } from "../drizzle/schema";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createSku, createVendor, createUser } from "./db";

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
});

describe("purchase orders", () => {
  it("creates a draft PO with line items", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });

    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 200000, unitPrice: "0.15", currency: "USD" }],
      createdBy: user.id,
    });

    expect(po.status).toBe("draft");
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    expect(withItems.lineItems).toHaveLength(1);
  });

  it("logs a change_log entry with the required reason when the planned ready date slips", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: user.id });

    await updatePurchaseOrderPlannedReadyDate(po.id, "2026-10-08", {
      reasonCategory: "artwork_delay",
      changedBy: user.id,
    });

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].reasonCategory).toBe("artwork_delay");
  });

  it("stores and reads back a planned ready date as an exact calendar day, no time-of-day drift", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: user.id });

    await updatePurchaseOrderPlannedReadyDate(po.id, "2026-12-31", { reasonCategory: "artwork_delay", changedBy: user.id });

    const updated = await getPurchaseOrderWithLineItems(po.id);
    expect(updated.plannedReadyDate).toBe("2026-12-31");
  });

  it("rejects an invalid status transition", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: user.id });
    await expect(updatePurchaseOrderStatus(po.id, "closed", { changedBy: user.id })).rejects.toThrow(/invalid transition/);
  });

  it("accepts an optional vendor reference and initial status for migration use", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    const po = await createPurchaseOrder({
      poNumber: "PO3-JELLO",
      vendorId: vendor.id,
      vendorReference: "LVM-INV-2026-0912",
      initialStatus: "shipped",
      lineItems: [],
      createdBy: user.id,
    });
    expect(po.vendorReference).toBe("LVM-INV-2026-0912");
    expect(po.status).toBe("shipped");
  });

  it("defaults to draft status and a null vendor reference when neither is given", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO-2", vendorId: vendor.id, lineItems: [], createdBy: user.id });
    expect(po.status).toBe("draft");
    expect(po.vendorReference).toBeNull();
  });

  it("rejects updating the status of a nonexistent purchase order with a clear error", async () => {
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    await expect(
      updatePurchaseOrderStatus(999999, "confirmed", { changedBy: user.id }),
    ).rejects.toThrow(/no purchase order found/);
  });

  it("rejects updating the planned ready date of a nonexistent purchase order with a clear error", async () => {
    const user = await createUser({ email: "test@accommerce.example", role: "editor" });
    await expect(
      updatePurchaseOrderPlannedReadyDate(999999, "2026-10-01", { reasonCategory: "logistics_delay", changedBy: user.id }),
    ).rejects.toThrow(/no purchase order found/);
  });
});
