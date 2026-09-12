# Backlog — Post-V1 Hardening

Source: the final whole-branch review after V1's 20 tasks (see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md)), plus the deferred-minor triage that review ran against everything parked during the build. Every item here is a real finding, not a guess — each was independently verified against the actual code, not just asserted.

Grouped into six work streams (A–F). Recommended order: **B → A → E → C → D**, with F riding along with whichever other stream touches the same files. Reasoning: B and A are what make the system honestly comparable against Control Tower during the parallel run; C and D matter most once real client staff and real data volume show up, which comes after that.

Status legend: ✅ done · ⬜ open

---

## A. Wiring completion

Backend logic exists and is tested; no router procedure or UI exposes it. Recommended as **one single task**, not nine — the review explicitly called this out as a checklist item, not nine separate features.

- ⬜ `sales_plan` row creation — no insert path anywhere. Without it, `getPlanActualDeviation` can never return a non-zero result and the spec's "Daily COGS/Sales (actual vs plan)" tab structurally cannot work.
- ⬜ Shipment progression past `departed` — no way to reach `customs`/`delivered`, set `customsStatus`, or record `actualArrivalDate` through the app. The spec's Shipments dashboard ("freight/customs/ETA") is half-built without this.
- ⬜ `payments.history` — `markPaymentPaid` writes real `change_log` rows, but there's no router procedure to read them back. The spec's "show history on any PO/Shipment/**Payment** record" is unreachable for payments specifically.
- ⬜ `listPaymentsForPo` — the Task 16b payments UI is session-local: a user who reloads the Purchase Orders page loses sight of payments they already created (they're safely in the DB, just not re-listed).
- ⬜ `getSalesVolatility` / `getPlanActualDeviation` — computed, tested, never surfaced on any dashboard.
- ⬜ `listShipmentsForPo` — exists, unused by any router/UI (the PO↔Shipment many-to-many link the spec calls for isn't visible anywhere yet).
- ⬜ `matchTransaction` — router procedure exists (Task 16b), but no UI calls it; Money's Cashflow tab shows only an unmatched-transaction *count*, not a list with a match action, so the procedure is currently dead from the UI's perspective.

## B. Migration & cutover readiness

Do this before the real parallel run against Control Tower starts — cheap now, expensive once real financial data is loaded.

- ⬜ **Migration scope**: `scripts/migrate-from-sheet.ts` only migrates `inventory_ledger`. The spec's Migration Plan step 1 requires PO/Shipment/**Ledger**/Payment/Transaction; step 2 requires reconciling landed-cost totals, not just SOH. Currently the "cutover gate" would greenlight a migration that moved no POs, shipments, payments, or transactions.
- ⬜ **CLI entrypoints**: neither `runMigration` nor `generateParallelRunReport` has one — both are library functions today, callable only from a REPL. Needs an actual script a human runs.
- ⬜ **Referential integrity**: zero foreign keys anywhere in the schema (confirmed: `grep` across every migration returns 0 `FOREIGN KEY`/`REFERENCES`). Worst concrete case: `matchTransactionToPayment` writes `matchedPaymentId` with no check that either row exists or that the transaction isn't already matched — a typo silently orphans a transaction. `recordLedgerEvent` accepting a nonexistent `skuId`/`warehouseId` is the more consequential version: it undermines the ledger-is-the-source-of-truth invariant, and such orphaned rows would slip past migration reconciliation entirely (they sum into no SKU's total). Fix: FKs on the ownership edges, or at minimum explicit existence checks in these two functions.
- ⬜ **Unique constraint on SKU identifiers** — `(primary_identifier_type, identifier_value)` was parked during the build "before real end-user SKU data entry begins." `runMigration` auto-creates SKUs from Sheet rows, which is exactly that trigger — do this before running a real migration, not after.
- ⬜ **No negative-stock validation** — the spec names this explicitly ("Validation failures (negative stock, invalid state transitions) block save with an explicit message — never silently allowed through"). `recordSalesActual`/`recordLedgerEvent` currently accept any quantity; `computeFifoCogs` only throws on insufficient stock when someone happens to *ask* for COGS, long after a bad row already landed.
- ⬜ **Shipments have no state machine** — unlike Purchase Orders (`VALID_TRANSITIONS` lookup table), `markShipmentDeparted` hard-sets `status: "departed"` with no transition check at all. Same class of gap the spec's "invalid state transitions" requirement is meant to close.

## C. Security hardening

Matters most once anyone other than Artem is actually operating the deployed instance.

- ⬜ **The role split isn't a real access boundary.** One shared `APP_PASSWORD` gates the identity list; anyone who knows it can select the `editor` identity and get full write access. The spec's intent (editor = the one SCAIT account with write access, viewer = client-side read-only) is expressible in the schema but not enforced by the login flow as built.
- ⬜ **Year-long session tokens, no revocation.** `SESSION_COOKIE` lives 365 days with no `jti`/blocklist; `POST /api/auth/logout` only clears the client cookie, so a captured token stays valid for a year regardless.
- ⬜ **No sign-out UI.** `/api/auth/logout` exists server-side; nothing in the client calls it. Combined with the year-long token and multi-identity design, there's no in-app way to switch identity or sign out on a shared machine.
- ⬜ Hand-rolled auth on top of `jose` — the spec's stated intent was "a standard session-based library (not built in-house)." Worth a deliberate decision on whether to replace it or explicitly accept the current approach.

## D. Performance

Won't matter until real Jello data volume loads — but the review flagged these as the first things that will fall over at ~10K SKUs (the spec's own stated target).

- ⬜ `getHomeSummary` — sequential per-SKU, per-warehouse loop calling `getAverageDailySales` individually. Unlike `getStockDashboard`, the outer loop isn't even parallelized.
- ⬜ `getMoneyDashboard`'s Daily COGS path — calls `getDailyCogs` once per day in the window, and **each call re-reads the entire ledger history and runs two full FIFO passes**. A 60-day window is 120 full-history FIFO computations. This is the path most likely to be the first to visibly slow down.
- ⬜ No grouped/aggregate queries for SOH-by-SKU-and-warehouse or trailing sales — everything is per-SKU round trips today.

## E. Systemic correctness risks

Not urgent today because no real production data has flowed through yet — will matter the moment it does.

- ⬜ **Daily Shopify pull isn't idempotent.** Re-running for the same day inserts duplicate `sales_actuals` rows *and* duplicate negative ledger events — silent double-counting of both SOH depletion and COGS. No unique constraint on `(sku_id, warehouse_id, date, source)`. There's also no cron wrapper or scheduler for it yet (unlike the nightly export, which has one) — currently a library function nobody calls automatically.
- ⬜ **Systemic date/timezone handling.** `TIMESTAMP` columns (`inventory_ledger.date`, `sales_actuals.date`, `sales_plan.period_date`, `purchase_orders.planned_ready_date`) are session-timezone-converted by MySQL, but every consumer treats them as calendar days via `.toISOString().slice(0, 10)`, with no pinned DB connection timezone. On any non-UTC server or browser this is a real off-by-one-day risk on COGS attribution, plan-vs-actual matching, and saved planned dates. Individually each instance looked Minor; together it's a systemic hazard in a system whose entire job is dates and money. Fix: Drizzle `date` (string mode) for calendar-day columns, pin `timezone: "Z"` on the MySQL pool.
- ⬜ **Landed-cost currency assumption not enforced.** `getShipmentLandedUnitCost` documents that the PO line's currency and the shipment's cost currency must already match the base currency, but nothing checks it — the UI lets a user type any currency string freehand for shipment costs. A two-line guard that throws on mismatch would make this fail loudly instead of producing nonsense.

## F. Cleanup (cheap, low-risk — fold into whichever other stream touches these files)

- ⬜ `REASON_CATEGORIES` is triplicated (`drizzle/schema.ts`, `PurchaseOrdersPage.tsx`, `ShipmentsPage.tsx`) — client should import the const array from the schema instead of hand-copying it.
- ⬜ `getHomeSummary` hardcodes a `daysOfCover < 21` check instead of reusing the `STOCK_STATUS_THRESHOLDS` table defined 40 lines above it in `dashboards.ts` — tune the table and Home silently disagrees with Stock.
- ⬜ Orphaned `vitest.setup.ts` — dead since an early fix removed its `setupFiles` reference; delete it.
- ⬜ Duplicate `AppRouter` type in `server/_core/trpc.ts` (`ReturnType<typeof router>`) shadowing the real one in `routers.ts` — delete the stale one.
- ⬜ `?t=${Date.now()}` query-string dynamic imports in `env.test.ts`/`auth.test.ts` are redundant now that `vi.resetModules()` handles cache-busting, and emit a harmless but noisy Vite warning on every test run — drop the query string.
- ⬜ `routers.ts`'s `createSku` procedure: `primaryIdentifierType: z.string()` + `createSku(input as any)` — should be `z.enum([...])`, removing the only `as any` in the router.
- ⬜ No index on `change_log (entity_type, entity_id)` — `listChangeLog` full-scans a table that grows with every cost/date edit. Add once history queries get slow, not urgent today.
- ⬜ `migrate-from-sheet.ts`: `event_type as "receipt"|"sale"|"adjustment"` with no runtime validation, and unguarded `parseFloat`/`new Date` — worth tightening given this script's whole job is being a trustworthy gate.
- ⬜ `@vitejs/plugin-react` is a devDependency but never registered in `vite.config.ts` — `pnpm dev` has no Fast Refresh without it (one line to fix).

---

## Already fixed (for reference — see BUILD-HISTORY.md for detail)

✅ No login UI / no way to create the first user (C1)
✅ Production server didn't serve the built frontend (C2)
✅ Cashflow silently blended currencies — including the Home-dashboard-level residual found in the fix-wave re-review (C3)
✅ Documented `pnpm test` command failed under default parallelism (I1)
✅ `getAverageDailySales` wrong divisor + no date window, silently wrong stockout-risk flags (I2)
✅ StockPage not rendering the days-of-cover/status/warehouse-name data the backend already computed (I4)
