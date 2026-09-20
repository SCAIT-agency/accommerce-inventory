import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { salesPlan, salesActuals, inventoryLedger, skus, warehouses, salesPlanWeeklyInputs, salesPlanWeeklyRecipeLines } from "../drizzle/schema";
import {
  recordSalesActual,
  getSalesVolatility,
  getPlanActualDeviation,
  getDailyCogsForRange,
  createSalesPlanEntry,
  regenerateSalesPlanForWeek,
  upsertWeeklyInput,
  listWeeklyInputs,
} from "./salesPlan";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  // Real FKs now tie skus/warehouses to other tables, but each test file only
  // cleans its own tables at the start of each test (no afterAll anywhere in
  // this suite) — so a row left by another file's last test can otherwise
  // block these deletes regardless of order. Disabling FK checks for the
  // cleanup makes this file's reset order-independent again.
  //
  // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
  // deletes, and the toggle-on all land on the same pooled connection from
  // `db` (mysql.createPool). A real db.transaction pins one connection for
  // its whole duration, which is exactly the guarantee this needs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(salesActuals);
      await tx.delete(salesPlanWeeklyRecipeLines);
      await tx.delete(salesPlanWeeklyInputs);
      await tx.delete(salesPlan);
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("sales plan/actuals", () => {
  it("recording a sales actual also writes a matching inventory_ledger sale event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 2000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1162, source: "shopify_daily_pull" });

    const ledgerRows = await db.select().from(inventoryLedger);
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows[1].qty).toBe(-1162);
    expect(ledgerRows[1].eventType).toBe("sale");
  });

  it("leaves no sales_actuals row behind if the matching ledger event is rejected (atomicity)", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // No prior receipt — any sale drives SOH negative, so recordLedgerEvent throws.
    await expect(
      recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1, source: "manual" }),
    ).rejects.toThrow(/negative/i);

    const rows = await db.select().from(salesActuals);
    expect(rows).toEqual([]);
  });

  it("computes coefficient-of-variation volatility from weekly actuals", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 10000, unitCost: "0.42", date: new Date("2026-08-01"), sourceRef: "PO1" });
    for (const [date, qty] of [
      ["2026-08-04", 1000], ["2026-08-11", 1200], ["2026-08-18", 900], ["2026-08-25", 1100],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date, qty, source: "manual" });
    }

    const cv = await getSalesVolatility(sku.id, ff.id, 4);
    expect(cv).toBeGreaterThan(0);
    expect(cv).toBeLessThan(1);
  });

  it("computes volatility from the most RECENT N weeks, not the oldest N, once history exceeds the window", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // 6 weeks of history, but weeks=4 below. Oldest 4 (07-01..07-22) are all
    // 1000 -> CV=0. Newest 4 (07-15..08-05) are 1000,1000,3000,5000 -> CV≈0.6633.
    // An ascending-order-then-limit bug would return the oldest 4 and yield 0.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50000, unitCost: "0.42", date: new Date("2026-06-01"), sourceRef: "PO1" });
    for (const [date, qty] of [
      ["2026-07-01", 1000], ["2026-07-08", 1000], ["2026-07-15", 1000],
      ["2026-07-22", 1000], ["2026-07-29", 3000], ["2026-08-05", 5000],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date, qty, source: "manual" });
    }

    const cv = await getSalesVolatility(sku.id, ff.id, 4);
    expect(cv).toBeCloseTo(0.6633249580710799, 6);
  });

  it("computes per-SKU plan-vs-actual deviation, not just a warehouse aggregate", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 2000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await db.insert(salesPlan).values({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-09-09", plannedQty: 1000 });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1162, source: "shopify_daily_pull" });

    const deviation = await getPlanActualDeviation(sku.id, ff.id, "2026-09-09", "2026-09-09");
    expect(deviation).toEqual([{ date: "2026-09-09", planned: 1000, actual: 1162, deviation: 162 }]);
  });

  it("computes daily COGS for a whole range in one call via a single forward FIFO pass, not each day in isolation", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-03", qty: 80, source: "manual" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-10", qty: 40, source: "manual" });

    const result = await getDailyCogsForRange(sku.id, ff.id, [
      "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10",
    ]);

    expect(result).toHaveLength(8);
    // Sept 3 sale (80 units) is fully covered by the first batch (@2.00) — the second batch hasn't landed yet.
    expect(result.find((r) => r.date === "2026-09-03")?.cogs).toBeCloseTo(80 * 2.0, 2);
    // Sept 10 sale (40 units) drains the remaining 20 units of batch 1 (@2.00), then 20 units of batch 2 (@2.50).
    expect(result.find((r) => r.date === "2026-09-10")?.cogs).toBeCloseTo(20 * 2.0 + 20 * 2.5, 2);
    // A day inside the window with no sales must still appear, with zero cost, not be omitted.
    expect(result.find((r) => r.date === "2026-09-07")?.cogs).toBe(0);
  });

  it("returns an empty array for an empty dateKeys list, without querying the database", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const result = await getDailyCogsForRange(sku.id, ff.id, []);
    expect(result).toEqual([]);
  });

  it("creates a sales plan entry with a direct insert, no audit trail", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    const entry = await createSalesPlanEntry({
      skuId: sku.id,
      warehouseId: ff.id,
      periodDate: "2026-10-01",
      plannedQty: 500,
    });

    expect(entry.plannedQty).toBe(500);
    expect(entry.skuId).toBe(sku.id);

    const rows = await db.select().from(salesPlan);
    expect(rows).toHaveLength(1);
  });

  it("creating a sales plan entry twice for the same SKU/warehouse/day updates it in place instead of duplicating", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await createSalesPlanEntry({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-10-01", plannedQty: 500 });
    const updated = await createSalesPlanEntry({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-10-01", plannedQty: 750 });

    expect(updated.plannedQty).toBe(750);
    const rows = await db.select().from(salesPlan);
    expect(rows).toHaveLength(1);
    expect(rows[0].plannedQty).toBe(750);
  });

  it("stores and reads back a sales_actuals date as an exact calendar day, no time-of-day drift", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-19", qty: 10, source: "manual" });

    const [row] = await db.select().from(salesActuals).where(eq(salesActuals.skuId, sku.id));
    expect(row.date).toBe("2026-09-19");
  });

  describe("regenerateSalesPlanForWeek", () => {
    async function seedWeekInput(overrides: Partial<{
      weekStartDate: string;
      plannedRevenue: string;
      primaryPercent: string;
      recipe: { skuId: number; unitsPer1000: string }[];
      primaryWarehouseId: number;
      secondaryWarehouseId: number;
    }> & { primaryWarehouseId: number; secondaryWarehouseId: number; recipe: { skuId: number; unitsPer1000: string }[] }) {
      const [result] = await db.insert(salesPlanWeeklyInputs).values({
        weekStartDate: overrides.weekStartDate ?? "2026-10-05",
        plannedRevenue: overrides.plannedRevenue ?? "70000.00",
        primaryWarehouseId: overrides.primaryWarehouseId,
        primaryPercent: overrides.primaryPercent ?? "70.00",
        secondaryWarehouseId: overrides.secondaryWarehouseId,
      });
      await db.insert(salesPlanWeeklyRecipeLines).values(
        overrides.recipe.map((line) => ({ weeklyInputId: result.insertId, skuId: line.skuId, unitsPer1000: line.unitsPer1000 })),
      );
      return result.insertId;
    }

    it("computes a flat daily split from weekly revenue, allocates by units-per-1000, and splits by warehouse percent", async () => {
      const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      // 70000/7 = 10000/day. 10000/1000 * 5 units-per-1000 = 50 units/day.
      // 70% FF = 35, 30% Mutual = 15.
      await seedWeekInput({
        weekStartDate: "2026-10-05",
        plannedRevenue: "70000.00",
        primaryWarehouseId: ff.id,
        primaryPercent: "70.00",
        secondaryWarehouseId: mutual.id,
        recipe: [{ skuId: sku.id, unitsPer1000: "5" }],
      });

      await regenerateSalesPlanForWeek("2026-10-05");

      const rows = await db.select().from(salesPlan).where(eq(salesPlan.skuId, sku.id));
      expect(rows).toHaveLength(14); // 7 days * 2 warehouses
      const ffRow = rows.find((r) => r.warehouseId === ff.id && r.periodDate === "2026-10-05");
      const mutualRow = rows.find((r) => r.warehouseId === mutual.id && r.periodDate === "2026-10-05");
      expect(ffRow?.plannedQty).toBe(35);
      expect(mutualRow?.plannedQty).toBe(15);
    });

    it("re-running for the same week replaces rows instead of duplicating them", async () => {
      const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await seedWeekInput({
        weekStartDate: "2026-10-05",
        primaryWarehouseId: ff.id,
        secondaryWarehouseId: mutual.id,
        recipe: [{ skuId: sku.id, unitsPer1000: "5" }],
      });

      await regenerateSalesPlanForWeek("2026-10-05");
      await regenerateSalesPlanForWeek("2026-10-05");

      const rows = await db.select().from(salesPlan).where(eq(salesPlan.skuId, sku.id));
      expect(rows).toHaveLength(14);
    });

    it("leaves a manually-entered plan for a different SKU untouched when regenerating a week", async () => {
      const recipeSkU = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const otherSku = await createSku({ sku: "JELLO-STRAW-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await createSalesPlanEntry({ skuId: otherSku.id, warehouseId: ff.id, periodDate: "2026-10-05", plannedQty: 999 });
      await seedWeekInput({
        weekStartDate: "2026-10-05",
        primaryWarehouseId: ff.id,
        secondaryWarehouseId: mutual.id,
        recipe: [{ skuId: recipeSkU.id, unitsPer1000: "5" }],
      });

      await regenerateSalesPlanForWeek("2026-10-05");

      const otherRows = await db.select().from(salesPlan).where(eq(salesPlan.skuId, otherSku.id));
      expect(otherRows).toHaveLength(1);
      expect(otherRows[0].plannedQty).toBe(999);
    });

    it("computes independent breakdowns for two recipe lines in the same week", async () => {
      const jello = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const mixer = await createSku({ sku: "JELLO-MIXER-01", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await seedWeekInput({
        weekStartDate: "2026-10-05",
        plannedRevenue: "70000.00",
        primaryPercent: "50.00",
        primaryWarehouseId: ff.id,
        secondaryWarehouseId: mutual.id,
        recipe: [{ skuId: jello.id, unitsPer1000: "5" }, { skuId: mixer.id, unitsPer1000: "0.5" }],
      });

      await regenerateSalesPlanForWeek("2026-10-05");

      // Jello: 10000/1000*5 = 50/day, 50/50 split = 25/25.
      // Mixer: 10000/1000*0.5 = 5/day, 50/50 split = 3/2 (largest remainder: round(5)=5, round(5*0.5)=3 (banker's rounding could give 2, but Math.round(2.5)=3 in JS), remainder=2).
      const jelloFf = await db.select().from(salesPlan).where(and(eq(salesPlan.skuId, jello.id), eq(salesPlan.warehouseId, ff.id), eq(salesPlan.periodDate, "2026-10-05")));
      expect(jelloFf[0].plannedQty).toBe(25);
      const mixerRows = await db.select().from(salesPlan).where(and(eq(salesPlan.skuId, mixer.id), eq(salesPlan.periodDate, "2026-10-05")));
      const mixerTotal = mixerRows.reduce((sum, r) => sum + r.plannedQty, 0);
      expect(mixerTotal).toBe(5);
    });

    it("throws when regenerating a week that has already fully elapsed", async () => {
      const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await seedWeekInput({
        weekStartDate: "2020-01-06", // a Monday, long past
        primaryWarehouseId: ff.id,
        secondaryWarehouseId: mutual.id,
        recipe: [{ skuId: sku.id, unitsPer1000: "5" }],
      });

      await expect(regenerateSalesPlanForWeek("2020-01-06")).rejects.toThrow(/entirely in the past/);
    });

    it("throws a clear error when no weekly input exists for the given week", async () => {
      await expect(regenerateSalesPlanForWeek("2026-11-02")).rejects.toThrow(/no weekly input found/);
    });
  });

  describe("upsertWeeklyInput", () => {
    it("saves the weekly input, its recipe lines, and regenerates sales_plan in one call", async () => {
      const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await upsertWeeklyInput({
        weekStartDate: "2026-10-05",
        plannedRevenue: "70000.00",
        primaryWarehouseId: ff.id,
        primaryPercent: "70.00",
        secondaryWarehouseId: mutual.id,
        recipeLines: [{ skuId: sku.id, unitsPer1000: "5" }],
      });

      const rows = await db.select().from(salesPlan).where(eq(salesPlan.skuId, sku.id));
      expect(rows).toHaveLength(14);

      const inputs = await listWeeklyInputs("2026-10-01", "2026-10-31");
      expect(inputs).toHaveLength(1);
      expect(inputs[0].recipeLines).toHaveLength(1);
    });

    it("replaces the recipe wholesale when saved again with a different SKU list, not leaving stale lines", async () => {
      const skuA = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const skuB = await createSku({ sku: "JELLO-MIXER-01", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await upsertWeeklyInput({
        weekStartDate: "2026-10-05", plannedRevenue: "70000.00", primaryWarehouseId: ff.id, primaryPercent: "70.00", secondaryWarehouseId: mutual.id,
        recipeLines: [{ skuId: skuA.id, unitsPer1000: "5" }],
      });
      await upsertWeeklyInput({
        weekStartDate: "2026-10-05", plannedRevenue: "70000.00", primaryWarehouseId: ff.id, primaryPercent: "70.00", secondaryWarehouseId: mutual.id,
        recipeLines: [{ skuId: skuB.id, unitsPer1000: "2" }],
      });

      const inputs = await listWeeklyInputs("2026-10-01", "2026-10-31");
      expect(inputs[0].recipeLines).toHaveLength(1);
      expect(inputs[0].recipeLines[0].skuId).toBe(skuB.id);

      const rowsA = await db.select().from(salesPlan).where(eq(salesPlan.skuId, skuA.id));
      expect(rowsA).toHaveLength(0);
      const rowsB = await db.select().from(salesPlan).where(eq(salesPlan.skuId, skuB.id));
      expect(rowsB).toHaveLength(14);
    });

    it("cleans up stale rows under the OLD warehouse pair when a save both reassigns warehouses and drops a SKU", async () => {
      const skuA = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const skuB = await createSku({ sku: "JELLO-MIXER-01", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });
      const otherPrimary = await createWarehouse({ code: "FF-FR", name: "Fulfillment FR" });
      const otherSecondary = await createWarehouse({ code: "MUTUAL-AT", name: "Mutual AT" });

      await upsertWeeklyInput({
        weekStartDate: "2026-10-05", plannedRevenue: "70000.00", primaryWarehouseId: ff.id, primaryPercent: "70.00", secondaryWarehouseId: mutual.id,
        recipeLines: [{ skuId: skuA.id, unitsPer1000: "5" }],
      });
      await upsertWeeklyInput({
        weekStartDate: "2026-10-05", plannedRevenue: "70000.00", primaryWarehouseId: otherPrimary.id, primaryPercent: "70.00", secondaryWarehouseId: otherSecondary.id,
        recipeLines: [{ skuId: skuB.id, unitsPer1000: "2" }],
      });

      // skuA's original 14 rows lived under (ff, mutual) — the OLD pair — and
      // must be cleaned up even though the save also moved the week to a
      // brand-new (otherPrimary, otherSecondary) pair.
      const rowsA = await db.select().from(salesPlan).where(eq(salesPlan.skuId, skuA.id));
      expect(rowsA).toHaveLength(0);
      const rowsB = await db.select().from(salesPlan).where(eq(salesPlan.skuId, skuB.id));
      expect(rowsB).toHaveLength(14);
    });

    it("rejects saving a week that has already fully elapsed", async () => {
      const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
      const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
      const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

      await expect(upsertWeeklyInput({
        weekStartDate: "2020-01-06", plannedRevenue: "1000.00", primaryWarehouseId: ff.id, primaryPercent: "50.00", secondaryWarehouseId: mutual.id,
        recipeLines: [{ skuId: sku.id, unitsPer1000: "1" }],
      })).rejects.toThrow(/entirely in the past/);

      const inputs = await listWeeklyInputs("2020-01-01", "2020-01-31");
      expect(inputs).toHaveLength(0);
    });
  });
});
