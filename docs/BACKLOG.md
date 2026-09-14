# Backlog — Post-V1 Hardening

Source: the final whole-branch review after V1's 20 tasks (see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md)), plus the deferred-minor triage that review ran against everything parked during the build. Every item here is a real finding, not a guess — each was independently verified against the actual code, not just asserted.

Grouped into six work streams (A–F). Recommended order: **B → A → E → C → D**, with F riding along with whichever other stream touches the same files. Reasoning: B and A are what make the system honestly comparable against Control Tower during the parallel run; C and D matter most once real client staff and real data volume show up, which comes after that. **B is done (2026-09-14)** — A is next.

Status legend: ✅ done · ⬜ open

---

## A. Wiring completion

Backend logic exists and is tested; no router procedure or UI exposes it. Recommended as **one single task**, not nine — the review explicitly called this out as a checklist item, not nine separate features.

- ⬜ `sales_plan` row creation — no insert path anywhere. Without it, `getPlanActualDeviation` can never return a non-zero result and the spec's "Daily COGS/Sales (actual vs plan)" tab structurally cannot work.
- ⬜ Shipment progression past `departed` — no way to reach `customs`/`delivered`, set `customsStatus`, or record `actualArrivalDate` through the app. The spec's Shipments dashboard ("freight/customs/ETA") is half-built without this. **Also build a way to correct an already-recorded actual depart date**: Stream B's shipment state machine (`VALID_SHIPMENT_TRANSITIONS`) now makes `markShipmentDeparted` reject being called a second time on the same shipment — closing a real gap (no transition check existed before) but also permanently removing the only way ops had to fix a wrongly-entered date, with no replacement built (deliberately out of Stream B's hardening-only scope). Whoever wires up this stream's router/UI needs to build that correction path alongside exposure, not just the forward-progression happy path.
- ⬜ `payments.history` — `markPaymentPaid` writes real `change_log` rows, but there's no router procedure to read them back. The spec's "show history on any PO/Shipment/**Payment** record" is unreachable for payments specifically.
- ⬜ `listPaymentsForPo` — the Task 16b payments UI is session-local: a user who reloads the Purchase Orders page loses sight of payments they already created (they're safely in the DB, just not re-listed).
- ⬜ `getSalesVolatility` / `getPlanActualDeviation` — computed, tested, never surfaced on any dashboard.
- ⬜ `listShipmentsForPo` — exists, unused by any router/UI (the PO↔Shipment many-to-many link the spec calls for isn't visible anywhere yet).
- ⬜ `matchTransaction` — router procedure exists (Task 16b), but no UI calls it; Money's Cashflow tab shows only an unmatched-transaction *count*, not a list with a match action, so the procedure is currently dead from the UI's perspective.

## B. Migration & cutover readiness — ✅ DONE (2026-09-14, see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) for the full build/review narrative)

Preparatory hardening only — **not** a real migration against real Jello/Accommerce data, which remains a separate, later, explicitly-gated decision.

- ✅ **Migration scope** widened from ledger-only to full PO/Shipment/Payment/Transaction, with per-entity quarantine (malformed rows skipped and reported, never silently dropped, never abort the whole run) — including retrofitting the same quarantine treatment onto the original V1 ledger transform, which had none.
- ✅ **CLI entrypoints**: `scripts/run-migration.mjs` and `scripts/run-parallel-check.mjs`, documented in `RAILWAY.md`.
- ✅ **Referential integrity**: real foreign keys on all 10 core ownership edges (PO/shipment line items, payments, transactions, inventory ledger), plus an app-level guard against re-matching an already-matched transaction.
- ✅ **Unique constraint on SKU identifiers** — composite `(primaryIdentifierType, identifierValue)` via a generated column, enforced NOT NULL.
- ✅ **Negative-stock validation** — `recordLedgerEvent` throws before writing an event that would drive SOH negative; applies during migration too, not bypassed for historical data. `recordSalesActual` (the other write path) is now atomic with its own ledger write, so a rejected event can't leave an orphaned `sales_actuals` row.
- ✅ **Shipments have a state machine** — `VALID_SHIPMENT_TRANSITIONS`, mirroring the existing PO pattern. Not yet exposed via any router/UI (that's Stream A's job, see below).
- ✅ Migration atomicity: `runMigration` wraps the whole write set in one DB transaction, correctly threaded end-to-end (verified during the final whole-branch review, which caught that a naive "wrap in `db.transaction`" attempt would have silently NOT been atomic without threading the transaction's own client through every helper call).
- ✅ Tolerance-based landed-cost reconciliation alongside the existing exact-match SOH check — machinery is built and tested, but genuinely NOT wired to a live data source yet (real Control Tower Sheet landed-cost column names are still unknown); `runMigration` throws loudly if you try to use it rather than silently no-op'ing.
- ✅ Squashed the local-only migration history before it ever reached a real deployment — an earlier fix-loop incident had left a `DELETE FROM skus` baked into the committed migration chain (harmless on the empty DB every real deployment starts from, but a landmine for any future non-empty one). Regenerated as one clean migration from the final schema.

**New, smaller items surfaced by Stream B's own build — genuinely deferred, not silently dropped:**
- ⬜ Duplicate-SKU-per-PO collision in the migration's line-item reference key (`${poNumber}::${sku}`) — two line items for the same SKU on one PO (e.g. two price tranches) will collide. Not fixed deliberately: the real Control Tower Sheet's actual line-item reference column format is unknown, and guessing at a new key scheme risks mismatching real data. Revisit once the real Sheet format is known (see `scripts/reconcile-migration.ts`'s comment at the map-building call site).
- ⬜ `recordLedgerEvent`'s negative-stock check-then-insert isn't wrapped in its own transaction — a theoretical TOCTOU race under concurrent calls for the same SKU/warehouse. Low risk for a single-operator system; worth a code comment if not a fix.
- ⬜ `updateShipmentStatus`/`markShipmentDeparted` destructure a possibly-missing row with no existence check (`Cannot read properties of undefined` on a bad id) — Task 6 in this same stream established the better convention (a named, clear error) in the same plan; these two should match it.
- ⬜ `run-migration.mjs` doesn't validate the input JSON's shape before use (a missing key produces a raw `Cannot read properties of undefined` reported as a generic failure).
- ⬜ `run-parallel-check.mjs`'s `getMigratedSoh` returns `0` for a completely unknown SKU/warehouse, which reads as "clean match" for a sheet row that also expects 0 rather than as "this SKU doesn't exist in the migrated DB at all" — a real gap vs. an empty one look the same.

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
- ⬜ `@vitejs/plugin-react` is a devDependency but never registered in `vite.config.ts` — `pnpm dev` has no Fast Refresh without it (one line to fix).
- ⬜ Three trivial cosmetic nits in Stream B's CLI scripts: an unused `db` import in `run-parallel-check.mjs`; `run-migration.mjs`'s "Migration failed and rolled back" wording is imprecise for failures that happen before any transaction opens (bad path, missing file, malformed JSON — still fails loudly with a clear reason and correct exit code, just misleading phrasing); a shebang-line inconsistency between the two new scripts and the pre-existing `run-nightly-export.mjs` pattern.

---

## Already fixed (for reference — see BUILD-HISTORY.md for detail)

✅ No login UI / no way to create the first user (C1)
✅ Production server didn't serve the built frontend (C2)
✅ Cashflow silently blended currencies — including the Home-dashboard-level residual found in the fix-wave re-review (C3)
✅ Documented `pnpm test` command failed under default parallelism (I1)
✅ `getAverageDailySales` wrong divisor + no date window, silently wrong stockout-risk flags (I2)
✅ StockPage not rendering the days-of-cover/status/warehouse-name data the backend already computed (I4)
