// server/payments.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { payments, transactions, purchaseOrders, vendors, changeLog } from "../drizzle/schema";
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions } from "./payments";
import { createVendor } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";

beforeEach(async () => {
  await db.delete(changeLog);
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(purchaseOrders);
  await db.delete(vendors);
});

describe("payments and transactions", () => {
  it("creates an expected payment slot unpaid by default", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    const payment = await createExpectedPayment({
      poId: po.id,
      sequenceNo: 1,
      expectedAmount: "30746.70",
      expectedDate: new Date("2026-09-09"),
      currency: "USD",
    });
    expect(payment.paid).toBe(false);
  });

  it("marks a payment paid with an fx_rate captured at the real payment date, computing base-currency amount", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });

    const paid = await markPaymentPaid(payment.id, {
      amount: "30746.70",
      fxRate: "0.93",
      paidDate: new Date("2026-09-09"),
      changedBy: 1,
    });

    expect(paid.paid).toBe(true);
    expect(paid.baseCurrencyAmount).toBe("28594.43");
  });

  it("surfaces an unmatched transaction until it's manually linked to a payment", async () => {
    const tx = await recordTransaction({
      date: new Date("2026-09-09"),
      amount: "30746.70",
      currency: "USD",
      fxRate: "0.93",
      counterparty: "Lvmengkang",
      description: "PO3 Jello Pay1",
    });
    let unmatched = await listUnmatchedTransactions();
    expect(unmatched.map((t) => t.id)).toContain(tx.id);

    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });

    await matchTransactionToPayment(tx.id, payment.id);
    unmatched = await listUnmatchedTransactions();
    expect(unmatched.map((t) => t.id)).not.toContain(tx.id);
  });
});
