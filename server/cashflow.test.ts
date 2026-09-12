// server/cashflow.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { payments, transactions, purchaseOrders, vendors } from "../drizzle/schema";
import { getCashflowForecast } from "./cashflow";
import { createVendor } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { createExpectedPayment, markPaymentPaid, recordTransaction } from "./payments";

beforeEach(async () => {
  // Real FKs now tie these tables together, but each test file only cleans
  // its own tables at the start of each test (no afterAll anywhere in this
  // suite) — so a row left by another file's last test can otherwise block
  // these deletes regardless of order. Disabling FK checks for the cleanup
  // makes this file's reset order-independent again.
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(purchaseOrders);
  await db.delete(vendors);
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
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

  it("sums multiple same-currency planned payments landing on the same day", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "1253.30", expectedDate: new Date("2026-09-09"), currency: "USD" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBeCloseTo(32000);
  });

  it("throws instead of silently blending currencies when one day's planned payments span more than one currency", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: new Date("2026-09-09"), currency: "EUR" });

    await expect(getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"))).rejects.toThrow(
      /cannot aggregate mixed currencies \(USD, EUR\) across 2026-09-01 to 2026-09-30/,
    );
  });

  it("sums same-currency planned payments spread across multiple different days in the range", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "1253.30", expectedDate: new Date("2026-09-15"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 3, expectedAmount: "5000.00", expectedDate: new Date("2026-09-20"), currency: "USD" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    expect(forecast.find((f) => f.date === "2026-09-09")?.plannedOutflow).toBeCloseTo(30746.7);
    expect(forecast.find((f) => f.date === "2026-09-15")?.plannedOutflow).toBeCloseTo(1253.3);
    expect(forecast.find((f) => f.date === "2026-09-20")?.plannedOutflow).toBeCloseTo(5000);
  });

  it("throws instead of silently blending currencies when unpaid payments on DIFFERENT days within the same range span more than one currency", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: new Date("2026-09-15"), currency: "EUR" });

    await expect(getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"))).rejects.toThrow(
      /cannot aggregate mixed currencies \(USD, EUR\) across 2026-09-01 to 2026-09-30/,
    );
  });
});
