// server/decimalMigration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { skus, warehouses, poLineItems, purchaseOrders, vendors, shipments, shipmentLineItems, payments, transactions, inventoryLedger, users } from "../drizzle/schema";
import { createSku, createVendor, createWarehouse, createUser } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { createShipment } from "./shipments";
import { createExpectedPayment, markPaymentPaid, recordTransaction } from "./payments";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(transactions);
      await tx.delete(payments);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(inventoryLedger);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(vendors);
      await tx.delete(skus);
      await tx.delete(warehouses);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("decimal column migration round-trips every value at its real precision", () => {
  it("unitCost survives a 6-decimal write exactly", async () => {
    const sku = await createSku({ sku: "JELLO-DECIMAL-TEST", primaryIdentifierType: "sku" });
    const wh = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: wh.id, eventType: "receipt", qty: 100, unitCost: "0.123456", date: new Date(), sourceRef: "TEST" });
    const [row] = await db.select().from(inventoryLedger).where(sql`${inventoryLedger.skuId} = ${sku.id}`);
    expect(row.unitCost).toBe("0.123456");
  });

  it("payment fxRate/paidAmount/baseCurrencyAmount survive a real markPaymentPaid write exactly", async () => {
    const user = await createUser({ email: "decimal-migration-test-1@accommerce.example", role: "editor" });
    const vendor = await createVendor({ name: "Test Vendor" });
    const po = await createPurchaseOrder({ poNumber: "PO-DECIMAL-TEST", vendorId: vendor.id, lineItems: [], createdBy: user.id });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "1234.56", expectedDate: new Date(), currency: "USD" });
    const paid = await markPaymentPaid(payment.id, { amount: "1234.56", fxRate: "0.860000", paidDate: new Date(), reasonCategory: "payment_timing", changedBy: user.id });
    expect(paid.paidAmount).toBe("1234.5600");
    expect(paid.fxRate).toBe("0.860000");
    expect(paid.baseCurrencyAmount).toBe("1061.7200");
  });

  it("shipment weightShare/valueShare survive a real createShipment write exactly", async () => {
    const user = await createUser({ email: "decimal-migration-test-2@accommerce.example", role: "editor" });
    const vendor = await createVendor({ name: "Test Vendor" });
    const po = await createPurchaseOrder({ poNumber: "PO-DECIMAL-TEST-2", vendorId: vendor.id, lineItems: [], createdBy: user.id });
    const sku = await createSku({ sku: "JELLO-DECIMAL-TEST-2", primaryIdentifierType: "sku" });
    const wh = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const [poLine] = await db.insert(poLineItems).values({ poId: po.id, skuId: sku.id, qty: 100, unitPrice: "1.234567", currency: "USD" });
    const shipment = await createShipment({
      shipmentRef: "SHIP-DECIMAL-TEST", warehouseId: wh.id, createdBy: user.id,
      lineItems: [{ poLineItemId: poLine.insertId, skuId: sku.id, qty: 100, weightShare: "0.333333", valueShare: "0.666667" }],
    });
    const [line] = await db.select().from(shipmentLineItems).where(sql`${shipmentLineItems.shipmentId} = ${shipment.id}`);
    expect(line.weightShare).toBe("0.333333");
    expect(line.valueShare).toBe("0.666667");
  });
});
