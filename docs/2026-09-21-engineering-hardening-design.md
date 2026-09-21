# Engineering Hardening (Cherny lens) — Design

Backlog Stream J. Addresses every Engineering (Cherny) item from `docs/BACKLOG.md`
section I / `docs/2026-09-20-three-lens-architecture-review.md` that is a bounded
fix rather than a new subsystem. Follows the Operational (Cook) cleanup that
shipped 2026-09-20/21; this is the second of the three priority tiers the user
set explicitly ("1-100%, 3, 2" — Operational, then Engineering, then Product).

## Scope

1. Unify the 2 live FIFO implementations behind one shared primitive.
2. Delete dead code: `computeFifoCogs` (+ its tests), `updateSku`.
3. Make every status/field-changing write that also calls `logChange` atomic.
4. Standardize "row not found" handling to one idiom across `shipments.ts`.
5. Add the missing foreign keys and indexes Cherny's review found.
6. Migrate money/quantity-share columns from `varchar` to `decimal`.
7. Rename the 5 `.mjs` CLI scripts to `.ts` so `tsc` actually checks them.

**Dropped after verification:** the BACKLOG item "`payments.history` is
unreachable from the UI" is stale. `PurchaseOrdersPage.tsx:145-165` already
has a working `PaymentHistory` component (an inline expand/collapse "History"
button per payment calling `trpc.payments.history.useQuery` directly) — a
different, already-functional pattern from the shared `/change-log/:entityType/:entityId`
route, which the original review evidently didn't check for before flagging
this. No fix needed; nothing in this stream touches it.

Explicitly out of scope (deferred, tracked separately): reversal/correction
paths for stock/cost/payment data, freight/duty lock-after-arrival, the
nightly export's unbounded-query OOM risk, Shopify pull scheduling/alerting/
runtime input validation, and monitoring/restore-drill infrastructure — none
of these are Engineering-lens bounded fixes; they need their own design pass
or external infra decisions.

## 1. Unify the FIFO implementations

**Current state** (verified by reading both functions in full):

- `getRemainingBatches` (`server/inventoryLedger.ts:90-130`) queries all ledger
  events for a SKU/warehouse ordered by `(date, id)`, replays them against an
  in-memory `batches` array via a `consume()` closure doing
  `batches.find(b => b.qty > 0 && b.date <= asOfDate)`, and returns the
  surviving batches.
- `getDailyCogsForRange` (`server/salesPlan.ts:132-186`) does the *exact same*
  query shape and the *exact same* `consume()` closure body, but bounded to a
  date range and bucketing each sale's consumed cost into a per-day map
  instead of returning final batch state.
- `computeFifoCogs` (`server/landedCost.ts:29`) is a third, no-longer-called
  implementation (dead code — see section 2).

**Design:** extract the shared replay primitive into `inventoryLedger.ts`
(the natural owner — it already defines ledger event querying):

```ts
// server/inventoryLedger.ts
export interface FifoBatch { qty: number; unitCost: number; date: Date; sourceRef: string | null }

export function replayLedgerEventsFifo(
  events: LedgerEvent[],
  onSaleConsumed?: (event: LedgerEvent, consumedCost: number) => void,
): FifoBatch[] {
  const batches: FifoBatch[] = [];

  const consume = (qtyToConsume: number, asOfDate: Date, context: string): number => {
    let remaining = qtyToConsume;
    let consumedCost = 0;
    while (remaining > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= asOfDate);
      if (!batch) throw new Error(`replayLedgerEventsFifo: insufficient stock to consume ${remaining} units for ${context}`);
      const consumed = Math.min(batch.qty, remaining);
      consumedCost += consumed * batch.unitCost;
      batch.qty -= consumed;
      remaining -= consumed;
    }
    return consumedCost;
  };

  for (const event of events) {
    if (event.eventType === "receipt") {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    } else if (event.eventType === "sale") {
      const consumedCost = consume(Math.abs(event.qty), event.date, `sale event ${event.id}`);
      onSaleConsumed?.(event, consumedCost);
    } else if (event.qty < 0) {
      consume(Math.abs(event.qty), event.date, `adjustment event ${event.id}`);
    } else if (event.qty > 0) {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    }
  }

  return batches;
}
```

`onSaleConsumed` fires only for `"sale"` events (not adjustments) — exactly
matching `getDailyCogsForRange`'s existing rule that adjustments consume FIFO
but never count as Daily COGS.

- `getRemainingBatches` becomes: run its existing query, call
  `replayLedgerEventsFifo(events)` with no callback, then
  `.filter((b) => b.qty > 0).map(...).sort(...)` exactly as today.
- `getDailyCogsForRange` becomes: run its existing bounded query, call
  `replayLedgerEventsFifo(events, (event, cost) => { bucket cost into dailyCogs by event.date })`,
  then map `dateKeys` to the accumulated map exactly as today.

Both functions' own query logic, error messages seen by callers, and every
existing test's expected values must stay identical — this is a pure
extract-shared-function refactor, not a behavior change. The two "known,
accepted" comments about ordering (end-of-day guard vs. strict timestamp
order) stay attached to `recordLedgerEvent` and to whichever function's
query they describe; don't lose them in the move.

## 2. Delete dead code

- `computeFifoCogs` (`server/landedCost.ts:29`) and its 3 tests in
  `server/landedCost.test.ts` (the `describe("computeFifoCogs", ...)` block,
  confirmed at lines 10-36). Must run **after** section 1's FIFO unification:
  `LandedBatch`/`SaleEvent`/`FifoCogsResult` (`landedCost.ts:13-26`) are used
  only by `computeFifoCogs` and by `salesPlan.ts`'s `import type { LandedBatch }`
  — once `getDailyCogsForRange` switches to `replayLedgerEventsFifo` (which
  declares its own `FifoBatch` in `inventoryLedger.ts` and needs nothing from
  `landedCost.ts`), all three types become fully dead too. Delete
  `computeFifoCogs`, `LandedBatch`, `SaleEvent`, and `FifoCogsResult`
  together, and remove the now-unused `import type { LandedBatch } from
  "./landedCost"` from `salesPlan.ts`.
- `updateSku` (`server/db.ts:16`) — confirmed zero callers outside its own
  definition via repo-wide grep. Delete the function; if `InsertSku` becomes
  unused as a result, leave it (still `$inferInsert`'s natural export).

## 3. Atomicity for status/field-changing writes

**Current state:** every write in `shipments.ts` and `purchaseOrders.ts`
that changes a field and then calls `logChange` does the update and the
`logChange` call(s) as separate, unguarded statements — if the process dies
between them, the change lands with no audit trail. `payments.ts`'s
`markPaymentPaid`/`matchTransactionToPayment` already fixed this same class
of bug in the Operational cleanup (`markPaymentPaidCore` + a `db.transaction`
wrapper) — this task applies that exact established pattern to the remaining
functions:

- `server/purchaseOrders.ts`: `updatePurchaseOrderStatus`,
  `updatePurchaseOrderPlannedReadyDate`.
- `server/shipments.ts`: `updateShipmentPlannedDepartDate`,
  `updateShipmentStatus`, `markShipmentDeparted`, `recordShipmentCosts`,
  `setShipmentCustomsStatus`, `correctShipmentActualDepartDate`.
  (`markShipmentArrived` already wraps its work in `db.transaction` — no
  change needed there.)

For each: wrap the `select` (if it doesn't already have one), `update`, and
every `logChange` call in one `dbClient.transaction(async (tx) => { ... })`,
passing `tx` to every DB call and to `logChange`'s existing `dbClient`
parameter. Functions that already accept a `dbClient: DbClient = db`
parameter (`setShipmentCustomsStatus`, `correctShipmentActualDepartDate`)
keep that parameter and open their `db.transaction` on it being the default
`db` — i.e. `(dbClient.transaction ? ... )` is unnecessary complexity; simplest
correct form is: the function always opens its own transaction via
`db.transaction(...)` when called at the top level, and the existing
`dbClient` parameter is dropped in favor of always-transactional — **unless**
a caller ever invokes one of these from inside another transaction already
(check call sites before deciding). Verified call-site check: neither
function is currently called from inside another transaction anywhere in the
codebase, so the simpler fix (always open one transaction inside the
function, remove the now-redundant `dbClient` parameter) applies to both.

This is the same fix shape 8 times over; bundle it as one task, one shared
pattern, reviewed once.

## 4. Standardize "row not found" handling in `shipments.ts`

**Current state**, confirmed by reading the full file: `updateShipmentStatus`
(line 111-114) and `markShipmentDeparted` (line 132-135) and
`markShipmentArrived` (line 216-219) already do the correct thing — select,
check `if (!shipment) throw new Error(...)`, then proceed. Four other
functions select a row and use it unguarded, crashing with a raw
`TypeError: Cannot read properties of undefined` instead of a clear domain
error the moment the row doesn't exist:

- `updateShipmentPlannedDepartDate` (line 76) — `shipment.plannedDepartDate`
  used at line 86 with no check.
- `recordShipmentCosts` (line 163) — `before.freightCost`/`before.dutyCost`
  used at lines 170/180 with no check.
- `setShipmentCustomsStatus` (line 197) — `shipment.customsStatus` used at
  line 203 with no check.
- `correctShipmentActualDepartDate` (line 271) — `shipment.actualDepartDate`
  used at line 272 with no check.

Fix: add the same `if (!shipment) throw new Error(\`<functionName>: no
shipment found with id ${id}\`)` guard (matching the exact message format the
3 correct functions already use) to all 4, immediately after the `select`.
Since task 3 above already touches every one of these functions' bodies
(wrapping them in a transaction), do this as part of the same edit, not a
separate pass — the guard goes inside the transaction, right after the
`select`, before anything else.

## 5. Missing foreign keys and indexes

Confirmed by reading `drizzle/schema.ts` in full. Add `.references()` to:

- `changeLog.changedBy` → `users.id`
- `purchaseOrders.vendorId` → `vendors.id`
- `purchaseOrders.createdBy` → `users.id`
- `shipments.createdBy` → `users.id`
- `salesPlan.skuId` → `skus.id`, `salesPlan.warehouseId` → `warehouses.id`
- `salesActuals.skuId` → `skus.id`, `salesActuals.warehouseId` → `warehouses.id`
- `salesPlanWeeklyRecipeLines.weeklyInputId` → `salesPlanWeeklyInputs.id`

Add these indexes (query patterns confirmed by reading the corresponding
`listX`/`getX` functions):

- `changeLog`: composite index on `(entityType, entityId)` — `listChangeLog`
  (`server/changeLog.ts`) filters on exactly this pair and is the only way
  the Change Log page reads history; currently a full scan.
- `payments`: index on `(paid, expectedDate)` — `getCashflowForecast`
  filters on `paid = false` and a `between(expectedDate, ...)` range on
  every dashboard load (twice, after the Operational fix's overdue-payables
  addition).
- `transactions`: index on `matchedPaymentId` — already has the FK from the
  original schema, add the index explicitly since MySQL doesn't always
  auto-index a nullable FK column the way it does a `NOT NULL` one; verify
  via `SHOW INDEX` whether it's actually missing before adding a redundant
  one.

A schema change of this size needs one `drizzle-kit generate` migration.
Since this is additive (FKs/indexes on existing columns, no data change),
the only failure mode is a FK add rejecting because of orphaned rows already
in the dev DB (e.g. a `changedBy` value with no matching `users.id`) — the
task must run the migration against the real dev DB as part of its own
verification, not just generate it, and report if that happens (in which
case: fix the orphaned test fixtures, not the schema).

## 6. `varchar` → `decimal` for money/quantity-share columns

**Current state:** every monetary or fractional-share column in the schema
is `varchar`, so MySQL can store `"NaN"`, `""`, or any non-numeric garbage,
and can't `SUM`/`AVG` them natively. The application already treats every
one of these as a string end-to-end (`parseFloat(...)` on read, a plain
string on write) — Drizzle's `decimal(..., { mode: "string" })` returns and
accepts strings too, so this is a column-type change with no application
code change required, confirmed against every current `.toFixed(...)` call
site in the codebase (`server/shipments.ts:257` writes `unitCost` at 6
decimal places; `server/payments.ts:35` and every display formatter use 2).

Precision chosen with headroom above every confirmed write precision:

| Column(s) | Type | Why |
|---|---|---|
| `poLineItems.unitPrice`, `shipments.freightCost`/`dutyCost`, `payments.expectedAmount`/`paidAmount`/`baseCurrencyAmount`, `transactions.amount`, `salesPlanWeeklyInputs.plannedRevenue` | `decimal(18,4)` | Money amounts; 2dp is the only precision ever written today, 4dp is headroom. |
| `inventoryLedger.unitCost` | `decimal(18,6)` | Confirmed written at 6dp (`shipments.ts:257`). |
| `payments.fxRate`, `transactions.fxRate` | `decimal(12,6)` | FX rates need more than 2dp (e.g. `0.860000`). |
| `shipmentLineItems.weightShare`, `shipmentLineItems.valueShare` | `decimal(9,6)` | Always in [0,1]; 6dp headroom above any confirmed usage. |
| `salesPlanWeeklyInputs.primaryPercent` | `decimal(7,4)` | A percent, 0-100. |
| `salesPlanWeeklyRecipeLines.unitsPer1000` | `decimal(12,4)` | Units per €1,000 revenue — can exceed 100. |

**Correction (2026-09-21, Backlog Stream L)**: the "headroom above every
confirmed write precision" rule above is wrong — it measures headroom
against what the codebase happened to write at the time, not against real
source-data precision or the reconciliation tolerance that actually
consumes these values. This under-scaled `poLineItems.unitPrice` (real
Jello Sheet data carries up to 7 decimal places, not the 4dp any write site
happened to use), then `inventoryLedger.unitCost`, then
`shipmentLineItems.weightShare`/`valueShare` — three real reconciliation
failures during Stream L's real-data dry-run, only caught because that
stream re-validated against live data. All three are now `decimal(18,8)`/
`decimal(9,8)` respectively, confirmed via measured margin against the
`1e-6` R4 tolerance at real data magnitudes (≥58× for the landed-cost path,
≥8.75× for the ledger money path), not against a write site. The rule for
any future decimal column: size scale against the tolerance of whatever
check consumes the value at real data magnitudes, never against "what the
code currently happens to write."

Not changed: `payments.currency`/`transactions.currency`/`shipments.costCurrency`
(3-letter codes, correctly `varchar`), every non-numeric `varchar` (names,
refs, emails).

This needs its own migration (`drizzle-kit generate` after the `schema.ts`
edit). Before writing it, the task must check the dev DB for any existing
row in these columns that ISN'T a clean decimal string (a stray `""`,
`"NaN"`, or non-numeric value would make the `ALTER ... MODIFY` fail) —
query each column with a `WHERE column NOT REGEXP '^-?[0-9]+(\\.[0-9]+)?$'
AND column IS NOT NULL` check, fix or report any hit before proceeding, and
only then run the migration. The task's acceptance test: seed a row with
today's real precision in every changed column, run the migration, read it
back, and assert every value round-trips exactly unchanged (byte-for-byte
string equality) — proving the "drop-in" claim rather than assuming it.

## 7. Rename `.mjs` CLI scripts to `.ts`

**Current state, verified:** `tsconfig.json`'s `include` is
`["server", "client", "scripts"]` with no `allowJs`, so the 5
`scripts/*.mjs` files are invisible to `tsc` — confirmed by running
`pnpm check`, which reports zero errors or even any mention of them. All 5
are already thin (17-54 lines), already import their real logic from typed
`.ts` core modules (`reconcile-migration.ts`, `nightlyExport.ts`,
`dbClient.ts`, `shopifyDailyPull.ts`), and are already run via
`pnpm exec tsx scripts/<name>.mjs` per `RAILWAY.md` — `tsx` executes `.ts`
files identically, so renaming is a pure extension change with zero logic
change:

- `scripts/reset-password.mjs` → `scripts/reset-password.ts`
- `scripts/run-daily-shopify-pull.mjs` → `scripts/run-daily-shopify-pull.ts`
- `scripts/run-migration.mjs` → `scripts/run-migration.ts`
- `scripts/run-nightly-export.mjs` → `scripts/run-nightly-export.ts`
- `scripts/run-parallel-check.mjs` → `scripts/run-parallel-check.ts`

After renaming, update every reference to the old `.mjs` filenames in
`RAILWAY.md` (5 occurrences) to the new `.ts` filenames. Do not touch
references inside `docs/superpowers/plans/*.md` or `docs/BUILD-HISTORY.md` —
those are historical build records of what was true at the time and stay as
written, matching this project's existing convention of never rewriting
past build history. Run `pnpm check` after the rename and confirm it now at
least parses these 5 files (any real latent type error surfacing here is a
legitimate new finding to fix, not a sign the rename was wrong). This does
**not** add runtime validation of malformed JSON input (a separate, already
deferred concern — see `docs/2026-09-20-three-lens-architecture-review.md`'s
Shopify-pull finding) — it only closes the compile-time blind spot.

## Testing requirements

- FIFO unification: every existing test for `getRemainingBatches` and
  `getDailyCogsForRange` must pass unchanged (byte-identical behavior) —
  this proves the extraction preserved semantics.
- Dead code removal: `pnpm check` and `pnpm test` both green with the
  deleted tests removed, not skipped.
- Atomicity: at least one new test per function proving the transaction
  actually holds — the established pattern in this codebase (see
  `payments.test.ts`'s coverage of `markPaymentPaid`) is testing the
  before/after DB state and the `change_log` rows together, not testing
  rollback-on-crash directly (that would require fault injection this
  codebase doesn't have infrastructure for elsewhere either).
- Not-found guards: one test per newly-guarded function asserting a clear
  thrown message for a nonexistent id, matching the existing tests for the
  3 functions that already have this guard.
- FKs/indexes: migration applies cleanly against the real dev DB (not just
  generated) as part of the task's own verification.
- Decimal migration: the round-trip test described in section 6, plus every
  existing money-related test in the suite passing unchanged.
- `.mjs` rename: `pnpm check` green, and each renamed script's own existing
  test (where one exists, e.g. `reset-password.test.ts`) still passing.
