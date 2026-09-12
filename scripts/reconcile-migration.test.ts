import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../server/dbClient";
import { skus, vendors, warehouses, purchaseOrders, poLineItems, shipments, shipmentLineItems, payments, transactions, inventoryLedger } from "../drizzle/schema";
import { runMigration } from "./reconcile-migration";

beforeEach(async () => {
  await db.delete(inventoryLedger);
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(shipmentLineItems);
  await db.delete(shipments);
  await db.delete(poLineItems);
  await db.delete(purchaseOrders);
  await db.delete(skus);
  await db.delete(vendors);
  await db.delete(warehouses);
});

describe("runMigration (widened scope)", () => {
  it("imports POs, shipments, payments, and transactions in one pass, in FK-respecting order", async () => {
    await runMigration({
      ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
      poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "LVM-INV-1", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "150.00", expected_date: "2026-09-09", currency: "USD" }],
      transactionRows: [{ date: "2026-09-09", amount: "150.00", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Pay1" }],
      sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 1000 }],
    });

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
    expect(pos[0].vendorReference).toBe("LVM-INV-1");
    const pays = await db.select().from(payments);
    expect(pays).toHaveLength(1);
    const txs = await db.select().from(transactions);
    expect(txs[0].matchedPaymentId).toBeNull();
  });

  it("rolls back the entire migration if any part fails partway through", async () => {
    await expect(
      runMigration({
        ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
        poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        // deliberately wrong SOH to force the reconciliation gate to fail after inserts have already run
        sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 999999 }],
      }),
    ).rejects.toThrow();

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(0); // nothing committed
  });

  it("reports quarantined rows without aborting the rows that are valid", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" },
        { po_number: "PO4-BAD", vendor_name: "X", vendor_reference: "", status: "not_a_status", sku: "JELLO-CAL-500", qty: "1", unit_price: "0.15", currency: "USD" },
      ],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.purchaseOrders).toHaveLength(1);
    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
  });
});
