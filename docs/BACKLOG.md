# Backlog — Post-V1 Hardening

Source: the final whole-branch review after V1's 20 tasks (see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md)), plus the deferred-minor triage that review ran against everything parked during the build. Every item here is a real finding, not a guess — each was independently verified against the actual code, not just asserted.

Grouped into six work streams (A–F). Recommended order: **B → A → E → C → D**, with F riding along with whichever other stream touches the same files. Reasoning: B and A are what make the system honestly comparable against Control Tower during the parallel run; C and D matter most once real client staff and real data volume show up, which comes after that. **B, A, and E are done** — C is next.

Status legend: ✅ done · ⬜ open

---

## A. Wiring completion

Backend logic exists and is tested; no router procedure or UI exposes it. Recommended as **one single task**, not nine — the review explicitly called this out as a checklist item, not nine separate features.

- ✅ `sales_plan` row creation — `createSalesPlanEntry` + `salesPlan.create` router procedure + Stock page form, wired to `getSalesVolatility`/`getPlanActualDeviation`.
- ✅ Shipment progression past `departed` — `shipments.updateStatus` reaches `customs`/`delivered`; `setShipmentCustomsStatus`/`markShipmentArrived` cover customs status and actual arrival date; `correctShipmentActualDepartDate` covers correcting an already-recorded actual depart date. All wired to the Shipments page.
- ✅ `payments.history` — router procedure reading back `change_log` rows, wired to the Purchase Orders page.
- ✅ `listPaymentsForPo` — `payments.listForPo`, Purchase Orders page now re-lists from the DB instead of session-local state.
- ✅ `getSalesVolatility` / `getPlanActualDeviation` — surfaced on the Stock page's Sales Plan section.
- ✅ `listShipmentsForPo` — `shipments.listForPo`, surfaced on the Purchase Orders page.
- ✅ `matchTransaction` — wired to a real UI action on the Money page's Cashflow tab (`listUnpaidPayments` dropdown + match button), including the payment-double-matching and dropdown-identity fixes from the final review's fix wave (see `docs/2026-09-19-wiring-completion-design.md` Section 8 and the fix-wave report at `.superpowers/sdd/2026-09-19-wiring-completion/final-review-fix-report.md`).
- ⬜ **No UI exists anywhere to set a shipment's `plannedDepartDate` or to mark it departed with a real actual-depart-date** (`shipments.updatePlannedDepartDate` and `shipments.markDeparted` router procedures exist and are tested, but nothing in the client calls either) — a real gap predating this stream, now explicitly closed off from being reachable through the wrong function (`updateShipmentStatus`) rather than fixed with a proper UI. `updateShipmentStatus` now throws if asked to transition to `"departed"`, and the client's `VALID_SHIPMENT_TRANSITIONS` no longer offers a "Mark departed" button for `planned` shipments. Building the real "set planned depart date + mark departed with a date" UI is a separate, larger piece of work.

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

## E. Systemic correctness risks — ✅ DONE (2026-09-19, see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) for the full build/review narrative)

- ✅ **Daily Shopify pull is idempotent.** Unique constraint on `sales_actuals(skuId, warehouseId, date, source)`; `runDailyShopifyPull` checks for an existing matching row before writing and quarantines a duplicate into `skipped` with a reason instead of re-importing it. `scripts/run-daily-shopify-pull.mjs` gives it a real CLI entrypoint, matching `run-nightly-export.mjs`'s pattern.
- ✅ **Systemic date/timezone handling** — split per a real conflict the design surfaced: `purchase_orders.plannedReadyDate`, `sales_plan.periodDate`, and `sales_actuals.date` converted to Drizzle `date` (string) mode, eliminating timezone-conversion drift at the type level. `inventory_ledger.date` deliberately stays `timestamp(3)` (Stream B's same-day-ordering fix, preserved) — instead, `server/dbClient.ts`'s MySQL pool issues a real `SET time_zone = '+00:00'` on every new connection. The plan's originally-specified mechanism (a mysql2 `timezone: "Z"` pool option) turned out to be completely ineffective — Drizzle's own column mapper and its mysql2 session override both bypass that option for TIMESTAMP/DATE fields regardless — caught and corrected during task review, not shipped as originally written.
- ✅ **Landed-cost currency assumption enforced.** `getShipmentLandedUnitCost` throws on a PO-line/shipment currency mismatch (skipping the check when `costCurrency` is legitimately `null` — "no costs recorded yet" — a real nullable state a first draft of the guard wrongly treated as a mismatch).
- ✅ **A genuinely latent same-day event-ordering bug was found and closed as part of this stream, not left for later**: converting `sales_actuals.date` meant its derived `inventory_ledger` "sale" event needed a synthetic time-of-day anchor (it's a whole-day aggregate, not a point-in-time transaction). The first anchor tried (UTC midnight) broke the negative-stock guard for any same-day receipt recorded at a real, later timestamp; anchoring at day-close (`23:59:59.999Z`) fixed that but, caught only at the final whole-branch review, still left the guard unable to see a day-close-anchored sale when checking an *earlier-timestamped* same-day event (e.g. a future manual correction). Fixed by having the negative-stock guard evaluate solvency as of the END of the triggering event's own calendar day rather than its exact timestamp — same-day events are now mutually visible to each other's guard checks regardless of insertion order.

**New, smaller items surfaced by Stream E's own build — genuinely deferred, not silently dropped:**
- ⬜ **Per-source idempotency gap.** The `sales_actuals` unique constraint includes `source`, and `runDailyShopifyPull`'s duplicate check only looks at `source = "shopify_daily_pull"` rows — a `manual` row for the same day would not block the pull from also importing, double-depleting SOH via two separate ledger sale events. No API path writes `manual` `sales_actuals` rows today, so this is inert, but needs a real answer (a cross-source check, or a documented single-source-of-truth-per-day rule) before one is built.
- ⬜ **Mixed sale-event anchor time between live code and the migration replay.** `recordSalesActual` anchors its derived ledger event at day-close (`23:59:59.999Z`); `scripts/reconcile-migration.ts`'s sale-event replay still anchors at UTC midnight (`new Date(r.date)`). Both represent the same "whole-day sale aggregate" concept but land at opposite ends of the day depending on which path wrote them — migration-only code, not live traffic, but should be aligned before any real migration runs.
- ⬜ **`change_log` date-format inconsistency across entity types.** `purchase_orders.plannedReadyDate` now logs a plain `"YYYY-MM-DD"` string in its change-log entries; `shipments`' own date fields still log full ISO datetimes. Cosmetic audit-trail inconsistency, not a correctness bug.
- ⬜ **Currency comparison is raw and case-sensitive.** The new landed-cost guard's `poLine.currency !== shipment.costCurrency` check would hard-throw on `"usd"` vs `"USD"` where the same mismatch previously silently miscalculated. A pre-existing weakness, now promoted into a live failure mode — worth normalizing casing before comparing.
- ⬜ `scripts/run-daily-shopify-pull.mjs` calls `listSkus()` unfiltered (pulling inactive/discontinued SKUs into its lookup table) where other callers use `listSkus("active")` — likely harmless in practice, worth aligning for consistency.

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
