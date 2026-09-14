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

  // Finding 1: landed-cost reconciliation isn't wired to a real data source yet —
  // silently accepting landedCostTotals and running zero comparisons would be
  // misleading ("Migration complete" with nothing actually checked).
  it("throws when landedCostTotals is provided and non-empty, instead of silently no-opping the check", async () => {
    await expect(
      runMigration({
        ledgerRows: [],
        poRows: [],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        sheetTotals: [],
        landedCostTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", landedCostFromSheet: 1000 }],
      }),
    ).rejects.toThrow(/landed-cost reconciliation is not yet wired/);
  });

  it("does not throw when landedCostTotals is omitted or empty", async () => {
    await expect(
      runMigration({
        ledgerRows: [],
        poRows: [],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        sheetTotals: [],
        landedCostTotals: [],
      }),
    ).resolves.toBeDefined();
  });

  // Finding 4: a receipt appearing after its corresponding sale in source row
  // order (but dated earlier) must still land in the ledger before the sale is
  // checked against SOH — otherwise the negative-stock guard spuriously fails.
  it("migrates ledger rows successfully even when given in reverse-chronological source order", async () => {
    const result = await runMigration({
      ledgerRows: [
        // sale row appears FIRST in the array, but its date is AFTER the receipt's date
        { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "sale", qty: "-30", unit_cost: "", date: "2026-09-02", source_ref: "shopify-2026-09-02" },
        { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "50", unit_cost: "0.42", date: "2026-09-01", source_ref: "PO1" },
      ],
      poRows: [],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 20 }],
    });

    expect(result.quarantined.ledger).toEqual([]);
  });

  // Finding 5: a shipment referencing a PO line item that was never migrated
  // (its parent PO was quarantined) must be quarantined, not crash the run.
  it("quarantines a shipment whose po_line_item_ref never resolved, rather than crashing the whole migration", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [],
      shipmentRows: [
        {
          shipment_ref: "PO1-W4-Container2",
          vendor_reference: "",
          status: "planned",
          freight_cost: "",
          duty_cost: "",
          cost_currency: "",
          po_line_item_ref: "PO1-DOES-NOT-EXIST::JELLO-CAL-500",
          sku: "JELLO-CAL-500",
          qty: "100",
          weight_share: "1.0",
          value_share: "1.0",
        },
      ],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.shipments).toHaveLength(1);
    expect(result.quarantined.shipments[0].reason).toContain("po_line_item_ref");
    const shipmentRows = await db.select().from(shipments);
    expect(shipmentRows).toHaveLength(0);
  });

  // Finding 5: a payment referencing a PO number that was never migrated must
  // be quarantined, not silently inserted with poId: NULL, orphaned.
  it("quarantines a payment whose po_number never resolved, rather than inserting a dangling reference", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO-DOES-NOT-EXIST", sequence_no: "1", expected_amount: "100.00", expected_date: "2026-09-09", currency: "USD" }],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.payments).toHaveLength(1);
    expect(result.quarantined.payments[0].reason).toContain("po_number");
    const paymentRows = await db.select().from(payments);
    expect(paymentRows).toHaveLength(0);
  });
});
