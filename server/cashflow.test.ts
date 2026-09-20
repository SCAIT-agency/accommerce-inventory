// server/cashflow.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { payments, transactions, purchaseOrders, vendors, appSettings, users } from "../drizzle/schema";
import { getCashflowForecast } from "./cashflow";
import { createVendor, setAppSetting, createUser } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { createExpectedPayment, markPaymentPaid, recordTransaction } from "./payments";

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
      await tx.delete(transactions);
      await tx.delete(payments);
      await tx.delete(purchaseOrders);
      await tx.delete(vendors);
      await tx.delete(appSettings);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

describe("cashflow forecast", () => {
  it("separates planned (expected payments) from actual (matched transactions) outflow per day", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    const payment2 = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "50000.00", expectedDate: new Date("2026-09-20"), currency: "USD" });
    await markPaymentPaid(payment2.id, { amount: "50000.00", fxRate: "0.93", paidDate: new Date("2026-09-20"), reasonCategory: "payment_timing", changedBy: userId });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBe(30746.70);
    expect(day9?.actualOutflow).toBe(0);

    const day20 = forecast.find((f) => f.date === "2026-09-20");
    expect(day20?.actualOutflow).toBe(46500);
  });

  it("shows actual outflow on the real paid date even when expectedDate falls outside the queried window", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

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
      changedBy: userId,
    });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day5 = forecast.find((f) => f.date === "2026-09-05");
    expect(day5?.actualOutflow).toBe(18000);

    const august = forecast.find((f) => f.date === "2026-08-15");
    expect(august).toBeUndefined();
  });

  it("sums multiple same-currency planned payments landing on the same day", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "1253.30", expectedDate: new Date("2026-09-09"), currency: "USD" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBeCloseTo(32000);
  });

  it("treats differently-cased currency codes as the same currency, not a mixed-currency window", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: new Date("2026-09-09"), currency: "eur" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: new Date("2026-09-09"), currency: "EUR" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    // Same currency once normalized — summed exactly, not converted/estimated.
    expect(day9?.plannedOutflow).toBeCloseTo(40000);
    expect(day9?.plannedOutflowIsEstimated).toBe(false);
  });

  it("estimates a EUR-equivalent total using the standard FX rate when one day's planned payments span more than one currency, flagging it as an estimate", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: new Date("2026-09-09"), currency: "EUR" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    // 30000 USD * default 0.86 + 10000 EUR (base currency, exact) = 35800
    expect(day9?.plannedOutflow).toBeCloseTo(35800);
    expect(day9?.plannedOutflowIsEstimated).toBe(true);
  });

  it("sums same-currency planned payments spread across multiple different days in the range", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30746.70", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "1253.30", expectedDate: new Date("2026-09-15"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 3, expectedAmount: "5000.00", expectedDate: new Date("2026-09-20"), currency: "USD" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    expect(forecast.find((f) => f.date === "2026-09-09")?.plannedOutflow).toBeCloseTo(30746.7);
    expect(forecast.find((f) => f.date === "2026-09-15")?.plannedOutflow).toBeCloseTo(1253.3);
    expect(forecast.find((f) => f.date === "2026-09-20")?.plannedOutflow).toBeCloseTo(5000);
  });

  it("estimates per-day EUR-equivalents when unpaid payments on DIFFERENT days within the same range span more than one currency, only flagging the day whose own amount was converted", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: new Date("2026-09-15"), currency: "EUR" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBeCloseTo(30000 * 0.86);
    expect(day9?.plannedOutflowIsEstimated).toBe(true);

    const day15 = forecast.find((f) => f.date === "2026-09-15");
    expect(day15?.plannedOutflow).toBeCloseTo(10000);
    expect(day15?.plannedOutflowIsEstimated).toBe(false);
  });

  it("still throws when a mixed-currency window includes a currency with no configured standard FX rate", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "1000.00", expectedDate: new Date("2026-09-09"), currency: "GBP" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "1000.00", expectedDate: new Date("2026-09-09"), currency: "EUR" });

    await expect(getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"))).rejects.toThrow(
      /no standard FX rate configured for "GBP"/,
    );
  });

  it("uses an app_settings override instead of the default standard FX rate when one is configured", async () => {
    await setAppSetting("standard_fx_rate:USD", "0.80");
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "10000.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "5000.00", expectedDate: new Date("2026-09-09"), currency: "EUR" });

    const forecast = await getCashflowForecast(new Date("2026-09-01"), new Date("2026-09-30"));

    const day9 = forecast.find((f) => f.date === "2026-09-09");
    expect(day9?.plannedOutflow).toBeCloseTo(10000 * 0.80 + 5000);
  });
});
