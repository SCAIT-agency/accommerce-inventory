# Weekly Sales Plan Input & Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a latent duplicate-row bug in `sales_plan` (no uniqueness on SKU/warehouse/date), and add a way to plan sales at the grain the business actually plans it — weekly revenue, a per-€1,000 product mix, and a warehouse-split percentage, entered up to 26 weeks ahead and independently revisable week by week.

**Architecture:** Two new tables (`sales_plan_weekly_inputs`, `sales_plan_weekly_recipe_lines`) hold the weekly inputs. `regenerateSalesPlanForWeek` reads one week's input, computes a 7-day × recipe-line × 2-warehouse breakdown, and atomically replaces (never appends to) that week's `sales_plan` rows. A new unique constraint on `sales_plan` makes duplicate rows structurally impossible, and `createSalesPlanEntry` becomes a real upsert so both the existing manual-entry path and the new bulk path share the same "one row per SKU/warehouse/day" invariant.

**Tech Stack:** Node/Express + tRPC v11 + React + MySQL via Drizzle ORM + Vitest.

**Spec:** `docs/2026-09-20-weekly-sales-plan-design.md`

## Global Constraints

- No day-of-week revenue distribution pattern — flat `revenue / 7` only.
- This feature never writes or reads `sales_actuals` — only `sales_plan`.
- `regenerateSalesPlanForWeek` never opens its own transaction — it always receives its `dbClient` from a caller (`upsertWeeklyInput` owns the one transaction). Direct test calls to it accept the narrower non-atomic window as a test-only simplification.
- Reject regenerating (and reject saving, since saving always regenerates) a week that has already fully elapsed (its last day is before today).
- Reuse the existing `enumerateDateStrings` from `server/dashboards.ts` (export it) — do not write a second implementation.
- No new npm dependencies; no caching.
- Every new/changed value proven against real seeded data in tests, not just asserted.
- Env vars must be loaded before any pnpm test/check command: `set -a && source .env && set +a`.

---

### Task 1: Schema — `sales_plan` uniqueness + two new tables

**Files:**
- Modify: `drizzle/schema.ts` (the `salesPlan` table definition, ~line 230)
- Modify: `server/salesPlan.ts` (`createSalesPlanEntry`)
- Modify: `server/salesPlan.test.ts` (existing test + one new test)

**Interfaces:**
- Produces: `salesPlan`'s new unique constraint `sales_plan_sku_warehouse_date_unique` on `(skuId, warehouseId, periodDate)`; `salesPlanWeeklyInputs` and `salesPlanWeeklyRecipeLines` tables and their inferred types (`SalesPlanWeeklyInput`, `SalesPlanWeeklyRecipeLine`), consumed by Task 2.

- [ ] **Step 1: Add the unique constraint to `salesPlan`**

In `drizzle/schema.ts`, replace the `salesPlan` table definition:

```ts
export const salesPlan = mysqlTable(
  "sales_plan",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull(),
    warehouseId: int("warehouseId").notNull(),
    periodDate: date("periodDate", { mode: "string" }).notNull(),
    plannedQty: int("plannedQty").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateUnique: unique("sales_plan_sku_warehouse_date_unique").on(table.skuId, table.warehouseId, table.periodDate),
  }),
);
export type SalesPlanRow = typeof salesPlan.$inferSelect;
```

(`unique` is already imported at the top of this file.)

- [ ] **Step 2: Add the two new tables**

In `drizzle/schema.ts`, immediately after the `salesPlan` table definition:

```ts
export const salesPlanWeeklyInputs = mysqlTable("sales_plan_weekly_inputs", {
  id: int("id").autoincrement().primaryKey(),
  weekStartDate: date("weekStartDate", { mode: "string" }).notNull().unique(),
  plannedRevenue: varchar("plannedRevenue", { length: 32 }).notNull(),
  primaryWarehouseId: int("primaryWarehouseId").notNull().references(() => warehouses.id),
  primaryPercent: varchar("primaryPercent", { length: 8 }).notNull(),
  secondaryWarehouseId: int("secondaryWarehouseId").notNull().references(() => warehouses.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type SalesPlanWeeklyInput = typeof salesPlanWeeklyInputs.$inferSelect;

export const salesPlanWeeklyRecipeLines = mysqlTable("sales_plan_weekly_recipe_lines", {
  id: int("id").autoincrement().primaryKey(),
  weeklyInputId: int("weeklyInputId").notNull().references(() => salesPlanWeeklyInputs.id),
  skuId: int("skuId").notNull().references(() => skus.id),
  unitsPer1000: varchar("unitsPer1000", { length: 16 }).notNull(),
});
export type SalesPlanWeeklyRecipeLine = typeof salesPlanWeeklyRecipeLines.$inferSelect;
```

- [ ] **Step 3: Push the schema change**

Run: `set -a && source .env && set +a && pnpm db:push`
Expected: drizzle-kit reports the new unique constraint and the two new tables. No prompt about renames (these are genuinely new — no prior data exists in `sales_plan_weekly_inputs`/`sales_plan_weekly_recipe_lines`, and the `sales_plan` change is additive-constraint-only on an already-empty-in-dev table).

- [ ] **Step 4: Write the failing test for the upsert behavior**

In `server/salesPlan.test.ts`, add:

```ts
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `set -a && source .env && set +a && pnpm test server/salesPlan.test.ts -t "updates it in place"`
Expected: FAIL — the second `createSalesPlanEntry` call throws a duplicate-key DB error (the plain insert has no conflict handling yet), not the expected update.

- [ ] **Step 6: Implement the upsert**

In `server/salesPlan.ts`, replace `createSalesPlanEntry`:

```ts
export async function createSalesPlanEntry(
  input: CreateSalesPlanEntryInput,
  dbClient: DbClient = db,
): Promise<typeof salesPlan.$inferSelect> {
  await dbClient
    .insert(salesPlan)
    .values(input)
    .onDuplicateKeyUpdate({ set: { plannedQty: input.plannedQty } });
  const [row] = await dbClient
    .select()
    .from(salesPlan)
    .where(and(eq(salesPlan.skuId, input.skuId), eq(salesPlan.warehouseId, input.warehouseId), eq(salesPlan.periodDate, input.periodDate)));
  return row;
}
```

Confirm `and` is already imported from `drizzle-orm` at the top of this file (it is — used elsewhere in the same file); if not, add it to the existing import.

- [ ] **Step 7: Run the test to verify it passes, then the whole file**

Run: `set -a && source .env && set +a && pnpm test server/salesPlan.test.ts`
Expected: PASS, including the pre-existing "creates a sales plan entry with a direct insert, no audit trail" test (still accurate — no audit trail either way, just no longer a raw uncontested insert).

- [ ] **Step 8: Run the full suite and type-check**

Run: `set -a && source .env && set +a && pnpm check && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add drizzle/schema.ts server/salesPlan.ts server/salesPlan.test.ts
git commit -m "feat: add sales_plan uniqueness and weekly-input schema"
```

---

### Task 2: `regenerateSalesPlanForWeek` and `upsertWeeklyInput`

**Files:**
- Modify: `server/dashboards.ts` (export `enumerateDateStrings`)
- Modify: `server/salesPlan.ts` (`regenerateSalesPlanForWeek`, `upsertWeeklyInput`, `listWeeklyInputs`)
- Modify: `server/salesPlan.test.ts` (new tests)

**Interfaces:**
- Consumes: `enumerateDateStrings(from: Date, to: Date): string[]` (Task 2's own export from `dashboards.ts`); `salesPlanWeeklyInputs`/`salesPlanWeeklyRecipeLines` (Task 1).
- Produces: `regenerateSalesPlanForWeek(weekStartDate: string, dbClient?: DbClient): Promise<void>`; `upsertWeeklyInput(input): Promise<void>` where `input = { weekStartDate: string; plannedRevenue: string; primaryWarehouseId: number; primaryPercent: string; secondaryWarehouseId: number; recipeLines: { skuId: number; unitsPer1000: string }[] }`; `listWeeklyInputs(from: string, to: string): Promise<(SalesPlanWeeklyInput & { recipeLines: SalesPlanWeeklyRecipeLine[] })[]>` — all consumed by Task 3's router.

- [ ] **Step 1: Export `enumerateDateStrings`**

In `server/dashboards.ts`, change:

```ts
function enumerateDateStrings(from: Date, to: Date): string[] {
```

to:

```ts
export function enumerateDateStrings(from: Date, to: Date): string[] {
```

Nothing else in that file changes — its own internal call site (`dashboards.ts:130`) keeps working unchanged.

- [ ] **Step 2: Write the failing tests for `regenerateSalesPlanForWeek`**

In `server/salesPlan.test.ts`, add `salesPlanWeeklyInputs, salesPlanWeeklyRecipeLines` to the schema import, add `regenerateSalesPlanForWeek, upsertWeeklyInput, listWeeklyInputs` to the `./salesPlan` import, and add `salesPlanWeeklyInputs`/`salesPlanWeeklyRecipeLines` deletes to the `beforeEach` cleanup block (after `salesPlan`, before `inventoryLedger` — recipe lines reference weekly inputs which must go first):

```ts
      await tx.delete(salesActuals);
      await tx.delete(salesPlanWeeklyRecipeLines);
      await tx.delete(salesPlanWeeklyInputs);
      await tx.delete(salesPlan);
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
```

Add these tests:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `set -a && source .env && set +a && pnpm test server/salesPlan.test.ts -t "regenerateSalesPlanForWeek"`
Expected: FAIL — none of `regenerateSalesPlanForWeek`/`upsertWeeklyInput`/`listWeeklyInputs` exist yet.

- [ ] **Step 4: Implement `regenerateSalesPlanForWeek`**

In `server/salesPlan.ts`, add `inArray` to the existing `drizzle-orm` import, and `enumerateDateStrings` from `./dashboards`, and `salesPlanWeeklyInputs, salesPlanWeeklyRecipeLines` from `../drizzle/schema`:

```ts
export async function regenerateSalesPlanForWeek(weekStartDate: string, dbClient: DbClient = db): Promise<void> {
  const [weekInput] = await dbClient.select().from(salesPlanWeeklyInputs).where(eq(salesPlanWeeklyInputs.weekStartDate, weekStartDate));
  if (!weekInput) {
    throw new Error(`regenerateSalesPlanForWeek: no weekly input found for week starting ${weekStartDate}`);
  }

  const weekStart = new Date(weekStartDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekDates = enumerateDateStrings(weekStart, weekEnd);
  const lastDayOfWeek = weekDates[weekDates.length - 1];
  const todayStr = new Date().toISOString().slice(0, 10);
  if (lastDayOfWeek < todayStr) {
    throw new Error(`regenerateSalesPlanForWeek: week starting ${weekStartDate} is entirely in the past — planning only applies to the current week or later`);
  }

  const recipeLines = await dbClient.select().from(salesPlanWeeklyRecipeLines).where(eq(salesPlanWeeklyRecipeLines.weeklyInputId, weekInput.id));
  const dailyRevenue = parseFloat(weekInput.plannedRevenue) / 7;
  const primaryPct = parseFloat(weekInput.primaryPercent) / 100;

  const rowsToInsert: { skuId: number; warehouseId: number; periodDate: string; plannedQty: number }[] = [];
  const skuIds = recipeLines.map((line) => line.skuId);

  for (const date of weekDates) {
    for (const line of recipeLines) {
      const rawUnits = (dailyRevenue / 1000) * parseFloat(line.unitsPer1000);
      const totalUnitsRounded = Math.round(rawUnits);
      const primaryUnits = Math.round(totalUnitsRounded * primaryPct);
      const secondaryUnits = totalUnitsRounded - primaryUnits;
      rowsToInsert.push({ skuId: line.skuId, warehouseId: weekInput.primaryWarehouseId, periodDate: date, plannedQty: primaryUnits });
      rowsToInsert.push({ skuId: line.skuId, warehouseId: weekInput.secondaryWarehouseId, periodDate: date, plannedQty: secondaryUnits });
    }
  }

  if (skuIds.length > 0) {
    await dbClient.delete(salesPlan).where(and(
      inArray(salesPlan.skuId, skuIds),
      inArray(salesPlan.warehouseId, [weekInput.primaryWarehouseId, weekInput.secondaryWarehouseId]),
      between(salesPlan.periodDate, weekStartDate, lastDayOfWeek),
    ));
  }
  if (rowsToInsert.length > 0) {
    await dbClient.insert(salesPlan).values(rowsToInsert);
  }
}
```

(`between` is already imported in this file — used by `getPlanActualDeviation`.)

- [ ] **Step 5: Implement `upsertWeeklyInput` and `listWeeklyInputs`**

```ts
export interface UpsertWeeklyInputInput {
  weekStartDate: string;
  plannedRevenue: string;
  primaryWarehouseId: number;
  primaryPercent: string;
  secondaryWarehouseId: number;
  recipeLines: { skuId: number; unitsPer1000: string }[];
}

export async function upsertWeeklyInput(input: UpsertWeeklyInputInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(salesPlanWeeklyInputs)
      .values({
        weekStartDate: input.weekStartDate,
        plannedRevenue: input.plannedRevenue,
        primaryWarehouseId: input.primaryWarehouseId,
        primaryPercent: input.primaryPercent,
        secondaryWarehouseId: input.secondaryWarehouseId,
      })
      .onDuplicateKeyUpdate({
        set: {
          plannedRevenue: input.plannedRevenue,
          primaryWarehouseId: input.primaryWarehouseId,
          primaryPercent: input.primaryPercent,
          secondaryWarehouseId: input.secondaryWarehouseId,
        },
      });
    const [weekInput] = await tx.select().from(salesPlanWeeklyInputs).where(eq(salesPlanWeeklyInputs.weekStartDate, input.weekStartDate));

    await tx.delete(salesPlanWeeklyRecipeLines).where(eq(salesPlanWeeklyRecipeLines.weeklyInputId, weekInput.id));
    if (input.recipeLines.length > 0) {
      await tx.insert(salesPlanWeeklyRecipeLines).values(
        input.recipeLines.map((line) => ({ weeklyInputId: weekInput.id, skuId: line.skuId, unitsPer1000: line.unitsPer1000 })),
      );
    }

    await regenerateSalesPlanForWeek(input.weekStartDate, tx);
  });
}

export async function listWeeklyInputs(from: string, to: string): Promise<(typeof salesPlanWeeklyInputs.$inferSelect & { recipeLines: (typeof salesPlanWeeklyRecipeLines.$inferSelect)[] })[]> {
  const weekInputs = await db.select().from(salesPlanWeeklyInputs).where(between(salesPlanWeeklyInputs.weekStartDate, from, to));
  if (weekInputs.length === 0) return [];

  const weekInputIds = weekInputs.map((w) => w.id);
  const allRecipeLines = await db.select().from(salesPlanWeeklyRecipeLines).where(inArray(salesPlanWeeklyRecipeLines.weeklyInputId, weekInputIds));

  return weekInputs.map((weekInput) => ({
    ...weekInput,
    recipeLines: allRecipeLines.filter((line) => line.weeklyInputId === weekInput.id),
  }));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `set -a && source .env && set +a && pnpm test server/salesPlan.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 7: Run the full suite and type-check**

Run: `set -a && source .env && set +a && pnpm check && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/dashboards.ts server/salesPlan.ts server/salesPlan.test.ts
git commit -m "feat: add regenerateSalesPlanForWeek and upsertWeeklyInput"
```

---

### Task 3: Router

**Files:**
- Modify: `server/routers.ts`

**Interfaces:**
- Consumes: `upsertWeeklyInput`, `listWeeklyInputs` (Task 2).
- Produces: tRPC procedures `salesPlan.listWeeklyInputs`, `salesPlan.upsertWeeklyInput`, consumed by Task 4's frontend.

- [ ] **Step 1: Add both procedures**

In `server/routers.ts`, add `upsertWeeklyInput, listWeeklyInputs` to the existing `./salesPlan` import:

```ts
import { createSalesPlanEntry, getSalesVolatility, getPlanActualDeviation, upsertWeeklyInput, listWeeklyInputs } from "./salesPlan";
```

In the `salesPlan` router block, add after the existing `planActualDeviation` procedure:

```ts
    listWeeklyInputs: protectedProcedure
      .input(z.object({ from: z.date(), to: z.date() }))
      .query(({ input }) => listWeeklyInputs(input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10))),
    upsertWeeklyInput: editorProcedure
      .input(z.object({
        weekStartDate: z.date(),
        plannedRevenue: z.string(),
        primaryWarehouseId: z.number(),
        primaryPercent: z.string(),
        secondaryWarehouseId: z.number(),
        recipeLines: z.array(z.object({ skuId: z.number(), unitsPer1000: z.string() })),
      }))
      .mutation(({ input }) => upsertWeeklyInput({ ...input, weekStartDate: input.weekStartDate.toISOString().slice(0, 10) })),
```

- [ ] **Step 2: Type-check and run the full suite**

Run: `set -a && source .env && set +a && pnpm check && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/routers.ts
git commit -m "feat: add salesPlan.listWeeklyInputs and upsertWeeklyInput procedures"
```

---

### Task 4: Frontend — Weekly Sales Plan grid

**Files:**
- Modify: `client/src/pages/StockPage.tsx`

**Interfaces:**
- Consumes: `trpc.salesPlan.listWeeklyInputs.useQuery({from, to})`, `trpc.salesPlan.upsertWeeklyInput.useMutation()`, `trpc.catalog.listWarehouses.useQuery()`, `trpc.catalog.listSkus.useQuery()` (all existing or Task 3).
- Produces: no interfaces consumed by a later task — final task in this plan.

- [ ] **Step 1: Add the section to `StockPage.tsx`**

Read the current file first (it already has `SalesPlanSection` and its own imports/state) — add the following as new code, placed after `SalesPlanSection`'s definition and before `export function StockPage()`, and add `<WeeklySalesPlanSection />` inside `StockPage`'s returned JSX, right after `<SalesPlanSection warehouseFilter={warehouseFilter} />`:

```tsx
function weekEndDateStr(weekStartDate: string): string {
  const d = new Date(weekStartDate);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function nextMondays(n: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = cursor.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  cursor.setUTCDate(cursor.getUTCDate() + diffToMonday);
  for (let i = 0; i < n; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

type WeeklyInputWithLines = RouterOutputs["salesPlan"]["listWeeklyInputs"][number];

interface WeeklyRecipeLineForm {
  skuId: string;
  unitsPer1000: string;
}

interface WeeklyPlanFormState {
  plannedRevenue: string;
  primaryWarehouseId: string;
  primaryPercent: string;
  secondaryWarehouseId: string;
  recipeLines: WeeklyRecipeLineForm[];
}

function defaultWeeklyPlanForm(existing?: WeeklyInputWithLines): WeeklyPlanFormState {
  if (!existing) {
    return { plannedRevenue: "", primaryWarehouseId: "", primaryPercent: "", secondaryWarehouseId: "", recipeLines: [] };
  }
  return {
    plannedRevenue: existing.plannedRevenue,
    primaryWarehouseId: String(existing.primaryWarehouseId),
    primaryPercent: existing.primaryPercent,
    secondaryWarehouseId: String(existing.secondaryWarehouseId),
    recipeLines: existing.recipeLines.map((l) => ({ skuId: String(l.skuId), unitsPer1000: l.unitsPer1000 })),
  };
}

function WeeklyPlanRow({ weekStartDate, existing, skus, warehouses, onSaved }: {
  weekStartDate: string;
  existing?: WeeklyInputWithLines;
  skus: { id: number; sku: string | null; name: string | null }[];
  warehouses: { id: number; code: string; name: string }[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WeeklyPlanFormState>(() => defaultWeeklyPlanForm(existing));
  const upsert = trpc.salesPlan.upsertWeeklyInput.useMutation({ onSuccess: onSaved });

  const isPast = weekEndDateStr(weekStartDate) < new Date().toISOString().slice(0, 10);

  if (isPast) {
    return (
      <tr>
        <td>{weekStartDate}</td>
        <td colSpan={4}>Past — read-only</td>
      </tr>
    );
  }

  const addRecipeLine = () => setForm((prev) => ({ ...prev, recipeLines: [...prev.recipeLines, { skuId: "", unitsPer1000: "" }] }));
  const updateRecipeLine = (i: number, patch: Partial<WeeklyRecipeLineForm>) =>
    setForm((prev) => ({ ...prev, recipeLines: prev.recipeLines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));
  const removeRecipeLine = (i: number) => setForm((prev) => ({ ...prev, recipeLines: prev.recipeLines.filter((_, idx) => idx !== i) }));

  const canSave = form.plannedRevenue.trim().length > 0
    && form.primaryWarehouseId !== "" && form.secondaryWarehouseId !== "" && form.primaryPercent.trim().length > 0
    && form.recipeLines.length > 0
    && form.recipeLines.every((l) => l.skuId !== "" && l.unitsPer1000.trim().length > 0);

  return (
    <tr>
      <td>{weekStartDate}</td>
      <td>
        <input type="text" placeholder="revenue" value={form.plannedRevenue} onChange={(e) => setForm((prev) => ({ ...prev, plannedRevenue: e.target.value }))} />
      </td>
      <td>
        <select value={form.primaryWarehouseId} onChange={(e) => setForm((prev) => ({ ...prev, primaryWarehouseId: e.target.value }))}>
          <option value="">Primary…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
        <input type="text" placeholder="primary %" value={form.primaryPercent} onChange={(e) => setForm((prev) => ({ ...prev, primaryPercent: e.target.value }))} />
        <select value={form.secondaryWarehouseId} onChange={(e) => setForm((prev) => ({ ...prev, secondaryWarehouseId: e.target.value }))}>
          <option value="">Secondary…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
      </td>
      <td>
        {form.recipeLines.map((line, i) => (
          <div key={i}>
            <select value={line.skuId} onChange={(e) => updateRecipeLine(i, { skuId: e.target.value })}>
              <option value="">SKU…</option>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.sku ?? s.name ?? `#${s.id}`}</option>)}
            </select>
            <input type="text" placeholder="units/1000€" value={line.unitsPer1000} onChange={(e) => updateRecipeLine(i, { unitsPer1000: e.target.value })} />
            <button onClick={() => removeRecipeLine(i)}>Remove</button>
          </div>
        ))}
        <button onClick={addRecipeLine}>Add SKU</button>
      </td>
      <td>
        <button
          disabled={!canSave || upsert.isPending}
          onClick={() =>
            upsert.mutate({
              weekStartDate: new Date(weekStartDate),
              plannedRevenue: form.plannedRevenue,
              primaryWarehouseId: Number(form.primaryWarehouseId),
              primaryPercent: form.primaryPercent,
              secondaryWarehouseId: Number(form.secondaryWarehouseId),
              recipeLines: form.recipeLines.map((l) => ({ skuId: Number(l.skuId), unitsPer1000: l.unitsPer1000 })),
            })
          }
        >
          Save & regenerate
        </button>
        {upsert.error && <div>Failed: {upsert.error.message}</div>}
      </td>
    </tr>
  );
}

function WeeklySalesPlanSection() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const weeks = useMemo(() => nextMondays(26), []);
  const inputsQuery = trpc.salesPlan.listWeeklyInputs.useQuery({
    from: new Date(weeks[0]),
    to: new Date(weeks[weeks.length - 1]),
  });

  const error = warehousesQuery.error ?? skusQuery.error ?? inputsQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = warehousesQuery.isLoading || skusQuery.isLoading || inputsQuery.isLoading;
  if (isLoading || !warehousesQuery.data || !skusQuery.data || !inputsQuery.data) return <div>Loading…</div>;

  const inputsByWeek = new Map(inputsQuery.data.map((w) => [w.weekStartDate, w]));
  const onSaved = () => utils.salesPlan.listWeeklyInputs.invalidate();

  return (
    <div>
      <h2>Weekly Sales Plan</h2>
      <table>
        <thead><tr><th>Week</th><th>Revenue</th><th>Warehouse split</th><th>Recipe (units/1000€)</th><th></th></tr></thead>
        <tbody>
          {weeks.map((week) => (
            <WeeklyPlanRow
              key={week}
              weekStartDate={week}
              existing={inputsByWeek.get(week)}
              skus={skusQuery.data}
              warehouses={warehousesQuery.data}
              onSaved={onSaved}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Add `<WeeklySalesPlanSection />` inside `StockPage`'s return, right after `<SalesPlanSection warehouseFilter={warehouseFilter} />`.

- [ ] **Step 2: Type-check and build**

Run: `set -a && source .env && set +a && pnpm check && pnpm build`
Expected: PASS. If `RouterOutputs["salesPlan"]["listWeeklyInputs"]` doesn't resolve, confirm `RouterOutputs` is already defined at the top of `StockPage.tsx` from `inferRouterOutputs<AppRouter>` (it is not currently — check whether this file already imports `inferRouterOutputs`/`AppRouter`; if not, add the same import pattern already used in `PurchaseOrdersPage.tsx`/`ShipmentsPage.tsx`: `import type { inferRouterOutputs } from "@trpc/server"; import type { AppRouter } from "../../../server/routers"; type RouterOutputs = inferRouterOutputs<AppRouter>;`).

- [ ] **Step 3: Manual verification with the real dev server**

Start the backend (`pnpm dev`, backgrounded) and the client (`pnpm exec vite`, backgrounded). Log in, visit `/stock`, scroll to "Weekly Sales Plan". Confirm 26 week rows render, the current week is the first row and is editable (not marked "Past — read-only"), filling in revenue + both warehouses + percent + at least one recipe line enables "Save & regenerate", and saving succeeds (check the Stock table above updates its days-of-cover numbers if the SKU used already has ledger history, or at minimum confirm no error). Kill both background processes afterward.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/StockPage.tsx
git commit -m "feat: add Weekly Sales Plan input grid to Stock page"
```
