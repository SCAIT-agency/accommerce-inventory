// server/cashflow.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { payments, transactions, purchaseOrders, vendors } from "../drizzle/schema";
import { getCashflowForecast } from "./cashflow";
import { createVendor } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { createExpectedPayment, markPaymentPaid, recordTransaction } from "./payments";

beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(purchaseOrders);
  await db.delete(vendors);
});

describe("cashflow forecast", () => {
  it("separates planned (expected payments) from actual (matched transactions) outflow per day", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    const payment2 = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "50000.00", expectedDate: new Date("2026-09-20"), currency: "USD" });
    await markPaymentPaid(payment2.id, { amount: "50000.00", fxRate: "0.93", paidDate: new Date("2026-09-20"), reasonCategory: "payment_timing", changedBy: 1 });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBe(30746.70);
    expect(day9?.actualOutflow).toBe(0);

    const day20 = forecast.find((f) => f.date === "2026-09-20");
    expect(day20?.actualOutflow).toBe(46500);
  });

  it("shows actual outflow on the real paid date even when expectedDate falls outside the queried window", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    const payment = await createExpectedPayment({
      poId: po.id,
      sequenceNo: 1,
      expectedAmount: "20000.00",
      expectedDate: new Date("2026-08-15"),
      currency: "USD",
    });
    await markPaymentPaid(payment.id, {
      amount: "20000.00",
      fxRate: "0.90",
      paidDate: new Date("2026-09-05"),
      reasonCategory: "payment_timing",
      changedBy: 1,
    });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day5 = forecast.find((f) => f.date === "2026-09-05");
    expect(day5?.actualOutflow).toBe(18000);

    const august = forecast.find((f) => f.date === "2026-08-15");
    expect(august).toBeUndefined();
  });
});
