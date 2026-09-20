# Performance Hardening (Backlog Stream D) — Design

## Context & Motivation

V1's final whole-branch review flagged three query patterns as "won't matter until real Jello data volume loads — but the first things that will fall over at ~10K SKUs," the spec's own stated target. All three live in `server/dashboards.ts` and are variations on the same root cause: an N-round-trips-per-request pattern where the server issues one database query per SKU (or per SKU/warehouse pair, or per day) inside a loop, instead of one aggregate query covering the whole request.

`getHomeSummary` and `getStockDashboard` each call `getSohByWarehouse(skuId)` once per active SKU, and `getAverageDailySales(skuId, warehouseId)` once per SKU/warehouse pair inside that — at 10,000 active SKUs across a handful of warehouses, that's thousands of sequential awaited round trips per dashboard load. `getMoneyDashboard`'s Daily COGS path is worse in a different dimension: it calls `getDailyCogs(skuId, warehouseId, dateKey)` once per day in the requested window, and each call re-reads that SKU/warehouse's *entire* ledger history from scratch and runs two full FIFO consumption passes over it — a 60-day window is 120 full-history FIFO computations for one dashboard load.

The obvious first fix — wrap each loop's body in `Promise.all` — was considered and rejected: parallelizing 10,000 concurrent queries would exhaust the mysql2 connection pool (or overwhelm the database) rather than actually help, trading one bottleneck for a worse one. The real fix is fewer, larger queries: replace each N-round-trips loop with one grouped (`GROUP BY`) aggregate query covering every SKU/warehouse the request needs, and replace `getDailyCogs`'s per-day full recomputation with a single query plus a single chronological forward pass that accumulates each day's cost incrementally instead of recomputing history from scratch per day.

## Goals

- `getHomeSummary` and `getStockDashboard` each issue a small, constant number of database queries regardless of how many active SKUs exist — not one query (or more) per SKU.
- The Daily COGS path in `getMoneyDashboard` issues one query per requested SKU/warehouse, not one per day in the window, and computes the whole window's daily breakdown in a single forward pass over the ledger instead of two full FIFO passes per day.
- Every existing dashboard behavior (returned shapes, computed values, thresholds, error conditions) stays byte-for-byte identical — this is a performance refactor, not a behavior change. Every claim of "produces the same result" is backed by a test proving it against real data, not just asserted.

## Non-Goals

- Caching, precomputed/materialized aggregate tables, or any persisted derived state — introduces staleness-invalidation risk, which this whole engagement has spent four prior streams hardening against. A grouped query recomputed live on each request is slower per-request than a cache but has zero invalidation-correctness surface; that trade is correct for this system's actual priority (correctness over raw speed) at its actual scale (a single-tenant deployment, not a multi-tenant SaaS with heavy concurrent read load).
- Chunking large `IN (...)` id lists into batches — a single query with up to ~10,000 integer ids in an `IN` clause is an entirely ordinary aggregate-query size for MySQL/TiDB; adding batching logic here would be complexity with no evidence it's needed at this stream's stated target scale.
- Query-count or wall-clock timing tests in the automated suite — this codebase has no query-counting instrumentation anywhere, and a wall-clock assertion against a local loopback MySQL instance would be unreliable (fast local round trips can mask an N+1 pattern that would be genuinely slow against a real networked database) rather than a meaningful regression guard. Verification here is structural: each task's reviewer confirms by reading the code that a per-item loop-with-await was actually replaced by a single grouped query, and correctness is proven by tests against real seeded data.
- Any change to `inventory_ledger`'s fundamental append-only, full-history-aggregate design (e.g., materialized running-balance snapshots to bound `getSoh`'s own full-table scan as the ledger grows over years) — a real, separate, larger concern already implicitly accepted by every prior stream's design, not something BACKLOG asks this stream to solve, and out of proportion to the specific N+1 patterns this stream targets.
- Any change to `computeFifoCogs`'s own per-sale-event batch-lookup algorithm (a linear scan for the oldest available batch) — its cost is proportional to real business complexity (how many receipt batches exist), not artificially inflated by how often the dashboard is refreshed, which is what this stream actually targets.

## Design

### 1. `getHomeSummary` / `getStockDashboard` — batched SOH and average-daily-sales queries

Two new functions replace the per-item queries these two dashboard functions currently call in a loop:

- `getSohForSkus(skuIds: number[]): Promise<Map<number, { warehouseId: number; soh: number }[]>>` in `server/inventoryLedger.ts`, replacing `getSohByWarehouse(skuId)` (deleted — nothing else calls it once this lands). One query: `SELECT skuId, warehouseId, SUM(qty) FROM inventory_ledger WHERE skuId IN (...) GROUP BY skuId, warehouseId`, then grouped into a `Map` keyed by `skuId` in application code.
- `getAverageDailySalesForSkus(skuIds: number[], windowDays = 30): Promise<Map<string, number>>` (a private helper in `dashboards.ts`, replacing the current private `getAverageDailySales`), keyed by the composite string `` `${skuId}:${warehouseId}` `` — matching this codebase's existing composite-key convention (e.g. the migration reconciliation code's `` `${poNumber}::${sku}` `` keys). One query: `SELECT skuId, warehouseId, SUM(qty) FROM sales_actuals WHERE skuId IN (...) AND date >= windowStart GROUP BY skuId, warehouseId`, divided by `windowDays` per group in application code.

`getHomeSummary` and `getStockDashboard` both change from "loop over SKUs, `await` a query per SKU (and per warehouse inside that)" to "fetch the active SKU list once, call both batched functions once each with the full list of SKU ids, then loop over SKUs purely in memory" — zero further database round trips inside either loop. The SOH map's per-SKU warehouse list stays authoritative (a SKU can have SOH history in a warehouse with no sales yet; the reverse can't happen, since `recordSalesActual` always writes a matching ledger "sale" event in the same transaction, so every warehouse with sales data necessarily also has SOH data) — a missing entry in the average-sales map for a given SKU/warehouse pair means 0, exactly matching today's behavior where a SKU/warehouse with no `sales_actuals` rows yields `avgDailySales = 0`.

### 2. `getMoneyDashboard`'s Daily COGS path — one query, one forward pass

`getDailyCogs(skuId, warehouseId, dateKey)` (single day, full-history recomputation) is replaced by `getDailyCogsForRange(skuId, warehouseId, dateKeys: string[]): Promise<{ date: string; cogs: number }[]>` in `server/salesPlan.ts`, called once per dashboard request instead of once per day in the window.

It fetches the ledger once, bounded to events on or before the end of the requested window's last day (events strictly after the window can't affect FIFO consumption for any day inside it, so there's no reason to fetch them) — `WHERE skuId = ? AND warehouseId = ? AND date <= <end of dateKeys[last]> ORDER BY date`. It then walks the resulting sales in chronological order exactly once, consuming from the same mutable `batches` array `computeFifoCogs` already uses (oldest-available-batch-first), and accumulates each unit's cost into a per-calendar-day running total — but only for days that appear in the requested `dateKeys`; sales on earlier dates (needed to correctly deplete batches in FIFO order, even though they're outside the window) are consumed but not accumulated into the output.

This produces byte-identical output to calling the old `getDailyCogs` once per day: the old function's `cogsUpToDate - cogsBeforeDate` subtraction was computing exactly "the FIFO cost of consuming that day's own sales, given batches already depleted by everything strictly earlier" — which is precisely what a single forward pass consuming sales in chronological order and bucketing cost by each sale's own day already produces, just computed once instead of being independently re-derived from scratch for every day in the window. (Verified by hand against this codebase's own existing `getDailyCogs` test scenario — the two receipt-batch, two-sale-date FIFO case in `salesPlan.test.ts` — before writing this design, not just asserted here.)

The "insufficient stock" throw `computeFifoCogs` can raise is preserved with identical semantics in the new function's inline consumption loop. This doesn't change `getMoneyDashboard`'s caller-visible failure behavior at all: today, `getMoneyDashboard` calls `Promise.all` over one `getDailyCogs` call per day, and `Promise.all` already rejects the whole array the moment any single day's call throws — so a mid-window insufficient-stock condition already fails the entire dashboard request today, exactly as the new single-call version would.

### 3. Router and dashboard call-site changes

`getMoneyDashboard` (`server/dashboards.ts`) changes its Daily COGS block from mapping `enumerateDateStrings(from, to)` through `Promise.all(dateKeys.map(dateKey => getDailyCogs(...)))` to a single `await getDailyCogsForRange(opts.skuId, opts.warehouseId, dateKeys)` call. No change to `getMoneyDashboard`'s own signature, return shape, or any router procedure in `server/routers.ts` — this is entirely an internal implementation change behind an unchanged public interface.

## Testing

`server/inventoryLedger.test.ts` gets a new test for `getSohForSkus`: seed 3 SKUs across 2 warehouses with different ledger histories (including one SKU with zero ledger rows, to confirm it's simply absent from the returned map rather than present with an empty array or throwing), call `getSohForSkus` with all 3 SKU ids in one call, and assert the returned map's per-SKU/per-warehouse breakdown matches hand-computed expected totals — proving the single grouped query correctly reconstructs the same per-pair breakdown the deleted per-SKU function used to require N calls for.

`server/dashboards.test.ts` gets equivalent multi-SKU scenarios for `getHomeSummary` and `getStockDashboard` (at least 3 SKUs, some sharing a warehouse, at least one with no sales history) proving the batched implementation's output is identical in shape and value to what the old per-item implementation would have produced for the same seeded data — every existing single-SKU test in this file continues to pass unchanged as a regression check that the refactor didn't alter single-SKU behavior.

`server/salesPlan.test.ts`'s existing `getDailyCogs` FIFO test (two receipt batches, two sale dates) is ported to call `getDailyCogsForRange` with both dates in one `dateKeys` array and asserts both days' costs in the single returned array match the exact same expected values the old two separate calls asserted — proving the new function's output is identical to the old one's for the scenario that motivated the original "not each day in isolation" design comment. A new test adds a third day with no sales at all inside the window to confirm a zero-sales day correctly returns `cogs: 0` rather than being omitted from the result array.

## Open Questions

None.
