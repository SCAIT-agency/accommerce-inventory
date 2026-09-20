# Performance Hardening (Backlog Stream D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three N+1 query patterns in `server/dashboards.ts` (per-SKU SOH lookups, per-SKU/warehouse average-sales lookups, per-day Daily COGS recomputation) with grouped aggregate queries and a single incremental FIFO pass, with every dashboard's output staying byte-identical to today's behavior.

**Architecture:** Two new standalone batch functions (`getSohForSkus`, `getDailyCogsForRange`) land first as pure additions alongside the existing single-item functions they'll replace, each independently tested. A third task then rewires all three dashboard functions in `dashboards.ts` to use the new batch functions (plus a new private `getAverageDailySalesForSkus` helper) purely in memory, and deletes the now-unused old single-item functions and their direct tests in the same task — avoiding any intermediate state where the build is broken.

**Tech Stack:** Existing Drizzle ORM (`inArray`, `groupBy`, `sql` template for `SUM`), no new libraries.

**Spec:** `docs/2026-09-20-performance-hardening-design.md`

## Global Constraints

- No new npm dependencies.
- No caching, precomputed/materialized tables, or persisted derived state anywhere in this plan.
- No chunking of `IN (...)` id lists — a single query with the full SKU-id list is correct at this stream's target scale.
- No query-count or wall-clock timing tests — verification is structural (a task reviewer confirms by reading the diff that a per-item loop-with-await was replaced by a single grouped query) plus correctness tests against real seeded data.
- Every dashboard function's returned shape and computed values must stay byte-identical to current behavior for every scenario already covered by an existing test — every existing test in `server/dashboards.test.ts`, `server/inventoryLedger.test.ts`, and `server/salesPlan.test.ts` not explicitly named for deletion in this plan must continue to pass unchanged.
- `getDailyCogsForRange`'s ledger query must be bounded to events on or before the end of the last requested date in `dateKeys` (events strictly after the window cannot affect FIFO consumption for any day inside it).
- `computeFifoCogs` (`server/landedCost.ts`) is NOT touched by this plan — it has its own independent test coverage and its own caller (`getShipmentLandedUnitCost`) outside this plan's scope. `getDailyCogsForRange` reimplements the same "find oldest available batch, consume, repeat" loop inline (to add per-day cost bucketing, which `computeFifoCogs`'s signature doesn't support) rather than calling it — a deliberate small duplication, not an oversight.

---

### Task 1: `getSohForSkus` — batched SOH aggregate query

**Files:**
- Modify: `server/inventoryLedger.ts`
- Modify: `server/inventoryLedger.test.ts`

**Interfaces:**
- Produces: `getSohForSkus(skuIds: number[]): Promise<Map<number, { warehouseId: number; soh: number }[]>>` — a SKU id absent from the input, or present but with zero ledger rows, is simply absent as a key in the returned map (not present with an empty array).

This task is purely additive — `getSohByWarehouse` (the function this will eventually replace) is untouched and still used by `dashboards.ts` until Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `server/inventoryLedger.test.ts` (inside the existing `describe("inventory ledger", ...)` block):

```typescript
it("returns per-SKU/per-warehouse SOH breakdowns for multiple SKUs in one call, omitting a SKU with no ledger history entirely", async () => {
  const skuA = await createSku({ sku: "JELLO-A", primaryIdentifierType: "sku" });
  const skuB = await createSku({ sku: "JELLO-B", primaryIdentifierType: "sku" });
  const skuC = await createSku({ sku: "JELLO-C", primaryIdentifierType: "sku" }); // no ledger rows at all
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

  await recordLedgerEvent({ skuId: skuA.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
  await recordLedgerEvent({ skuId: skuA.id, warehouseId: mutual.id, eventType: "receipt", qty: 300, unitCost: "0.45", date: new Date("2026-09-01"), sourceRef: "PO1-Local" });
  await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO2" });
  await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-1" });

  const result = await getSohForSkus([skuA.id, skuB.id, skuC.id]);

  expect(result.get(skuA.id)).toEqual(
    expect.arrayContaining([
      { warehouseId: ff.id, soh: 1000 },
      { warehouseId: mutual.id, soh: 300 },
    ]),
  );
  expect(result.get(skuB.id)).toEqual([{ warehouseId: ff.id, soh: 450 }]);
  expect(result.has(skuC.id)).toBe(false);
});

it("returns an empty map for an empty skuIds array, without querying the database", async () => {
  const result = await getSohForSkus([]);
  expect(result.size).toBe(0);
});
```

Add `getSohForSkus` to the existing import line from `./inventoryLedger` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: FAIL — `getSohForSkus` does not exist yet.

- [ ] **Step 3: Write the implementation**

In `server/inventoryLedger.ts`, add `inArray` to the existing `drizzle-orm` import line (`import { and, eq, inArray, lte, sql } from "drizzle-orm";`), and add this function (placed after `getSoh`, before `getSohByWarehouse`):

```typescript
export async function getSohForSkus(skuIds: number[]): Promise<Map<number, { warehouseId: number; soh: number }[]>> {
  const result = new Map<number, { warehouseId: number; soh: number }[]>();
  if (skuIds.length === 0) return result;

  const rows = await db
    .select({
      skuId: inventoryLedger.skuId,
      warehouseId: inventoryLedger.warehouseId,
      soh: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)`,
    })
    .from(inventoryLedger)
    .where(inArray(inventoryLedger.skuId, skuIds))
    .groupBy(inventoryLedger.skuId, inventoryLedger.warehouseId);

  for (const row of rows) {
    const existing = result.get(row.skuId) ?? [];
    existing.push({ warehouseId: row.warehouseId, soh: row.soh });
    result.set(row.skuId, existing);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: PASS (all tests in this file, including the 2 new ones).

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass (this is a pure addition — nothing else changes).

- [ ] **Step 6: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: add getSohForSkus, a batched grouped-query alternative to per-SKU SOH lookups"
```

---

### Task 2: `getDailyCogsForRange` — one query, one forward FIFO pass

**Files:**
- Modify: `server/salesPlan.ts`
- Modify: `server/salesPlan.test.ts`

**Interfaces:**
- Produces: `getDailyCogsForRange(skuId: number, warehouseId: number, dateKeys: string[]): Promise<{ date: string; cogs: number }[]>` — returns exactly one entry per input `dateKey` (in the same order), with `cogs: 0` for any day with no sales, never omitting a day. An empty `dateKeys` array returns `[]` without querying the database. `dateKeys` is assumed sorted ascending (as `enumerateDateStrings` in `dashboards.ts`, its only caller after Task 3, already produces).

This task is purely additive — `getDailyCogs` (the function this will eventually replace) is untouched and still used by `dashboards.ts` until Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `server/salesPlan.test.ts` (inside the existing `describe("sales plan/actuals", ...)` block, near the existing `getDailyCogs` test):

```typescript
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
```

Add `getDailyCogsForRange` to the existing import line from `./salesPlan` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test server/salesPlan.test.ts`
Expected: FAIL — `getDailyCogsForRange` does not exist yet.

- [ ] **Step 3: Write the implementation**

In `server/salesPlan.ts`, add `lte` to the existing `drizzle-orm` import line (`import { and, between, desc, eq, lte } from "drizzle-orm";`), and add this function (placed after the existing `getDailyCogs`):

```typescript
/**
 * Same FIFO semantics as getDailyCogs, computed for a whole date range in one
 * query and one chronological forward pass instead of one query-plus-two-
 * full-FIFO-passes per day. Mathematically equivalent to calling getDailyCogs
 * once per day: consuming sales in chronological order against a single
 * shared, depleting `batches` array and bucketing each unit's cost by the
 * sale's own calendar day produces exactly the same per-day figure the old
 * "cost up to this day minus cost up to the day before" subtraction did,
 * since by the time a forward pass reaches a given day, the batches
 * remaining are exactly what "up to the day before" already implied.
 */
export async function getDailyCogsForRange(skuId: number, warehouseId: number, dateKeys: string[]): Promise<{ date: string; cogs: number }[]> {
  if (dateKeys.length === 0) return [];

  const windowEnd = new Date(`${dateKeys[dateKeys.length - 1]}T23:59:59.999Z`);
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId), lte(inventoryLedger.date, windowEnd)))
    .orderBy(inventoryLedger.date);

  const batches: LandedBatch[] = events
    .filter((e) => e.eventType === "receipt")
    .map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));

  const sales: SaleEvent[] = events
    .filter((e) => e.eventType === "sale")
    .map((e) => ({ qty: Math.abs(e.qty), date: e.date }));

  const dailyCogs = new Map<string, number>(dateKeys.map((d) => [d, 0]));

  for (const sale of sales) {
    const dateKey = sale.date.toISOString().slice(0, 10);
    let remainingToConsume = sale.qty;
    let consumedCost = 0;
    while (remainingToConsume > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= sale.date);
      if (!batch) {
        throw new Error(`insufficient stock: cannot consume ${remainingToConsume} units for sale on ${sale.date.toISOString()}`);
      }
      const consumed = Math.min(batch.qty, remainingToConsume);
      consumedCost += consumed * batch.unitCost;
      batch.qty -= consumed;
      remainingToConsume -= consumed;
    }
    if (dailyCogs.has(dateKey)) {
      dailyCogs.set(dateKey, dailyCogs.get(dateKey)! + consumedCost);
    }
  }

  return dateKeys.map((date) => ({ date, cogs: dailyCogs.get(date)! }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test server/salesPlan.test.ts`
Expected: PASS (all tests in this file, including the 2 new ones).

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/salesPlan.ts server/salesPlan.test.ts
git commit -m "feat: add getDailyCogsForRange, one query + one forward FIFO pass for a whole date range"
```

---

### Task 3: Rewire `dashboards.ts` to the batched functions; delete the now-dead per-item functions

**Files:**
- Modify: `server/dashboards.ts`
- Modify: `server/dashboards.test.ts`
- Modify: `server/inventoryLedger.ts` (delete `getSohByWarehouse`)
- Modify: `server/inventoryLedger.test.ts` (delete `getSohByWarehouse`'s direct test)
- Modify: `server/salesPlan.ts` (delete `getDailyCogs`)
- Modify: `server/salesPlan.test.ts` (delete `getDailyCogs`'s direct test)

**Interfaces:**
- Consumes: `getSohForSkus` (Task 1), `getDailyCogsForRange` (Task 2).
- `getHomeSummary()`, `getStockDashboard()`, `getMoneyDashboard(from, to, opts?)` — all three keep their exact existing exported signatures and return shapes; only their internal implementation changes. No router in `server/routers.ts` needs any change.

- [ ] **Step 1: Confirm nothing else calls the two functions this task deletes**

Run: `grep -rn "getSohByWarehouse\|getDailyCogs[^F]" server/ client/ scripts/ --include="*.ts" --include="*.tsx"`
Expected: only `server/inventoryLedger.ts`/`.test.ts` (for `getSohByWarehouse`) and `server/salesPlan.ts`/`.test.ts` (for `getDailyCogs`) — no hits in `server/dashboards.ts` yet (this step's grep runs BEFORE you edit `dashboards.ts` in Step 2, to confirm your starting assumption is still true before you act on it).

- [ ] **Step 2: Rewrite `server/dashboards.ts`**

Replace the entire contents of `server/dashboards.ts` with:

```typescript
import { and, gte, inArray, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { salesActuals } from "../drizzle/schema";
import { listSkus } from "./db";
import { getSohForSkus } from "./inventoryLedger";
import { listUnmatchedTransactions } from "./payments";
import { getCashflowForecast } from "./cashflow";
import { getDailyCogsForRange } from "./salesPlan";
import { getShipmentLandedUnitCost } from "./landedCost";

function enumerateDateStrings(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// In-code lookup for V1; move to app_settings-driven config when a real
// client needs to tune these thresholds — out of scope for this task.
const STOCK_STATUS_THRESHOLDS: { maxDays: number; label: "critical" | "low" | "ok" | "overstock" }[] = [
  { maxDays: 21, label: "critical" },
  { maxDays: 45, label: "low" },
  { maxDays: 90, label: "ok" },
  { maxDays: Infinity, label: "overstock" },
];

// shopifyDailyPull only writes a sales_actuals row on days a SKU actually
// sold, so the denominator must be calendar days in the window — not the
// number of rows that came back, which would inflate the average (and deflate
// days-of-cover) by the ratio of selling-days to calendar-days.
//
// One grouped query for every requested SKU at once, keyed by the composite
// string `${skuId}:${warehouseId}` (matching this codebase's existing
// composite-key convention, e.g. the migration reconciliation code's
// `${poNumber}::${sku}` keys) — replaces what used to be one query per
// SKU/warehouse pair.
async function getAverageDailySalesForSkus(skuIds: number[], windowDays = 30): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (skuIds.length === 0) return result;

  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      skuId: salesActuals.skuId,
      warehouseId: salesActuals.warehouseId,
      totalQty: sql<number>`CAST(COALESCE(SUM(${salesActuals.qty}), 0) AS SIGNED)`,
    })
    .from(salesActuals)
    .where(and(inArray(salesActuals.skuId, skuIds), gte(salesActuals.date, windowStart)))
    .groupBy(salesActuals.skuId, salesActuals.warehouseId);

  for (const row of rows) {
    result.set(`${row.skuId}:${row.warehouseId}`, row.totalQty / windowDays);
  }
  return result;
}

function getStockStatus(daysOfCover: number | null): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const bucket = STOCK_STATUS_THRESHOLDS.find((t) => daysOfCover < t.maxDays);
  return bucket?.label ?? "overstock";
}

export async function getHomeSummary() {
  const activeSkus = await listSkus("active");
  const skuIds = activeSkus.map((s) => s.id);
  const unmatched = await listUnmatchedTransactions();
  const forecast = await getCashflowForecast(new Date(), new Date(Date.now() + 14 * 86400000));
  const nearTermCashNeeds = forecast.reduce((sum, d) => sum + d.plannedOutflow, 0);

  const sohMap = await getSohForSkus(skuIds);
  const avgSalesMap = await getAverageDailySalesForSkus(skuIds);

  let stockoutRiskSkuCount = 0;
  for (const sku of activeSkus) {
    const byWarehouse = sohMap.get(sku.id) ?? [];
    let atRisk = false;
    for (const w of byWarehouse) {
      const avgDailySales = avgSalesMap.get(`${sku.id}:${w.warehouseId}`) ?? 0;
      const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
      if (daysOfCover !== null && daysOfCover < 21) {
        atRisk = true;
        break;
      }
    }
    if (atRisk) stockoutRiskSkuCount++;
  }

  return {
    activeSkuCount: activeSkus.length,
    stockoutRiskSkuCount,
    nearTermCashNeeds,
    unmatchedTransactionCount: unmatched.length,
  };
}

export async function getStockDashboard() {
  const activeSkus = await listSkus("active");
  const skuIds = activeSkus.map((s) => s.id);
  const sohMap = await getSohForSkus(skuIds);
  const avgSalesMap = await getAverageDailySalesForSkus(skuIds);

  const results = [];
  for (const sku of activeSkus) {
    const byWarehouse = sohMap.get(sku.id) ?? [];
    const enriched = byWarehouse.map((w) => {
      const avgDailySales = avgSalesMap.get(`${sku.id}:${w.warehouseId}`) ?? 0;
      const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
      return { ...w, avgDailySales, daysOfCover, status: getStockStatus(daysOfCover) };
    });
    results.push({ skuId: sku.id, sku: sku.sku, byWarehouse: enriched });
  }
  return results;
}

export async function getMoneyDashboard(
  from: Date,
  to: Date,
  opts?: { skuId?: number; warehouseId?: number; shipmentId?: number },
) {
  const cashflow = await getCashflowForecast(from, to);
  const unmatched = await listUnmatchedTransactions();

  let dailyCogs: { date: string; cogs: number }[] = [];
  if (opts?.skuId && opts?.warehouseId) {
    const dateKeys = enumerateDateStrings(from, to);
    dailyCogs = await getDailyCogsForRange(opts.skuId, opts.warehouseId, dateKeys);
  }

  let landedCost: { skuId: number; landedUnitCost: number }[] = [];
  let landedCostError: string | null = null;
  if (opts?.shipmentId) {
    try {
      landedCost = await getShipmentLandedUnitCost(opts.shipmentId);
    } catch (err) {
      landedCostError = err instanceof Error ? err.message : String(err);
    }
  }

  return { cashflow, unmatchedTransactions: unmatched, dailyCogs, landedCost, landedCostError };
}
```

(`getStockDashboard`'s inner `byWarehouse.map(...)` is now a plain synchronous `.map()`, not `Promise.all(byWarehouse.map(async ...))` — there's no more awaited call inside it, so the `async`/`Promise.all` wrapping is no longer needed. `getHomeSummary`'s inner warehouse loop stays a plain `for...of` exactly as before, since it never awaited anything inside either.)

- [ ] **Step 3: Delete `getSohByWarehouse` from `server/inventoryLedger.ts`**

Remove this function entirely (it sat after `getSoh` and before `getSohForSkus` — Task 1 added `getSohForSkus` right after `getSoh`, so `getSohByWarehouse` should now be the function immediately after `getSohForSkus`):

```typescript
export async function getSohByWarehouse(skuId: number): Promise<{ warehouseId: number; soh: number }[]> {
  const rows = await db
    .select({
      warehouseId: inventoryLedger.warehouseId,
      soh: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)`,
    })
    .from(inventoryLedger)
    .where(eq(inventoryLedger.skuId, skuId))
    .groupBy(inventoryLedger.warehouseId);
  return rows;
}
```

Check whether `eq` is still used elsewhere in this file after this deletion (it is — `recordLedgerEvent` and other code don't use it, but check the actual current file; if `eq` becomes unused, remove it from the `drizzle-orm` import line, otherwise leave the import line as Task 1 left it).

- [ ] **Step 4: Delete `getSohByWarehouse`'s direct test from `server/inventoryLedger.test.ts`**

Remove this test (its scenario — one SKU across two warehouses — is already covered by Task 1's new `getSohForSkus` test):

```typescript
it("never blends two warehouses into one SOH figure", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1-W1" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: mutual.id, eventType: "receipt", qty: 300, unitCost: "0.45", date: new Date("2026-09-01"), sourceRef: "PO1-Local" });

  const byWarehouse = await getSohByWarehouse(sku.id);
  expect(byWarehouse).toEqual([
    { warehouseId: ff.id, soh: 1000 },
    { warehouseId: mutual.id, soh: 300 },
  ]);
});
```

Remove `getSohByWarehouse` from this file's import line from `./inventoryLedger`.

- [ ] **Step 5: Delete `getDailyCogs` from `server/salesPlan.ts`**

Remove this function entirely (its doc comment stays useful context — move it to sit above `getDailyCogsForRange` if it isn't already positioned there from Task 2, since `getDailyCogsForRange`'s own new doc comment already explains the relationship, so just delete the old function and its old comment cleanly):

```typescript
/**
 * Daily COGS at `date` = cumulative FIFO cost of everything sold through `date`,
 * minus cumulative FIFO cost of everything sold through the day before. Computing
 * each day in isolation against the full (un-depleted) receipt set would double-count
 * batches already consumed by earlier sales — this is the same class of bug the real
 * Jello buildDailyCogs() clamp had (it didn't gate on whether a batch had actually
 * landed by the date being evaluated).
 */
export async function getDailyCogs(skuId: number, warehouseId: number, dateKey: string): Promise<number> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date);

  // Calendar-day comparison, not a raw timestamp <=: sale-derived ledger events
  // are now anchored at end-of-day (23:59:59.999), so a same-day sale would
  // fail a naive `e.date <= date` check against a midnight-anchored `date` arg.
  const receipts: LandedBatch[] = events
    .filter((e) => e.eventType === "receipt" && e.date.toISOString().slice(0, 10) <= dateKey)
    .map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));

  const salesUpToAndIncluding: SaleEvent[] = events
    .filter((e) => e.eventType === "sale" && e.date.toISOString().slice(0, 10) <= dateKey)
    .map((e) => ({ qty: Math.abs(e.qty), date: e.date }));
  const salesBeforeDate: SaleEvent[] = salesUpToAndIncluding.filter(
    (s) => s.date.toISOString().slice(0, 10) !== dateKey,
  );

  if (salesUpToAndIncluding.length === salesBeforeDate.length) return 0;

  const cogsUpToDate = computeFifoCogs(receipts, salesUpToAndIncluding).totalCogs;
  const cogsBeforeDate = computeFifoCogs(receipts, salesBeforeDate).totalCogs;
  return cogsUpToDate - cogsBeforeDate;
}
```

`computeFifoCogs`'s only call sites in this file were the two lines inside the now-deleted `getDailyCogs` — confirm this against the current file (grep `computeFifoCogs` in `server/salesPlan.ts`) before removing it, but it should come out: remove `computeFifoCogs` from this file's import line from `./landedCost` (`import { computeFifoCogs, type LandedBatch, type SaleEvent } from "./landedCost";` → `import type { LandedBatch, SaleEvent } from "./landedCost";`), keeping `LandedBatch`/`SaleEvent` since `getDailyCogsForRange` (Task 2) uses both types directly. `computeFifoCogs` itself is untouched in `server/landedCost.ts` — it keeps its own independent test coverage and its other caller (`getShipmentLandedUnitCost`), per Global Constraints; only this file's now-dead import of it goes away.

- [ ] **Step 6: Delete `getDailyCogs`'s direct test from `server/salesPlan.test.ts`**

Remove this test (its scenario is already ported to Task 2's new `getDailyCogsForRange` test):

```typescript
it("computes daily COGS via FIFO consumption across the full ledger history, not each day in isolation", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
  await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-03", qty: 80, source: "manual" });
  await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-10", qty: 40, source: "manual" });

  // Sept 3 sale (80 units) is fully covered by the first batch (@2.00) — the second batch hasn't landed yet.
  const cogsSept3 = await getDailyCogs(sku.id, ff.id, "2026-09-03");
  expect(cogsSept3).toBeCloseTo(80 * 2.0, 2);

  // Sept 10 sale (40 units) drains the remaining 20 units of batch 1 (@2.00), then 20 units of batch 2 (@2.50).
  const cogsSept10 = await getDailyCogs(sku.id, ff.id, "2026-09-10");
  expect(cogsSept10).toBeCloseTo(20 * 2.0 + 20 * 2.5, 2);
});
```

Remove `getDailyCogs` from this file's import line from `./salesPlan`.

- [ ] **Step 7: Write the new multi-SKU batching correctness tests**

Add to `server/dashboards.test.ts` (inside the existing `describe("dashboards", ...)` block):

```typescript
it("computes correct per-SKU stock figures for many SKUs from one batched query round, not per-SKU queries", async () => {
  const skuA = await createSku({ sku: "JELLO-MULTI-A", primaryIdentifierType: "sku", status: "active" });
  const skuB = await createSku({ sku: "JELLO-MULTI-B", primaryIdentifierType: "sku", status: "active" });
  const skuC = await createSku({ sku: "JELLO-MULTI-C", primaryIdentifierType: "sku", status: "active" }); // no ledger history
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

  await recordLedgerEvent({ skuId: skuA.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-A-FF" });
  await recordLedgerEvent({ skuId: skuA.id, warehouseId: mutual.id, eventType: "receipt", qty: 200, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-A-MUTUAL" });
  await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-B-FF" });

  for (let i = 0; i < 10; i++) {
    await recordSalesActual({ skuId: skuA.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 5, source: "manual" });
  }

  const stock = await getStockDashboard();

  const rowA = stock.find((r) => r.skuId === skuA.id);
  const ffA = rowA?.byWarehouse.find((w) => w.warehouseId === ff.id);
  const mutualA = rowA?.byWarehouse.find((w) => w.warehouseId === mutual.id);
  expect(ffA?.soh).toBe(450); // 500 - 50 sold
  expect(ffA?.avgDailySales).toBeCloseTo(50 / 30);
  expect(mutualA?.soh).toBe(200);
  expect(mutualA?.avgDailySales).toBe(0); // no sales recorded in this warehouse

  const rowB = stock.find((r) => r.skuId === skuB.id);
  const ffB = rowB?.byWarehouse.find((w) => w.warehouseId === ff.id);
  expect(ffB?.soh).toBe(300);
  expect(ffB?.avgDailySales).toBe(0);

  const rowC = stock.find((r) => r.skuId === skuC.id);
  expect(rowC?.byWarehouse).toEqual([]); // no ledger history at all -> empty byWarehouse, not omitted from results
});

it("counts stockout risk across many SKUs from one batched query round, not per-SKU queries", async () => {
  const riskSku = await createSku({ sku: "JELLO-RISK", primaryIdentifierType: "sku", status: "active" });
  const safeSku = await createSku({ sku: "JELLO-SAFE", primaryIdentifierType: "sku", status: "active" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  // riskSku: SOH 100 (400 received - 300 sold), sell 10/day -> daysOfCover 10 (< 21 -> at risk)
  await recordLedgerEvent({ skuId: riskSku.id, warehouseId: ff.id, eventType: "receipt", qty: 400, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-RISK" });
  for (let i = 0; i < 30; i++) {
    await recordSalesActual({ skuId: riskSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
  }

  // safeSku: SOH 970, sell 1/day -> daysOfCover 970 (not at risk)
  await recordLedgerEvent({ skuId: safeSku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-SAFE" });
  for (let i = 0; i < 30; i++) {
    await recordSalesActual({ skuId: safeSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 1, source: "manual" });
  }

  const summary = await getHomeSummary();
  expect(summary.activeSkuCount).toBe(2);
  expect(summary.stockoutRiskSkuCount).toBe(1);
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test server/dashboards.test.ts server/inventoryLedger.test.ts server/salesPlan.test.ts`
Expected: PASS — every existing test in these 3 files still passes unchanged, plus the 2 new tests in this step.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `pnpm test`
Expected: all tests pass.

Run: `pnpm check`
Expected: zero errors (this specifically confirms no leftover reference to the deleted `getSohByWarehouse`/`getDailyCogs` anywhere, and that removed/kept imports in `inventoryLedger.ts`/`salesPlan.ts` are correct).

- [ ] **Step 10: Verify live via the real API**

Start the server (`pnpm exec tsx server/_core/index.ts`), log in via the scriptable login flow, and call `dashboards.home`, `dashboards.stock`, and `dashboards.money` (with a real `skuId`/`warehouseId` scoping it to exercise the Daily COGS path) against real seeded data. Confirm the responses look sane (no errors, plausible numbers) — this is a smoke check that the router-level wiring still works end-to-end after the internal rewrite, not a new correctness proof (Steps 8-9 already prove correctness). Report the real observed responses. Stop the server when done.

- [ ] **Step 11: Commit**

```bash
git add server/dashboards.ts server/dashboards.test.ts server/inventoryLedger.ts server/inventoryLedger.test.ts server/salesPlan.ts server/salesPlan.test.ts
git commit -m "perf: replace per-SKU/per-day dashboard query loops with batched aggregate queries"
```

---

## Self-Review Notes

**Spec coverage check:** all 3 design sections map to tasks — Section 1 (batched SOH/avg-sales queries) → Task 1 (`getSohForSkus`) + Task 3 (`getAverageDailySalesForSkus`, wiring); Section 2 (`getDailyCogsForRange`) → Task 2; Section 3 (call-site changes, no router changes) → Task 3.

**Placeholder scan:** every step has real, complete code; no TBD/TODO. Task 3's Steps 3 and 5 include a conditional instruction ("check whether X is still used before removing its import") rather than a flat assertion — this is not a placeholder, it's an explicit instruction to verify a specific, narrow fact about the current file state before acting, since both files are being edited by earlier tasks in this same plan and their exact import-line state at the moment Task 3 runs should be verified rather than assumed.

**Type consistency cross-check:** `getSohForSkus`'s return type (`Map<number, { warehouseId: number; soh: number }[]>`, Task 1) is consumed identically in both `getHomeSummary` and `getStockDashboard` (Task 3) via `sohMap.get(sku.id) ?? []`. `getDailyCogsForRange`'s signature (`skuId, warehouseId, dateKeys: string[]`, Task 2) matches exactly how `getMoneyDashboard` (Task 3) calls it — `dateKeys` is the same array already produced by the existing `enumerateDateStrings(from, to)` call, not a new date-boundary shape. `getAverageDailySalesForSkus`'s composite-key format (`` `${skuId}:${warehouseId}` ``, Task 3) is used identically at both its write site (inside the function) and its two read sites (`getHomeSummary`, `getStockDashboard`).
