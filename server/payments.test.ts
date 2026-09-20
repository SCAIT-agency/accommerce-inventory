// server/payments.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { payments, transactions, purchaseOrders, vendors, changeLog, users } from "../drizzle/schema";
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listUnpaidPayments, listTransactions } from "./payments";
import { createVendor, createUser } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";

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
      await tx.delete(transactions);
      await tx.delete(payments);
      await tx.delete(purchaseOrders);
      await tx.delete(vendors);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

describe("payments and transactions", () => {
  it("creates an expected payment slot unpaid by default", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
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
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });

    const paid = await markPaymentPaid(payment.id, {
      amount: "30746.70",
      fxRate: "0.93",
      paidDate: new Date("2026-09-09"),
      reasonCategory: "payment_timing",
      changedBy: userId,
    });

    expect(paid.paid).toBe(true);
    expect(paid.baseCurrencyAmount).toBe("28594.4300");
  });

  it("logs change_log entries with real prior values when a payment is marked paid", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });

    await markPaymentPaid(payment.id, {
      amount: "30746.70",
      fxRate: "0.93",
      paidDate: new Date("2026-09-09"),
      reasonCategory: "payment_timing",
      changedBy: userId,
    });

    const entries = await db.select().from(changeLog);
    expect(entries).toHaveLength(3);
    const paidEntry = entries.find((e) => e.field === "paid");
    const fxRateEntry = entries.find((e) => e.field === "fxRate");
    const paidAmountEntry = entries.find((e) => e.field === "paidAmount");
    expect(paidEntry?.oldValue).toBe("false");
    expect(paidEntry?.newValue).toBe("true");
    expect(paidEntry?.reasonCategory).toBe("payment_timing");
    expect(fxRateEntry?.oldValue).toBeNull();
    expect(fxRateEntry?.newValue).toBe("0.93");
    expect(paidAmountEntry?.oldValue).toBeNull();
    expect(paidAmountEntry?.newValue).toBe("30746.70");
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
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });

    await matchTransactionToPayment(tx.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });
    unmatched = await listUnmatchedTransactions();
    expect(unmatched.map((t) => t.id)).not.toContain(tx.id);
  });

  it("marks the payment paid using the transaction's own amount/date/fxRate when matched", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });
    const tx = await recordTransaction({
      date: new Date("2026-09-11"), amount: "30700.00", currency: "USD", fxRate: "0.93", counterparty: "Lvmengkang",
    });

    await matchTransactionToPayment(tx.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });

    const [updated] = await db.select().from(payments).where(sql`${payments.id} = ${payment.id}`);
    expect(updated.paid).toBe(true);
    expect(updated.paidAmount).toBe("30700.0000");
    expect(updated.fxRate).toBe("0.930000");
    expect(updated.baseCurrencyAmount).toBe((30700 * 0.93).toFixed(4));
  });

  it("does not overwrite an already-paid payment's recorded amount/date when later matched to a transaction", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({
      poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD",
    });
    await markPaymentPaid(payment.id, {
      amount: "30746.70", fxRate: "0.93", paidDate: new Date("2026-09-09"), reasonCategory: "payment_timing", changedBy: userId,
    });
    const tx = await recordTransaction({
      date: new Date("2026-09-11"), amount: "30700.00", currency: "USD", fxRate: "0.95", counterparty: "Lvmengkang",
    });

    await matchTransactionToPayment(tx.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });

    const [updated] = await db.select().from(payments).where(sql`${payments.id} = ${payment.id}`);
    expect(updated.paidAmount).toBe("30746.7000");
    expect(updated.fxRate).toBe("0.930000");
  });

  it("rejects matching a transaction to a nonexistent payment", async () => {
    const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });
    await expect(matchTransactionToPayment(tx.id, 999999, { reasonCategory: "payment_timing", changedBy: userId })).rejects.toThrow();
  });

  it("rejects matching an already-matched transaction to a different payment", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment1 = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });
    const payment2 = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date(), currency: "USD" });
    const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });

    await matchTransactionToPayment(tx.id, payment1.id, { reasonCategory: "payment_timing", changedBy: userId });
    await expect(matchTransactionToPayment(tx.id, payment2.id, { reasonCategory: "payment_timing", changedBy: userId })).rejects.toThrow(/already matched/);
  });

  it("allows re-matching a transaction to the same payment it's already matched to (idempotent)", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });
    const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });

    await matchTransactionToPayment(tx.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });
    await expect(matchTransactionToPayment(tx.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId })).resolves.not.toThrow();
  });

  it("rejects matching a payment that's already matched to a different transaction — no silent double-match", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });
    const txA = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test A" });
    const txB = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test B" });

    await matchTransactionToPayment(txA.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });
    await expect(matchTransactionToPayment(txB.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId })).rejects.toThrow(/already matched to a different transaction/);
  });

  it("rejects matching a nonexistent transaction with a clear error message", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });

    await expect(matchTransactionToPayment(999999, payment.id, { reasonCategory: "payment_timing", changedBy: userId })).rejects.toThrow(/no transaction found/);
  });

  it("lists payments for a PO, so they survive a reload instead of only existing in session state", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date("2026-09-09"), currency: "USD" });

    const { listPaymentsForPo } = await import("./payments");
    const result = await listPaymentsForPo(po.id);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.sequenceNo).sort()).toEqual([1, 2]);
  });

  it("lists only unpaid expected payments, for the transaction-matching picker", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const unpaid = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    const toBePaid = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await markPaymentPaid(toBePaid.id, { amount: "200.00", fxRate: "1", paidDate: new Date("2026-09-10"), reasonCategory: "payment_timing", changedBy: userId });

    const result = await listUnpaidPayments();
    expect(result.map((p) => p.id)).toEqual([unpaid.id]);
  });

  it("excludes an unpaid payment that's already matched to a transaction from the matching picker", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const matched = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    const unmatched = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });
    await matchTransactionToPayment(tx.id, matched.id, { reasonCategory: "payment_timing", changedBy: userId });

    const result = await listUnpaidPayments();
    expect(result.map((p) => p.id)).toEqual([unmatched.id]);
  });

  it("includes the PO number on each unpaid payment, to disambiguate the matching picker", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });

    const result = await listUnpaidPayments();
    expect(result[0].poNumber).toBe("PO3-JELLO");
  });

  it("listTransactions returns every transaction, matched or not, newest first", async () => {
    const tx1 = await recordTransaction({ date: new Date("2026-09-01"), amount: "100.00", currency: "USD", fxRate: "1.0", counterparty: "Vendor A" });
    const tx2 = await recordTransaction({ date: new Date("2026-09-05"), amount: "200.00", currency: "USD", fxRate: "1.0", counterparty: "Vendor B" });
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-01"), currency: "USD" });
    await matchTransactionToPayment(tx1.id, payment.id, { reasonCategory: "payment_timing", changedBy: userId });

    const result = await listTransactions();

    expect(result.map((t) => t.id)).toEqual([tx2.id, tx1.id]);
    expect(result.find((t) => t.id === tx1.id)?.matchedPaymentId).toBe(payment.id);
    expect(result.find((t) => t.id === tx2.id)?.matchedPaymentId).toBeNull();
  });
});
