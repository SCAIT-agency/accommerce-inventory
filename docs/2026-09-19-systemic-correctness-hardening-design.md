# Systemic Correctness Hardening (Backlog Stream E) — Design

## Context & Motivation

V1's final whole-branch review flagged three correctness risks as "not urgent today because no real production data has flowed through yet — will matter the moment it does." Backlog Stream E closes all three before that moment arrives: the Daily Shopify pull's lack of idempotency (a re-run silently double-counts both SOH depletion and COGS), a systemic date/timezone handling gap across four calendar-day columns, and an unenforced currency assumption in the landed-cost calculation.

A pre-design code survey found one real conflict between the backlog's own generic recommendation and a fix already shipped in Stream B: `inventory_ledger.date` was deliberately upgraded to `timestamp(3)` (millisecond precision) in Stream B to fix a real same-day event-ordering bug (a receipt and a same-day sale landing on the wrong side of a rounding boundary, causing the negative-stock guard to reject valid writes). The backlog's blanket suggestion — convert all four calendar-day columns to Drizzle's `date` (string) mode — would silently regress that fix if applied to `inventory_ledger.date`, since a date-only column has no way to express "this event happened before that one, same day." This design splits the fix accordingly.

## Goals

- Daily Shopify pull is idempotent: re-running for a day/SKU/warehouse it already processed neither duplicates `sales_actuals` rows nor duplicate ledger events.
- A cron-wrapper script for the daily pull, matching the existing `run-nightly-export.mjs` pattern (currently a library function nobody calls automatically).
- `sales_actuals.date`, `sales_plan.periodDate`, and `purchase_orders.plannedReadyDate` — genuinely calendar-day-only concepts — converted to Drizzle `date` (string) mode, eliminating timezone-conversion drift at the type level.
- `inventory_ledger.date` stays `timestamp(3)` (Stream B's fix preserved), but the MySQL connection pool gets a pinned UTC session timezone, so every `.toISOString().slice(0, 10)`-style calendar-day bucketing against it is computed from a UTC-normalized value instead of the server's local session timezone.
- `getShipmentLandedUnitCost` throws if a shipment line's PO currency doesn't match the shipment's cost currency, instead of silently computing nonsense.

## Non-Goals

- Any change to `inventory_ledger.date`'s type or precision — Stream B's `timestamp(3)` fix is correct and stays exactly as-is; only the connection-level timezone pinning applies to it.
- Currency conversion logic — the landed-cost guard rejects a mismatch, it does not attempt to convert between currencies.
- Retroactively correcting any date/timezone drift in data that may already exist locally — this is preparatory hardening for before real data flows through, not a backfill/migration of existing rows (this codebase still has no real Jello/Accommerce data, per every prior stream's standing constraint).
- A full scheduler/orchestration system for the new cron-wrapper script — matching the existing `run-nightly-export.mjs`'s own scope (a script a human or an external cron runs, not a built-in scheduler).

## Design

### 1. Daily Shopify pull idempotency

Add a unique constraint on `sales_actuals(skuId, warehouseId, date, source)`. Since `sales_actuals.date` is being converted to `date` (string) mode as part of this same design (see Section 3), the constraint is naturally exact-match on calendar day, with no timestamp-precision ambiguity to worry about.

`runDailyShopifyPull` changes from unconditionally calling `recordSalesActual` for every parsed row to checking first whether a matching row already exists (same `skuId`/`warehouseId`/`date`/`source`) and skipping it with a reason if so — matching this codebase's existing quarantine-not-abort convention (the same pattern Stream B's migration transforms use), not throwing on the whole batch. The check-then-insert is not a race condition in this codebase's actual usage pattern (a single daily cron run, not concurrent pulls), so no additional locking is needed beyond what the unique constraint itself already guarantees as a backstop.

### 2. Cron-wrapper script

`scripts/run-daily-shopify-pull.mjs`, matching `scripts/run-nightly-export.mjs`'s existing pattern exactly: `tsx`-executable, reads a Shopify export file path from argv, calls `runDailyShopifyPull`, prints an imported/skipped summary, exits 0 on success (even with some skipped rows — skipping is expected behavior, not failure) or 1 on a hard failure (missing file, malformed input).

### 3. Calendar-day columns → Drizzle `date` (string) mode

`sales_actuals.date`, `sales_plan.periodDate`, `purchase_orders.plannedReadyDate` change from `timestamp("...")` to `date("...", { mode: "string" })`. Every function currently constructing these fields from a JS `Date` and reading them back as a JS `Date` changes to work with plain `"YYYY-MM-DD"` strings instead — removing the `.toISOString().slice(0, 10)` calls that exist purely to force a JS `Date` back into a calendar-day string, since the column itself is now a calendar-day string throughout. Router-level `z.date()` inputs for these fields stay as-is (the client still sends a `Date`); the router or the underlying function converts to the `"YYYY-MM-DD"` string once at the boundary, matching the existing pattern of converting inputs at the router layer.

### 4. `inventory_ledger.date` — pinned UTC timezone instead of a type change

`server/dbClient.ts`'s `mysql.createPool(ENV.databaseUrl)` call gains a pinned `timezone: "Z"` option, so MySQL always returns/interprets `TIMESTAMP` values in UTC regardless of the server's configured session timezone. This closes the timezone-drift risk for every remaining `.toISOString().slice(0, 10)` call site that reads `inventory_ledger.date` (e.g. `getDailyCogs`'s date-key bucketing) without touching the column's type or precision, preserving Stream B's `timestamp(3)` fix exactly as shipped.

### 5. Landed-cost currency guard

`getShipmentLandedUnitCost` gains a check inside its per-line-item loop: after fetching `poLine`, compare `poLine.currency` against `shipment.costCurrency`; if they differ, throw a clear error naming both currencies and the shipment/line-item ids involved, before computing anything. This is a pure addition — no change to the existing calculation for the case where currencies already match.

## Testing

`runDailyShopifyPull` gets a new test proving a second call with the exact same export data results in zero additional `sales_actuals` rows and zero additional ledger events, with the duplicate rows reported as skipped (not silently dropped, not thrown). The three converted columns each get a test confirming a round-trip through the real DB preserves the calendar day exactly regardless of the value's time-of-day component at the JS layer (construct with a non-midnight `Date`, store, read back, confirm the stored/returned value is the same calendar day). `getShipmentLandedUnitCost` gets a test proving it throws on a currency mismatch and a test proving it still computes correctly when currencies match (regression coverage for the existing behavior). The pinned-timezone change is verified via a real DB round-trip test against `inventory_ledger`, not a mock — insert an event, read it back via a raw connection query, confirm the returned timestamp's UTC representation matches what was written regardless of the test-runner machine's local timezone.

## Open Questions

None.
