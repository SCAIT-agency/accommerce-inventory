# Backlog — Post-V1 Hardening

Source: the final whole-branch review after V1's 20 tasks (see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md)), plus the deferred-minor triage that review ran against everything parked during the build. Every item here is a real finding, not a guess — each was independently verified against the actual code, not just asserted.

Grouped into six work streams (A–F). Recommended order: **B → A → E → C → D**, with F riding along with whichever other stream touches the same files. Reasoning: B and A are what make the system honestly comparable against Control Tower during the parallel run; C and D matter most once real client staff and real data volume show up, which comes after that. **A, B, C, D, and E are all done** — remaining work is F (cleanup, opportunistic) plus the small deferred items each stream surfaced along the way.

Status legend: ✅ done · ⬜ open

---

## A. Wiring completion — ✅ DONE (2026-09-20, last item closed alongside Stream D's close-out)

Backend logic exists and is tested; no router procedure or UI exposes it. Recommended as **one single task**, not nine — the review explicitly called this out as a checklist item, not nine separate features.

- ✅ `sales_plan` row creation — `createSalesPlanEntry` + `salesPlan.create` router procedure + Stock page form, wired to `getSalesVolatility`/`getPlanActualDeviation`.
- ✅ Shipment progression past `departed` — `shipments.updateStatus` reaches `customs`/`delivered`; `setShipmentCustomsStatus`/`markShipmentArrived` cover customs status and actual arrival date; `correctShipmentActualDepartDate` covers correcting an already-recorded actual depart date. All wired to the Shipments page.
- ✅ `payments.history` — router procedure reading back `change_log` rows, wired to the Purchase Orders page.
- ✅ `listPaymentsForPo` — `payments.listForPo`, Purchase Orders page now re-lists from the DB instead of session-local state.
- ✅ `getSalesVolatility` / `getPlanActualDeviation` — surfaced on the Stock page's Sales Plan section.
- ✅ `listShipmentsForPo` — `shipments.listForPo`, surfaced on the Purchase Orders page.
- ✅ `matchTransaction` — wired to a real UI action on the Money page's Cashflow tab (`listUnpaidPayments` dropdown + match button), including the payment-double-matching and dropdown-identity fixes from the final review's fix wave (see `docs/2026-09-19-wiring-completion-design.md` Section 8 and the fix-wave report at `.superpowers/sdd/2026-09-19-wiring-completion/final-review-fix-report.md`).
- ✅ **UI now exists to set a shipment's `plannedDepartDate` and mark it departed with a real actual-depart-date.** New `PlannedDepartureControl` on the Shipments page, shown only for a `planned` shipment, calling the already-tested `shipments.updatePlannedDepartDate`/`shipments.markDeparted` router procedures — mirrors the existing `CustomsArrivalControl`/`DepartDateCorrectionControl` pattern. Verified end-to-end via the real API (create shipment → confirm `plannedDepartDate: null` → set it → mark departed → confirm `status: "departed"` with both dates persisted).

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

**New, smaller items surfaced by Stream B's own build:**
- ⬜ **Still open, deliberately.** Duplicate-SKU-per-PO collision in the migration's line-item reference key (`${poNumber}::${sku}`) — two line items for the same SKU on one PO (e.g. two price tranches) will collide. Not fixed deliberately: the real Control Tower Sheet's actual line-item reference column format is unknown, and guessing at a new key scheme risks mismatching real data. Revisit once the real Sheet format is known (see `scripts/reconcile-migration.ts`'s comment at the map-building call site).
- ✅ `recordLedgerEvent`'s negative-stock check-then-insert TOCTOU race is now documented with an explicit code comment (not fixed with a lock — no concurrent-write path exists today in this single-operator system; revisit if a second writer is ever introduced).
- ✅ `updateShipmentStatus`/`markShipmentDeparted` now throw a clear `"no shipment found with id N"` error instead of crashing on a missing row. (While fixing these two, found the identical gap in several other functions — `updateShipmentPlannedDepartDate`, `recordShipmentCosts`, `setShipmentCustomsStatus`, `markShipmentArrived`, `correctShipmentActualDepartDate` in `shipments.ts`, and `updatePurchaseOrderStatus`/`updatePurchaseOrderPlannedReadyDate` in `purchaseOrders.ts` — tracked as a new item below rather than silently expanding this fix's scope.)
- ✅ `run-migration.mjs` now validates the input JSON's required array fields up front, failing with a named `"Malformed input: missing or non-array field(s) ..."` message instead of a raw `Cannot read properties of undefined`.
- ✅ `run-parallel-check.mjs`'s `getMigratedSoh` now returns `null` (not `0`) for a completely unknown SKU/warehouse — `reconcileMigration` treats `null` as an unconditional mismatch, even when the sheet also expects `0`, closing the "unknown SKU silently matches a sheet row that also expects zero" gap.
- ⬜ **New, surfaced while fixing the item above:** the same missing-existence-check pattern (`const [row] = await db.select()...` used immediately without checking it exists) is present in `createShipment`'s downstream reads and most other "update by id" functions across `shipments.ts`/`purchaseOrders.ts`/`payments.ts` — not fixed here to avoid silently expanding this cleanup pass's scope; worth a dedicated pass if this class of bug ever actually bites (a bad/deleted id reaching one of these functions today just crashes with a generic `TypeError` instead of a named error).

## C. Security hardening — ✅ DONE (2026-09-20, see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) for the full build/review narrative)

- ✅ **The role split is now a real access boundary.** The shared `APP_PASSWORD` identity-picker flow is retired; real per-user credentials (`users.passwordHash`) mean each of the SCAIT editor and client viewer accounts can only ever authenticate as themselves.
- ✅ **Session revocation via a `tokenVersion` counter.** Session lifetime dropped from 365 days to 30; a session JWT is checked against the user row's `tokenVersion` on every use, so sign-out or a password reset invalidates it immediately rather than leaving a captured token valid for a year.
- ✅ **A real sign-out control** exists in the UI and calls `POST /api/auth/logout`, which bumps `tokenVersion` server-side (not just clearing the browser cookie).
- ✅ **Per-email login throttle** (`server/_core/loginThrottle.ts`) — 5 failed attempts locks an email out for 15 minutes.
- ✅ Provisioning has a real, documented path: `scripts/seed-first-user.ts` for the first user, `scripts/reset-password-core.ts`/`scripts/reset-password.mjs` for a lost password.
- ✅ The final whole-branch review of this stream found and fixed 1 Critical + 4 Important issues: the Critical was the login throttle keying its lockout on the raw, case-sensitive email string, letting an attacker bypass the 5-attempt limit entirely via case permutation of the same address (fixed by normalizing every email to lowercase, consistently, at every lookup/storage point); the four Important fixes were an unbounded-growth memory-exhaustion path in the throttle's tracking map, missing anti-enumeration/cookie-attribute HTTP-level test coverage, silent (unlogged) catch blocks on all three auth routes, and this backlog/README documentation lagging the actual shipped state.

**New, smaller items surfaced by Stream C's own build — all closed:**
- ✅ The 30-day session lifetime is now one exported constant (`server/_core/auth.ts`'s `THIRTY_DAYS_MS`), imported into `cookies.ts` instead of being declared twice.
- ✅ `/api/auth/status` now returns `503 {error:"temporarily unavailable"}` on a genuine check failure, distinct from a real `200 {authenticated:false}` logout — `RequireAuth` shows a distinct "temporarily unavailable" message instead of silently bouncing a signed-in user to `/login`.
- ✅ `RequireAuth` now re-checks auth status every 5 minutes, not just once on mount, so a mid-session revocation (sign-out elsewhere, a password reset) gets redirected to `/login` instead of rendering "Failed to load: UNAUTHORIZED" indefinitely. A transient failure on a periodic re-check leaves an already-authenticated user alone rather than disrupting them.
- ✅ `AppNav`'s sign-out now clears the react-query cache (`queryClient.clear()`).
- ✅ `LoginPage.tsx`'s inputs now have `autoComplete="username"`/`"current-password"`.
- ✅ `scripts/resetPassword.ts` renamed to `scripts/reset-password-core.ts`, matching the rest of `scripts/`'s kebab-case convention.
- ✅ `server/_core/env.test.ts`'s redundant `?t=${Date.now()}` cache-busting suffix dropped — see `F. Cleanup` item 5, now also done.
- ✅ `RAILWAY.md` now warns that redeploying this release logs out every existing session at once.

## D. Performance — ✅ DONE (2026-09-20, see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) for the full build/review narrative)

- ✅ **`getHomeSummary` and `getStockDashboard` no longer issue one query per SKU (or per SKU/warehouse pair).** New `getSohForSkus`/`getAverageDailySalesForSkus` grouped aggregate queries replace the per-item loops — both dashboards now issue a small, constant number of queries (6 and 3 respectively) regardless of active SKU count, verified against the actual code at final review (previously ~40,000 sequential round trips at 10K SKUs / 3 warehouses).
- ✅ **`getMoneyDashboard`'s Daily COGS path no longer re-reads the entire ledger and re-runs FIFO once per day.** New `getDailyCogsForRange` does one bounded query plus one chronological forward pass for the whole requested window — 1 query total regardless of window length, replacing what was one query plus two full-history FIFO passes per day (120 full recomputations for a 60-day window). Mathematically proven equivalent to the old per-day double-recomputation, independently traced by the task reviewer for the general case (split-batch sales, zero-sale days, sales at the start of history), not just the one test scenario.
- ✅ **Grouped/aggregate queries now exist for both SOH-by-SKU-and-warehouse and trailing sales** — the third BACKLOG item, closed by the same two new functions above.
- ✅ Every dashboard's output shape and computed values verified byte-identical to pre-refactor behavior — every pre-existing test in `dashboards.test.ts` diffed directly (not just reviewed) to confirm zero changes, plus new multi-SKU tests proving the batched grouping/keying logic is correct, not just "some plausible number came back."

Deliberately not done (see the design doc's Non-Goals): no caching/precomputed tables (staleness-invalidation risk, out of proportion to this system's correctness-first priority), no `IN (...)` chunking (unnecessary at this scale), no query-count/timing tests in the suite (this codebase has no such instrumentation, and a wall-clock test against local loopback MySQL would be unreliable — verification here is structural, a reviewer confirming a loop-with-await became a single grouped query, plus correctness tests against real data).

**New, smaller items surfaced by Stream D's own build — all closed:**
- ✅ `getDailyCogsForRange`'s JSDoc now states its `dateKeys` contract (sorted ascending, no duplicates) explicitly, plus the two precision caveats below.
- ✅ Documented in the function's own doc comment: the new forward-pass algorithm's failure behavior differs very slightly from the old per-day approach (a genuine improvement — surfaces a real insufficient-stock condition instead of masking it on a sales-free day — not a regression).
- ✅ Documented in the same comment: the new and old COGS computations are numerically equivalent but not literally bit-for-bit identical for a long history (different floating-point accumulation order, the new one less cancellation-prone).
- ✅ `getSohForSkus`'s test now pairs its `arrayContaining` assertion with an explicit `toHaveLength(2)`.
- ✅ `getShipmentLandedUnitCost` now batches its per-line PO-line-item lookup into one query instead of one per shipment line item — the last dashboard-reachable await-in-a-loop pattern. Also closed a missing-existence-check gap the Map-lookup refactor surfaced: a shipment line referencing a nonexistent PO line item now throws a clear, named error instead of crashing.

## E. Systemic correctness risks — ✅ DONE (2026-09-19, see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) for the full build/review narrative)

- ✅ **Daily Shopify pull is idempotent.** Unique constraint on `sales_actuals(skuId, warehouseId, date, source)`; `runDailyShopifyPull` checks for an existing matching row before writing and quarantines a duplicate into `skipped` with a reason instead of re-importing it. `scripts/run-daily-shopify-pull.mjs` gives it a real CLI entrypoint, matching `run-nightly-export.mjs`'s pattern.
- ✅ **Systemic date/timezone handling** — split per a real conflict the design surfaced: `purchase_orders.plannedReadyDate`, `sales_plan.periodDate`, and `sales_actuals.date` converted to Drizzle `date` (string) mode, eliminating timezone-conversion drift at the type level. `inventory_ledger.date` deliberately stays `timestamp(3)` (Stream B's same-day-ordering fix, preserved) — instead, `server/dbClient.ts`'s MySQL pool issues a real `SET time_zone = '+00:00'` on every new connection. The plan's originally-specified mechanism (a mysql2 `timezone: "Z"` pool option) turned out to be completely ineffective — Drizzle's own column mapper and its mysql2 session override both bypass that option for TIMESTAMP/DATE fields regardless — caught and corrected during task review, not shipped as originally written.
- ✅ **Landed-cost currency assumption enforced.** `getShipmentLandedUnitCost` throws on a PO-line/shipment currency mismatch (skipping the check when `costCurrency` is legitimately `null` — "no costs recorded yet" — a real nullable state a first draft of the guard wrongly treated as a mismatch).
- ✅ **A genuinely latent same-day event-ordering bug was found and closed as part of this stream, not left for later**: converting `sales_actuals.date` meant its derived `inventory_ledger` "sale" event needed a synthetic time-of-day anchor (it's a whole-day aggregate, not a point-in-time transaction). The first anchor tried (UTC midnight) broke the negative-stock guard for any same-day receipt recorded at a real, later timestamp; anchoring at day-close (`23:59:59.999Z`) fixed that but, caught only at the final whole-branch review, still left the guard unable to see a day-close-anchored sale when checking an *earlier-timestamped* same-day event (e.g. a future manual correction). Fixed by having the negative-stock guard evaluate solvency as of the END of the triggering event's own calendar day rather than its exact timestamp — same-day events are now mutually visible to each other's guard checks regardless of insertion order.

**New, smaller items surfaced by Stream E's own build:**
- ⬜ **Still open, deliberately.** Per-source idempotency gap: the `sales_actuals` unique constraint includes `source`, and `runDailyShopifyPull`'s duplicate check only looks at `source = "shopify_daily_pull"` rows — a `manual` row for the same day would not block the pull from also importing, double-depleting SOH via two separate ledger sale events. No API path writes `manual` `sales_actuals` rows today, so this is inert, but needs a real answer (a cross-source check, or a documented single-source-of-truth-per-day rule) before one is built — not fixed speculatively for a write path that doesn't exist yet.
- ✅ **Mixed sale-event anchor time between live code and the migration replay — fixed.** `transformSheetExport` now anchors a migrated `"sale"` row at end-of-day, matching `recordSalesActual`'s live-code convention; receipts/adjustments keep their given date as-is.
- ✅ **`change_log` date-format inconsistency across entity types — fixed.** Shipment date fields (`plannedDepartDate`, `actualDepartDate`, `actualArrivalDate`) now log a plain `"YYYY-MM-DD"` string, matching `purchase_orders.plannedReadyDate`'s format (cosmetic fix only — the underlying columns stay `timestamp`, unchanged).
- ✅ **Currency comparison case-sensitivity — fixed.** The landed-cost guard now compares currency codes case-insensitively; a genuine mismatch still throws regardless of casing.
- ✅ `scripts/run-daily-shopify-pull.mjs` now calls `listSkus("active")`, matching other dashboard-adjacent callers.

## F. Cleanup (cheap, low-risk — fold into whichever other stream touches these files)

- ⬜ `REASON_CATEGORIES` is triplicated (`drizzle/schema.ts`, `PurchaseOrdersPage.tsx`, `ShipmentsPage.tsx`) — client should import the const array from the schema instead of hand-copying it.
- ⬜ `getHomeSummary` hardcodes a `daysOfCover < 21` check instead of reusing the `STOCK_STATUS_THRESHOLDS` table defined 40 lines above it in `dashboards.ts` — tune the table and Home silently disagrees with Stock.
- ⬜ Orphaned `vitest.setup.ts` — dead since an early fix removed its `setupFiles` reference; delete it.
- ⬜ Duplicate `AppRouter` type in `server/_core/trpc.ts` (`ReturnType<typeof router>`) shadowing the real one in `routers.ts` — delete the stale one.
- ✅ `?t=${Date.now()}` query-string dynamic imports in `env.test.ts`/`auth.test.ts` — both dropped (`auth.test.ts` during Stream C's Task 3, `env.test.ts` in this cleanup pass); `vi.resetModules()` alone is sufficient.
- ⬜ `routers.ts`'s `createSku` procedure: `primaryIdentifierType: z.string()` + `createSku(input as any)` — should be `z.enum([...])`, removing the only `as any` in the router.
- ⬜ No index on `change_log (entity_type, entity_id)` — `listChangeLog` full-scans a table that grows with every cost/date edit. Add once history queries get slow, not urgent today.
- ⬜ `@vitejs/plugin-react` is a devDependency but never registered in `vite.config.ts` — `pnpm dev` has no Fast Refresh without it (one line to fix).
- ⬜ Three trivial cosmetic nits in Stream B's CLI scripts: an unused `db` import in `run-parallel-check.mjs`; `run-migration.mjs`'s "Migration failed and rolled back" wording is imprecise for failures that happen before any transaction opens (bad path, missing file, malformed JSON — still fails loudly with a clear reason and correct exit code, just misleading phrasing); a shebang-line inconsistency between the two new scripts and the pre-existing `run-nightly-export.mjs` pattern.
- ⬜ **`pnpm test` doesn't actually work as a bare, single command** — the README's "Run the test suite with `pnpm test` (single command — no extra flags needed)" is currently inaccurate. Nothing loads `.env` for vitest (no `dotenv` dependency, no `setupFiles` in `vitest.config.ts` — related to, but distinct from, the orphaned-`vitest.setup.ts` item above), so a fresh shell gets `Error: DATABASE_URL is required` on ~16 of 23 test files. Every session in this build history has worked around it by manually running `set -a && source .env && set +a` first; worth either wiring a real `setupFiles` entry or fixing the README's claim to say so explicitly. Surfaced during Stream D's final review, not caused by it.

---

## Already fixed (for reference — see BUILD-HISTORY.md for detail)

✅ No login UI / no way to create the first user (C1)
✅ Production server didn't serve the built frontend (C2)
✅ Cashflow silently blended currencies — including the Home-dashboard-level residual found in the fix-wave re-review (C3)
✅ Documented `pnpm test` command failed under default parallelism (I1)
✅ `getAverageDailySales` wrong divisor + no date window, silently wrong stockout-risk flags (I2)
✅ StockPage not rendering the days-of-cover/status/warehouse-name data the backend already computed (I4)
