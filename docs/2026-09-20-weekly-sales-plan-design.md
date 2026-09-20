# Weekly Sales Plan Input & Generation — Design

## 1. Problem

Two problems, bundled because the second is unbuildable safely without fixing the first.

### 1a. `sales_plan` has no uniqueness — a latent, already-live bug

`sales_plan` (`drizzle/schema.ts:230-237`) has no constraint on `(skuId, warehouseId, periodDate)`. `createSalesPlanEntry` (`server/salesPlan.ts:22-29`) is a plain insert — calling it twice for the same SKU/warehouse/day (a user correcting a typo, or any future bulk writer) creates two rows, not one updated row. `getPlanActualDeviation` (`server/salesPlan.ts:73-90`) then reports it as **two separate lines for the same date**, each compared against the same summed actual — a confusing, wrong-looking output with no error anywhere to flag it. This is real today, independent of the new feature below; it's just that the new feature would make it worse (26 weeks × several SKUs × 2 warehouses re-generated weekly, with every re-generation duplicating rows unless this is fixed first).

### 1b. No way to plan sales at the level the business actually plans it

Sales planning today is one manual entry at a time: pick a SKU, a warehouse, a day, a quantity. Real planning happens at a completely different grain: a **weekly revenue figure**, a **product mix ratio** (units of each product per €1,000 of revenue), and a **channel split** (% to one warehouse, remainder to the other) — entered up to 26 weeks ahead and revised week by week as forecasts firm up. There is no way to express that today without typing every SKU/warehouse/day combination by hand.

## 2. Scope

1. Schema: unique constraint on `sales_plan(skuId, warehouseId, periodDate)`; `createSalesPlanEntry` becomes a real upsert (fixes 1a for the existing manual-entry path too, not just the new one).
2. New table `sales_plan_weekly_inputs` — one row per calendar week (Monday-start), holding revenue, the two-warehouse split, and which percent goes to which.
3. New table `sales_plan_weekly_recipe_lines` — child rows: which SKUs participate in that week's mix and their units-per-€1,000 ratio. Not hardcoded to "Jello/Mixer/Straw" as code concepts — any SKU can be a recipe line, picked from the existing SKU list, matching how every other picker in this app already works (no product-name literals anywhere in this codebase's business logic).
4. `regenerateSalesPlanForWeek(weekStartDate)` — reads a week's input + recipe lines, computes the 7-day, per-SKU, per-warehouse breakdown, and atomically replaces (never appends to) that week's `sales_plan` rows for the SKUs in its recipe.
5. Router: `salesPlan.listWeeklyInputs`, `salesPlan.upsertWeeklyInput`.
6. Frontend: a new section (on `StockPage.tsx`, below the existing `SalesPlanSection`, kept as its own clearly separated block per the earlier "logic stays separate" nav-restructuring rule) — an editable grid of upcoming weeks, each independently save-and-regenerate-able.

**Non-goals:** this feature never touches `sales_actuals` (real Shopify-pulled history) — it only ever writes `sales_plan` rows, and only for weeks that are not entirely in the past. Distributing weekly revenue across the 7 days is a flat `revenue / 7` — no day-of-week pattern (Mon busier than Sun, etc.) is modeled; there's no evidence yet to justify one, and a flat split is easy to reason about and easy to replace later if real data suggests otherwise.

## 3. Schema

### 3a. `sales_plan`'s missing uniqueness

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
```

`createSalesPlanEntry` (`server/salesPlan.ts:22-29`) becomes an upsert:

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

**Ruling — re-entering a plan for the same SKU/warehouse/day replaces it, silently.** No confirmation, no history of the overwritten value (unlike `change_log`-tracked fields elsewhere in this app). This is a deliberate scope limit: `sales_plan` has never been audited via `change_log` (it's a forecast, not a financial commitment like a PO or payment), and adding that now is out of scope for what this feature needs. **Cost if wrong:** a plan value could be silently overwritten with no record of the old one; revisit if planning entries ever need an audit trail.

### 3b. New tables

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

`weekStartDate` is always a Monday (the frontend only ever offers Monday dates; the backend does not re-validate this — see Section 6, Non-goals-adjacent scope call). `primaryPercent` is a string like `"70.00"` meaning 70% of each recipe line's computed units go to `primaryWarehouseId`; the remainder goes to `secondaryWarehouseId`. Naming is generic (`primary`/`secondary`), not `ff`/`mutual` — this app's business logic never hardcodes a specific client's warehouse names (matches every other picker in this codebase).

## 4. `regenerateSalesPlanForWeek`

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

**No transaction opened inside this function.** `DbClient` (`server/dbClient.ts`) is a union of the pool-backed `db` and a `db.transaction(...)` callback's scoped client — the latter cannot itself open a nested transaction. This function is always called from within `upsertWeeklyInput`'s own transaction (Section 5), which passes its `tx` through as `dbClient` — the delete-then-insert pair is atomic as part of that outer transaction, not on its own. Tests that call this function directly (not through `upsertWeeklyInput`) accept the narrower window between its own delete and insert as a test-only simplification — there is no other real call site.

**Ruling — largest-remainder rounding, not two independent roundings.** `totalUnitsRounded` is computed once per SKU/day; `primaryUnits` is rounded from that already-whole number, and `secondaryUnits` is the exact remainder (`totalUnitsRounded - primaryUnits`), never independently rounded. This guarantees the two warehouse quantities always sum to exactly the intended daily total — rounding both halves independently (e.g. `Math.round(raw * pct)` and `Math.round(raw * (1-pct))`) can silently disagree by 1 unit in either direction. **Cost if wrong:** a ±1-unit-per-SKU-per-day drift between the sum of both warehouses' plans and the "intended" daily total — negligible at real volume, but this ruling avoids it entirely at no extra cost.

**Ruling — delete-then-insert inside one transaction, not per-row upsert.** Simpler to read and verify than composing a multi-row `ON DUPLICATE KEY UPDATE` across up to `7 days × N recipe lines × 2 warehouses` rows with different values each; matches this codebase's existing convention (e.g. this exact file's own test cleanup blocks, `markShipmentArrived`'s combined update) of "delete the old state, write the new state, one transaction." The `DELETE` is scoped tightly (only the SKUs in *this* week's recipe, only *this* week's date range, only the two warehouses named in *this* week's input) — it cannot touch a manually-entered plan row for a different SKU or a different week.

**`enumerateDateStrings(from: Date, to: Date): string[]` already exists** — it's a private (unexported) function in `server/dashboards.ts:11-18`. Export it from there and import it into `server/salesPlan.ts` rather than duplicating it (this codebase's own `getDailyCogsForRange` in the same file already has similar date-window logic, but no shared helper — this is the first cross-file reuse of it, worth doing properly instead of copy-pasting a third implementation).

## 5. Router

```ts
salesPlan: router({
  // ...existing create/volatility/planActualDeviation unchanged...
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
}),
```

`listWeeklyInputs(from, to)` returns each week's input row plus its recipe lines (a small join, shaped as `{ ...weekInput, recipeLines: [...] }[]`) — the frontend needs both to render the grid.

`upsertWeeklyInput(input)` opens one `db.transaction` wrapping all three steps, passing `tx` into each:
1. Upsert the `sales_plan_weekly_inputs` row (`onDuplicateKeyUpdate` keyed on `weekStartDate`, same pattern as Section 3a).
2. Delete all existing `sales_plan_weekly_recipe_lines` for that `weeklyInputId`, insert the new set — the recipe is replaced wholesale on every save, not diffed line-by-line (this input is small, at most a handful of SKUs; diffing would be more code for no real benefit).
3. Call `regenerateSalesPlanForWeek(weekStartDate, tx)` — passing the same transaction's client, per Section 4's note that this function never opens its own.

If `regenerateSalesPlanForWeek` throws (e.g. a fully-past week), the whole transaction rolls back — nothing is saved, matching the "fail loudly, no partial write" convention already established for `markShipmentArrived`.

## 6. Frontend

New section in `client/src/pages/StockPage.tsx`, below the existing `SalesPlanSection` (kept visually and structurally separate — its own heading, its own component, per the earlier "don't blend logic onto one board" rule):

```tsx
function WeeklySalesPlanSection() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const weeks = useMemo(() => nextMondays(26), []); // 26 upcoming Monday dates, YYYY-MM-DD strings
  const inputsQuery = trpc.salesPlan.listWeeklyInputs.useQuery({
    from: new Date(weeks[0]),
    to: new Date(weeks[weeks.length - 1]),
  });
  // ...renders one <WeeklyPlanRow> per date in `weeks`, passing it the matching
  // existing input (if any) from inputsQuery.data, or a blank default...
}
```

Each row (`WeeklyPlanRow`) is its own small stateful component (same pattern as `PlannedDepartureControl`/`CustomsArrivalControl` elsewhere in this codebase): revenue input, two warehouse `<select>`s (primary/secondary) with a primary-% input, a small recipe-line list (SKU `<select>` + units-per-1000 input, add/remove — same builder pattern as the new `CreateShipmentForm`/`CreatePoForm` line-item pickers), and one "Save & regenerate" button calling `salesPlan.upsertWeeklyInput`. A week that is entirely in the past (per Section 4's rule) renders read-only with no save button rather than letting the user hit an error — cheap to check client-side (`weekStartDate + 6 days < today`) since the backend already enforces it.

`nextMondays(n)`: a small pure client-side helper computing the next `n` upcoming Monday dates as `YYYY-MM-DD` strings, starting from the current week's Monday (so an in-progress week is still editable, matching "planning applies to now-and-future"). No backend call needed to know which weeks to show — only to know which of them already have saved data.

## 7. Global constraints

- No day-of-week revenue distribution pattern — flat `revenue / 7`, per Section 2's stated non-goal.
- `sales_actuals` is never written or read by any function in this feature.
- Every `regenerateSalesPlanForWeek` call is idempotent — re-running it for the same week with the same input produces the same `sales_plan` rows, never duplicates, never leaves stale rows from a since-removed recipe line (the delete step is unconditional for that week+SKU-set+warehouse-pair before the insert).
- No new npm dependencies; no caching.
- Every new/changed value proven against real seeded data in tests, not just asserted — matching every prior stream's convention.
