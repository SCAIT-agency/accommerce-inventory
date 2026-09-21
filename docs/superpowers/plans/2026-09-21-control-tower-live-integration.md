# Control Tower Live Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the validated `feat/real-data-dry-run` branch (2026-09-19, verdict SAFE TO CUT OVER against the live Jello Control Tower Sheet) onto current `main`, which has diverged by 118 commits since. Every business rule/mapping/algorithm is already correct and validated against real data — this plan's job is porting the code and adapting exactly the integration points that changed on `main`, not re-deriving anything.

**Architecture:** Ten tasks in dependency order. Each task's implementer extracts the relevant file(s) from the `feat/real-data-dry-run` branch via `git show feat/real-data-dry-run:<path>` as the starting point (this is real, tested, validated code — transcribe it faithfully), then applies the specific adaptation deltas named in this plan. Do not re-derive business logic from scratch; do not "improve" the ported algorithms beyond what each task's delta explicitly calls for.

**Tech Stack:** Node/Express + tRPC v11 + React + Drizzle ORM (MySQL/TiDB) + Vitest, matching the rest of this repo.

**Spec:** `docs/2026-09-21-control-tower-live-integration-design.md` (read this first — it has the full adaptation-point analysis every task below references by number). Also read `docs/2026-09-19-real-data-dry-run-design.md` on the `feat/real-data-dry-run` branch (`git show feat/real-data-dry-run:docs/2026-09-19-real-data-dry-run-design.md`) for the full original business-logic design this plan ports — especially §2 (Sheet → platform mapping) and §3 (backorder policy and FIFO series), which are the authoritative source for exact field mappings and formulas.

## Global Constraints

- Working directly on `main`, no worktree — same convention as every prior stream in this repo. `feat/real-data-dry-run` is never merged directly; every task extracts individual files from it via `git show`, adapts, and commits fresh onto `main`.
- Load env before any DB-touching command: `set -a && source .env && set +a`.
- `pnpm check` (`tsc --noEmit`) and `pnpm test` (`vitest run`) must both stay green after every task. Current baseline: 232 tests.
- Every ported algorithm/mapping/tolerance is transcribed faithfully from the source branch — cite the exact source file:line when a task's brief says "port verbatim." Only the 9 adaptation points named in the design doc's "What changed on `main`" section justify a deviation from the source branch's code.
- New scripts are born `.ts`, not `.mjs` (adaptation point in scope item 8) — this repo's `tsconfig.json` has no `allowJs`, and Backlog Stream J already fixed this exact gap for the 5 pre-existing CLI scripts.
- Commit after each task: `type: summary`, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (uniform across this repo regardless of which model executes the task).

---

### Task 1: Port pure utility files (no adaptation needed)

**Files:**
- Create: `scripts/control-tower/csv.ts`, `scripts/control-tower/csv.test.ts`
- Create: `scripts/control-tower/gviz.ts`
- Create: `scripts/control-tower/snapshot.ts`, `scripts/control-tower/snapshot.test.ts`
- Create: `scripts/control-tower/fixtures/*` (11 real CSV fixture files, captured 2026-09-19 from the live Sheet, bank columns scrubbed)

**Interfaces:**
- Produces: `parseCSV`/normalizers from `csv.ts` (used by `snapshot.ts` and downstream export code); `fetchTab`/`readSnapshot` from `gviz.ts`; `ControlTowerSnapshot` type + tab readers from `snapshot.ts` (used by every later task in this plan).

- [ ] **Step 1: Extract and commit the 4 pure files + fixtures verbatim**

```bash
git show feat/real-data-dry-run:scripts/control-tower/csv.ts > scripts/control-tower/csv.ts
git show feat/real-data-dry-run:scripts/control-tower/csv.test.ts > scripts/control-tower/csv.test.ts
git show feat/real-data-dry-run:scripts/control-tower/gviz.ts > scripts/control-tower/gviz.ts
git show feat/real-data-dry-run:scripts/control-tower/snapshot.ts > scripts/control-tower/snapshot.ts
git show feat/real-data-dry-run:scripts/control-tower/snapshot.test.ts > scripts/control-tower/snapshot.test.ts
mkdir -p scripts/control-tower/fixtures
for f in dailyCogs inventoryLedger landedCostSummary purchaseOrders salesPlanFF salesPlanMutual shipments skuMaster stockModelFF stockModelMutual transactions vendors; do
  git show "feat/real-data-dry-run:scripts/control-tower/fixtures/${f}.csv" > "scripts/control-tower/fixtures/${f}.csv"
done
```

These 4 code files have zero dependency on anything that changed on `main` (confirmed in the design doc's Scope §1) — no adaptation needed. Read each one after extracting to confirm it genuinely has no import touching a file this plan's later tasks will change (it shouldn't — `csv.ts`/`gviz.ts` have no project imports at all, `snapshot.ts` only imports from `csv.ts`).

- [ ] **Step 2: Run the extracted tests**

Run: `set -a && source .env && set +a && pnpm test control-tower`
Expected: `csv.test.ts` and `snapshot.test.ts` pass with no modification needed (pure functions, no DB, no dependency on anything this plan changes elsewhere).

- [ ] **Step 3: Run the full suite and type check**

Run: `pnpm test && pnpm check`
Expected: all pass (232 + the newly added tests), `tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/control-tower/csv.ts scripts/control-tower/csv.test.ts scripts/control-tower/gviz.ts scripts/control-tower/snapshot.ts scripts/control-tower/snapshot.test.ts scripts/control-tower/fixtures/
git commit -m "feat: port Control Tower Sheet reading (csv, gviz, snapshot) from feat/real-data-dry-run

Direct port, no adaptation needed -- these files have zero dependency on
anything that changed on main since the branch forked on 2026-09-19.
Includes the real Sheet fixture snapshot (bank columns scrubbed) captured
that day, reused as-is for offline replay and golden tests.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backorder policy

**Files:**
- Modify: `server/inventoryLedger.ts`
- Modify: `server/inventoryLedger.test.ts`

- [ ] **Step 1: Extract the delta and apply it to current `server/inventoryLedger.ts`**

Run `git show feat/real-data-dry-run:server/inventoryLedger.ts` and compare against the current file — the delta is exactly what's shown in the design doc's "What changed on `main`" point 1 excerpt (already quoted in full there): add `import { getAppSetting } from "./db";`, add the `ALLOW_BACKORDERS_SETTING` export and its doc comment, and change the negative-stock guard in `recordLedgerEvent` from:
```ts
if (currentSoh + event.qty < 0) {
```
to:
```ts
if (currentSoh + event.qty < 0 && (await getAppSetting(ALLOW_BACKORDERS_SETTING)) !== "true") {
```
Apply this delta onto the CURRENT file (post-Stream-J FIFO unification) — do not overwrite the whole file with the branch's version, since the branch's version predates the unification (`replayLedgerEventsFifo`, `FifoBatch`, `getRemainingBatches`'s current shape) and overwriting would silently revert that work. Confirm `getAppSetting` is exported from `server/db.ts` (it should already be, used elsewhere in this codebase for `standard_fx_rate` settings).

- [ ] **Step 2: Port the backorder-policy tests from `server/inventoryLedger.test.ts`**

Run `git show feat/real-data-dry-run:server/inventoryLedger.test.ts` and diff against the current file to find the backorder-specific test cases (guard trips with the setting absent, passes with it set to `"true"`, strict-mode tests unchanged). Port only the new/changed test cases — the current file has significant test additions of its own since the fork (the FIFO-unification work) that must not be removed or reverted.

- [ ] **Step 3: Run tests and type check**

Run: `pnpm test inventoryLedger && pnpm check`
Expected: all pass, backorder tests included.

- [ ] **Step 4: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: per-instance backorder policy (allow_backorders app_settings key)

Ported from feat/real-data-dry-run (validated against real Jello data --
the business launched on backorders, FF stock reached -35,986 in the real
Sheet before the first batch landed). recordLedgerEvent's negative-stock
guard now consults app_settings key allow_backorders on the path that
would otherwise throw, only paying that read's cost when it matters.
Strict instances (the default) are unaffected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Backorder-aware Daily COGS series + `getShipmentLandedUnitCost` transaction support

**Files:**
- Modify: `server/landedCost.ts`
- Create: `server/landedCost.series.test.ts`
- Modify: `server/landedCost.test.ts` (only if `getShipmentLandedUnitCost`'s existing tests need updating for the new `dbClient` parameter's default)

**Interfaces:**
- Produces: `computeFifoDailySeries(receipts, sales, from, to): DailyFifoRow[]` — used by Task 7's reconciliation code.
- Consumes/modifies: `getShipmentLandedUnitCost(shipmentId, dbClient?)` — its new optional `dbClient` parameter is consumed by Task 6's migration code.

- [ ] **Step 1: Add `computeFifoDailySeries` to current `server/landedCost.ts`**

Run `git show feat/real-data-dry-run:server/landedCost.ts` for the branch's full version of this function (the design doc's §3 formula, quoted in the design doc verbatim, is the authoritative math — cross-check the extracted code against it). Per adaptation point 1: define fresh local types in this file rather than resurrecting the deleted `LandedBatch`/`SaleEvent`:
```ts
export interface LandedBatch {
  qty: number;
  unitCost: number;
  date: Date;
}

export interface SaleEvent {
  qty: number;
  date: Date;
}
```
(Yes, these are the same names `computeFifoCogs` used to export before Stream J deleted them — that's fine, they're being reintroduced here as genuinely-needed types for a genuinely-different, still-live function, not as dead weight. Do not reintroduce `computeFifoCogs` or `FifoCogsResult` — only `computeFifoDailySeries` and the `DailyFifoRow` interface it returns need to exist.) Append `computeFifoDailySeries` (with its full doc comment explaining the formula, copied verbatim from the source branch) and the `DailyFifoRow` interface to the end of the current file, after `getShipmentLandedUnitCost`.

- [ ] **Step 2: Add the `dbClient` parameter to `getShipmentLandedUnitCost`**

Per adaptation point 8: add `import { db, type DbClient } from "./dbClient";` (currently just `import { db } from "./dbClient";`), change the function signature from `getShipmentLandedUnitCost(shipmentId: number)` to `getShipmentLandedUnitCost(shipmentId: number, dbClient: DbClient = db)`, and change every internal `db.select()` call in the function body to `dbClient.select()`. The function's current return shape (`{ lineItemId, skuId, landedUnitCost }[]`, already including `lineItemId` — added after the dry-run branch forked) does not change; do not alter it to match the branch's older `{ skuId, landedUnitCost }[]` shape.

- [ ] **Step 3: Port the series tests to a new `server/landedCost.series.test.ts`**

```bash
git show feat/real-data-dry-run:server/landedCost.series.test.ts > server/landedCost.series.test.ts
```
This file should port cleanly as a new, separate test file (confirm by reading it — it should only import `computeFifoDailySeries`/`DailyFifoRow` from `./landedCost`, both added in Step 1). It includes the golden test against the real Daily COGS fixture (`scripts/control-tower/fixtures/dailyCogs.csv`, ported in Task 1) — confirm the fixture path this test references matches where Task 1 actually put it.

- [ ] **Step 4: Check whether `server/landedCost.test.ts`'s existing tests need updating for the `dbClient` default**

Adding an optional parameter with a default is not a breaking change — existing calls with just `shipmentId` should keep working unchanged. Run the existing test file and confirm; only touch it if something genuinely breaks (unexpected, but check rather than assume).

- [ ] **Step 5: Run tests and type check**

Run: `pnpm test landedCost && pnpm check`
Expected: all pass including the new series tests and the golden fixture test.

- [ ] **Step 6: Commit**

```bash
git add server/landedCost.ts server/landedCost.series.test.ts server/landedCost.test.ts
git commit -m "feat: backorder-aware Daily COGS series (computeFifoDailySeries)

Ported from feat/real-data-dry-run, validated against 570 real Daily COGS
data points from the live Jello Sheet (golden test against the real
fixture, matching the Sheet's own buildDailyCogs convention including its
2026-09-17 retroactive-pricing fix). A deliberately separate function from
the dashboard's own FIFO path (server/salesPlan.ts's getDailyCogsForRange)
-- serves only the reconciliation tooling this stream is building.

getShipmentLandedUnitCost gains an optional dbClient parameter so the
real-data migration can call it inside its own transaction and see rows
not yet committed to the pool.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `recordSalesActual` transaction support

**Files:**
- Modify: `server/salesPlan.ts`
- Modify: `server/salesPlan.test.ts` (if needed — likely not, since this is an additive optional-parameter change)

- [ ] **Step 1: Apply the `dbClient` parameter delta**

Per adaptation point 2 and the design doc's excerpt of this exact diff: change `recordSalesActual`'s signature from `(input: RecordSalesActualInput): Promise<void>` to `(input: RecordSalesActualInput, dbClient: DbClient = db): Promise<void>`, and change the body from unconditionally opening `db.transaction(...)` to the pattern shown in the design doc (open a transaction only when called with the default `db`; when passed an explicit `dbClient`, join it instead of nesting a transaction inside a transaction). Copy the exact code shown in the design doc's point 2 excerpt for `server/salesPlan.ts` — it's a small, self-contained delta (12 lines).

- [ ] **Step 2: Run tests and type check**

Run: `pnpm test salesPlan && pnpm check`
Expected: all pass unchanged (existing callers use the default `dbClient = db`, so behavior for them is identical).

- [ ] **Step 3: Commit**

```bash
git add server/salesPlan.ts
git commit -m "fix: recordSalesActual joins an existing transaction instead of nesting one

Ported from feat/real-data-dry-run. The real-data migration writes sales
actuals inside its own single transaction; recordSalesActual previously
always opened its own, which would either nest (most drivers reject this)
or silently commit early, breaking the migration's all-or-nothing guarantee.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `migrate-from-sheet.ts` transform extensions

**Files:**
- Modify: `scripts/migrate-from-sheet.ts`
- Modify: `scripts/migrate-from-sheet.test.ts`

**Interfaces:**
- Produces: extended `PaymentSheetRow`/`ShipmentSheetRow`/`TransactionSheetRow` types, `salesActualRows`/`salesPlanRows`-producing transforms — consumed by Task 6's `runMigration`.

- [ ] **Step 1: Extract the branch's full `migrate-from-sheet.ts` and diff against current `main`**

```bash
git show feat/real-data-dry-run:scripts/migrate-from-sheet.ts > /tmp/branch-migrate-from-sheet.ts
diff /tmp/branch-migrate-from-sheet.ts scripts/migrate-from-sheet.ts
```
Read both the diff and the design doc's §2 (Sheet → platform mapping) side by side. Apply the branch's changes onto the CURRENT file, preserving every piece of `main`'s own evolution since the fork (check `git log --oneline main -- scripts/migrate-from-sheet.ts` for what's landed there since Stream B — there should be none, per the design doc's adaptation point 9 confirming this file is still Stream-B-era on `main`, but verify this claim yourself rather than trusting it blindly).

Apply, per the design doc's Scope item 5 and the original design's §2 (verbatim field mappings — do not reinterpret):
- `PaymentSheetRow` gains `paid?: boolean` and `paidDate?: Date`.
- `ShipmentSheetRow` gains `plannedDepartDate?`/`actualDepartDate?`/`plannedArrivalDate?`/`actualArrivalDate?` (all optional `Date`).
- Pooled-container merging: rows named `<prefix>Container<N>-<SKU>` merge into one shipment with N lines, validated for date/warehouse consistency across the merged rows; a conflicting variant (same container prefix, disagreeing dates/warehouse) is quarantined with the conflict spelled out in the quarantine reason, not silently merged wrong.
- `TransactionSheetRow` gains `matchedRef?: string` (from the Sheet's `PO#/Shipment Ref` column).
- New exported transform functions producing `salesActualRows`/`salesPlanRows` from the Sales Plan FF/Mutual tabs (per the original design's §2 "Ledger sales + sales_actuals" and "Sales plan" subsections) — these are NEW `RunMigrationInput` fields Task 6 will add, not part of the existing `ledgerRows` field (receipts only).

- [ ] **Step 2: Port and adapt the test file**

```bash
git show feat/real-data-dry-run:scripts/migrate-from-sheet.test.ts > /tmp/branch-migrate-from-sheet.test.ts
```
Merge the branch's new test cases (pooled-container merge including the deliberately-conflicting variant that must quarantine, the new sales-actuals/sales-plan transforms, the paid-flag/date fields, the `matchedRef` field, fx derivation, match-rule edge cases) into the current test file, preserving `main`'s own existing test coverage.

- [ ] **Step 3: Run tests and type check**

Run: `pnpm test migrate-from-sheet && pnpm check`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-from-sheet.ts scripts/migrate-from-sheet.test.ts
git commit -m "feat: extend Sheet transform for paid flags, dates, pooled containers, sales data

Ported from feat/real-data-dry-run, field mappings validated against the
live Control Tower Sheet on 2026-09-19. PaymentSheetRow/ShipmentSheetRow
gain the fields needed for money and status fidelity; rows named
<prefix>Container<N>-<SKU> (one physical container split across per-SKU
Sheet rows) merge into one pooled shipment; new transforms produce
sales_actuals/sales_plan rows from the Sales Plan tabs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `reconcile-migration.ts`'s `runMigration` extensions (largest task in this plan)

**Files:**
- Modify: `scripts/reconcile-migration.ts`
- Modify: `scripts/reconcile-migration.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5's ported functions (`ALLOW_BACKORDERS_SETTING`, `computeFifoDailySeries`/`getShipmentLandedUnitCost` with `dbClient`, `recordSalesActual` with `dbClient`, extended `migrate-from-sheet.ts` types/transforms).
- Consumes (unchanged): current `main`'s `markPaymentPaidCore` (`server/payments.ts`), `matchTransactionToPayment` (`server/payments.ts`), `createSalesPlanEntry` (`server/salesPlan.ts`), `ensureMigrationUser()` (already in this same file).

- [ ] **Step 1: Read current `main`'s full `server/payments.ts` for the exact signatures this task must call**

Before writing anything, read `markPaymentPaidCore`'s and `matchTransactionToPayment`'s current signatures and the exact shape of `MarkPaymentPaidOpts`/`MatchTransactionOpts` they take (both are internal/exported types in `server/payments.ts` — check which). Per adaptation point 3: `markPaymentPaidCore` is not currently exported from `server/payments.ts` (only `markPaymentPaid`, the wrapper, is) — you likely need to export `markPaymentPaidCore` too so this migration script can call it with the transaction client directly (the wrapper `markPaymentPaid` always opens its own transaction, which would nest inside the migration's already-open one). Make this export change in `server/payments.ts` as part of this task if needed — it's a one-line `export` addition, not a behavior change.

- [ ] **Step 2: Extract the branch's `reconcile-migration.ts` and identify every piece current `main` doesn't have**

```bash
git show feat/real-data-dry-run:scripts/reconcile-migration.ts > /tmp/branch-reconcile-migration.ts
diff /tmp/branch-reconcile-migration.ts scripts/reconcile-migration.ts
```
Per adaptation points 3, 5, 8, 9 (all in the design doc): the branch's version predates `ensureMigrationUser()` (which already exists on current `main`, added by an unrelated Stream J fix) and predates `markPaymentPaidCore`'s current core/wrapper shape (the branch calls an older `markPaymentPaid(..., tx)` signature that no longer exists). This is the task where "port verbatim" needs the most judgment — port the STRUCTURE and BUSINESS LOGIC (which fields get set, in what order, under what conditions, per §2/§3/§4 of the original design and the decided-rules delta) verbatim, but write the actual function CALLS against current `main`'s real signatures, not the branch's.

Extend `RunMigrationInput` with `salesActualRows`/`salesPlanRows` (Task 5's new transform outputs) and change `landedCostTotals`'s handling: remove the "throws if non-empty" guard entirely (its reason for existing — unknown real Sheet column names — no longer applies now that this task wires it to `getShipmentLandedUnitCost` for real), and change its type per the design doc's original §4: `{ shipmentRef, sku, landedCostFromSheet }[]`, with `reconcileMigration`'s landed-cost dependency becoming `getMigratedLandedCost(shipmentRef, sku)`, wired inside `runMigration` to `getShipmentLandedUnitCost` on `tx`.

Inside `runMigration`'s transaction (after the existing PO/shipment/payment/transaction/ledger-event writes, keeping every one of `main`'s own existing Findings-1-through-6 comments and their fixes intact — read them before editing, they document real bugs a prior stream fixed and must not regress):
- **Paid-flag handling**: for each transformed payment with `paid === true`, call `markPaymentPaidCore(paymentId, { amount: expectedAmount, fxRate: "1", paidDate, reasonCategory: "other", reasonNote: "migrated from Control Tower", changedBy: migrationUserId }, tx)` (verify this exact opts shape against `MarkPaymentPaidOpts`'s real current fields from Step 1 — adjust field names if they differ from this sketch). A `paid: true` with no `paidDate` quarantines with that reason (per the original design's exact wording), not a thrown error.
- **Transaction matching**: for each transaction with a `matchedRef`, resolve it per the original design's exact matching rule (a ref equal to exactly one migrated PO number → match to that PO's earliest unmatched, paid payment; the amount tolerance is 1%, escalating to 5% for the decided FX-drift/partial-payment variance tier — port this exact two-tier rule from the branch's later `ea7d1b3` commit, not just the original design's initial 1%-only version, which the same-day decisions superseded). Call `matchTransactionToPayment(transactionId, paymentId, { reasonCategory: "other", reasonNote: "migrated from Control Tower", changedBy: migrationUserId }, tx)` — again verify the exact current `matchTransactionToPayment` signature/opts shape from Step 1 before writing this call; recall `matchTransactionToPayment` also now atomically marks the matched payment paid using the transaction's own amount/date (a Priority-1 Operational-cleanup addition) — decide during implementation whether this migration path should call `matchTransactionToPayment` alone (letting it handle both matching AND paying) for an already-paid-in-Sheet payment, or whether the explicit `markPaymentPaidCore` call from the paid-flag step above already covers that and matching should run after, not double-write. Read `matchTransactionToPayment`'s current implementation in full before deciding — this is exactly the kind of adaptation-point judgment call this task exists to make correctly, not a place to guess.
- **Sales writes**: `recordSalesActual({ ... }, tx)` for each `salesActualRows` entry, `createSalesPlanEntry({ ... }, tx)` for each `salesPlanRows` entry.
- **Real landed-cost reconciliation wiring**: replace the removed guard with the actual `getMigratedLandedCost` dependency wired to `getShipmentLandedUnitCost(shipmentId, tx)`.

- [ ] **Step 3: Port and adapt the test file**

```bash
git show feat/real-data-dry-run:scripts/reconcile-migration.test.ts > /tmp/branch-reconcile-migration.test.ts
```
Merge the branch's new test coverage (paid-flag sets `paid`/`paidDate` and writes change_log rows on the tx client; manual match resolves including the variance-tier cases; unresolvable refs are reported not thrown; sales actuals land in both tables; landed-cost reconciliation now runs real comparisons, including a fixture with a wrong Sheet cost that must fail the gate) into the current test file, preserving `main`'s own existing coverage (including the Findings-1-through-6 regression tests already there).

- [ ] **Step 4: Run tests and type check**

Run: `pnpm test reconcile-migration payments && pnpm check`
Expected: all pass. Run the `payments` suite too since Step 1 may have changed `server/payments.ts`'s exports.

- [ ] **Step 5: Commit**

```bash
git add scripts/reconcile-migration.ts scripts/reconcile-migration.test.ts server/payments.ts
git commit -m "feat: wire real Control Tower money/sales migration and landed-cost reconciliation

Ported from feat/real-data-dry-run, extending runMigration with paid-flag
transfer, manual transaction-to-payment link transfer (1% exact, 5%
variance tier for FX drift / partial payments -- the decided rule from
Artem's 2026-09-19 review), sales_actuals/sales_plan writes, and real
landed-cost reconciliation (replacing the placeholder that threw on any
non-empty landedCostTotals). Adapted to call through main's current
markPaymentPaidCore/matchTransactionToPayment signatures, which evolved
past what the source branch had.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Reconciliation-target readers and report (`reconcile.ts`, `targets.ts`, `export.ts`, `report.ts`, `classifications.ts`)

**Files:**
- Create: `scripts/control-tower/export.ts`, `export.test.ts`
- Create: `scripts/control-tower/targets.ts`, `targets.test.ts`
- Create: `scripts/control-tower/reconcile.ts`, `reconcile.test.ts`
- Create: `scripts/control-tower/report.ts`, `report.test.ts`
- Create: `scripts/control-tower/classifications.ts`
- Create: `scripts/control-tower/compare.ts`, `compare.test.ts`

**Interfaces:**
- Consumes: Task 1's `snapshot.ts`/`ControlTowerSnapshot`, Task 3's `computeFifoDailySeries`/`DailyFifoRow`/`getShipmentLandedUnitCost`, Task 5's extended `migrate-from-sheet.ts` types, Task 6's `RunMigrationResult`/`Mismatch` types.

- [ ] **Step 1: Extract all 6 files + their tests verbatim**

```bash
for f in export targets reconcile report classifications compare; do
  git show feat/real-data-dry-run:scripts/control-tower/${f}.ts > scripts/control-tower/${f}.ts
done
for f in export targets reconcile report compare; do
  git show feat/real-data-dry-run:scripts/control-tower/${f}.test.ts > scripts/control-tower/${f}.test.ts
done
```

- [ ] **Step 2: Fix import resolution against current file locations/signatures**

Per the design doc's Scope item 7: these files' own comparison/reporting logic needs no adaptation (R1-R7 target definitions, tolerances, classification categories are all still correct, unchanged by anything on `main`), but their imports must resolve against current signatures — specifically `getShipmentLandedUnitCost`'s now-required `lineItemId` in its return shape (Task 3) and `computeFifoDailySeries`'s fresh local types (Task 3) rather than the deleted `LandedBatch`/`SaleEvent`. Read each file's imports and fix any that reference a shape Task 3 changed.

- [ ] **Step 3: Run tests and type check**

Run: `pnpm test control-tower && pnpm check`
Expected: all pass, including `reconcile.test.ts`'s comparison logic against Task 1's real fixture data.

- [ ] **Step 4: Commit**

```bash
git add scripts/control-tower/export.ts scripts/control-tower/export.test.ts scripts/control-tower/targets.ts scripts/control-tower/targets.test.ts scripts/control-tower/reconcile.ts scripts/control-tower/reconcile.test.ts scripts/control-tower/report.ts scripts/control-tower/report.test.ts scripts/control-tower/classifications.ts scripts/control-tower/compare.ts scripts/control-tower/compare.test.ts
git commit -m "feat: port Control Tower reconciliation targets (R1-R7) and markdown report

Direct port from feat/real-data-dry-run, adjusted only for current
signature shapes (getShipmentLandedUnitCost's lineItemId field,
computeFifoDailySeries's fresh local types) -- the R1-R7 target
definitions, tolerances, and classification categories are unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Orchestrator, CLI scripts, ops files, package.json

**Files:**
- Create: `scripts/control-tower/dryrun.ts`, `dryrun.test.ts`
- Create: `scripts/run-dryrun.ts` (renamed from the source branch's `run-dryrun.mjs`)
- Create: `scripts/parallel-run.ts` (renamed from the source branch's `parallel-run.mjs`)
- Create: `ops/com.scait.accommerce-parallel-run.plist`, `ops/parallel-run-daily.sh`
- Modify: `package.json`

- [ ] **Step 1: Extract `dryrun.ts` (the orchestrator's core logic) and its test**

```bash
git show feat/real-data-dry-run:scripts/control-tower/dryrun.ts > scripts/control-tower/dryrun.ts
git show feat/real-data-dry-run:scripts/control-tower/dryrun.test.ts > scripts/control-tower/dryrun.test.ts
```
Fix imports per the same signature-shape adjustments as Task 7 if any apply here (check — `dryrun.ts` imports from `reconcile-migration.ts`/`migrate-from-sheet.ts`, both changed by Tasks 5-6, and from `landedCost.ts`, changed by Task 3).

- [ ] **Step 2: Extract and rename the two `.mjs` CLI wrappers to `.ts`**

```bash
git show feat/real-data-dry-run:scripts/run-dryrun.mjs > scripts/run-dryrun.ts
git show feat/real-data-dry-run:scripts/parallel-run.mjs > scripts/parallel-run.ts
```
Per adaptation point in Scope item 8 (and matching Backlog Stream J's established convention): these are extracted as `.ts` files from the start, not `.mjs` then renamed. Read each after extracting — they're thin CLI wrappers (read `scripts/run-nightly-export.ts` as the reference pattern this repo already established for exactly this kind of script), so no content changes should be needed beyond the extension itself, but verify each still runs correctly under `tsx` given its imports resolve to the now-`.ts` sibling files.

- [ ] **Step 3: Extract the `ops/` files verbatim**

```bash
mkdir -p ops
git show feat/real-data-dry-run:ops/com.scait.accommerce-parallel-run.plist > ops/com.scait.accommerce-parallel-run.plist
git show feat/real-data-dry-run:ops/parallel-run-daily.sh > ops/parallel-run-daily.sh
chmod +x ops/parallel-run-daily.sh
```
Check `ops/parallel-run-daily.sh`'s content for any reference to the old `.mjs` filename and update it to `.ts` to match Step 2.

- [ ] **Step 4: Add `package.json` scripts**

Add (matching whatever the source branch's `package.json` diff shows, adjusted for the `.ts` extensions from Step 2):
```json
"dryrun": "tsx scripts/run-dryrun.ts",
"parallel-run": "tsx scripts/parallel-run.ts"
```
(Check the source branch's exact script definitions via `git show feat/real-data-dry-run:package.json` and adapt only the file extensions — keep any flags/arguments the branch's version already has.)

- [ ] **Step 5: Run tests and type check**

Run: `pnpm test && pnpm check`
Expected: all pass, full suite green.

- [ ] **Step 6: Smoke-test the orchestrator against the offline fixture snapshot**

Run: `set -a && source .env && set +a && pnpm dryrun --snapshot scripts/control-tower/fixtures` (or whatever the actual offline-replay invocation the ported `run-dryrun.ts` expects — check its argument handling first). This does NOT need to hit the live Sheet — Task 1's committed real fixture snapshot is sufficient for this smoke test. Confirm it runs end-to-end without crashing and produces some report output; the FULL verification against expected R1-R7 numbers happens in Task 10, not here.

- [ ] **Step 7: Commit**

```bash
git add scripts/control-tower/dryrun.ts scripts/control-tower/dryrun.test.ts scripts/run-dryrun.ts scripts/parallel-run.ts ops/ package.json
git commit -m "feat: dry-run orchestrator, parallel-run script, and launchd job

Ported from feat/real-data-dry-run. Both CLI entrypoints are born .ts, not
.mjs, matching Backlog Stream J's established convention (tsconfig.json
has no allowJs, so a new .mjs script would reintroduce the exact tsc
blind spot that stream just closed for the 5 pre-existing scripts).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Decimal round-trip verification for the migration path

**Files:**
- Create: `server/controlTowerDecimalMigration.test.ts` (or add to an existing relevant test file — implementer's judgment on the cleanest home, following this codebase's existing test-file-per-concern convention)

**Interfaces:**
- Consumes: `runMigration` (Task 6), the decimal-typed columns Backlog Stream J introduced.

- [ ] **Step 1: Write the round-trip test**

Not a port — this is new, needed because of adaptation point 6 (decimal columns didn't exist when the source branch was written). Seed a small, realistic migration input (one PO with a payment, one shipment with recorded costs, one transaction) through the real `runMigration` path, with money/share values at genuinely meaningful precision (e.g. a `unitCost` at 6 decimal places, matching what `getShipmentLandedUnitCost`'s real landed-cost computation produces), then read every decimal-typed field back and assert it matches what was written — reusing the exact pattern Backlog Stream J's own `server/decimalMigration.test.ts` established (read that file first for the pattern, including its handling of MySQL's zero-padding behavior on read-back).

- [ ] **Step 2: Run the test and the full suite**

Run: `pnpm test && pnpm check`
Expected: all pass, this new test included.

- [ ] **Step 3: Commit**

```bash
git add server/controlTowerDecimalMigration.test.ts
git commit -m "test: prove the real-data migration's decimal values round-trip exactly

New test (not a port -- Backlog Stream J's decimal migration postdates the
source branch). Proves the migration path's money/share values survive
the now-decimal columns at full precision, following the same pattern
server/decimalMigration.test.ts already established.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Re-run the dry-run against current `main`, commit the real result, update docs

**Files:**
- Create: `docs/dryrun/<today's date>/report.md` (the ACTUAL re-run output, not the original 2026-09-19 report copied over)
- Modify: `docs/BACKLOG.md`, `docs/BUILD-HISTORY.md`, `README.md`

- [ ] **Step 1: Run the real dry-run**

Run: `set -a && source .env && set +a && pnpm dryrun` (against the live Sheet, if this environment has network access to it — the Sheet id is `1pSVrpDwiN6Ja2RfwVbsxj4H6J3eBRtnLtKNc1TGtoMk`, confirmed link-shared and gviz-readable as of 2026-09-19/21) or `pnpm dryrun --snapshot scripts/control-tower/fixtures` (offline replay against Task 1's committed real fixture snapshot, if live access isn't available in this environment — check which is actually possible before choosing).

- [ ] **Step 2: Compare the result against the original validated target**

The target (from the design doc's "Final validated result"): R1 6/6, R2 576/576, R3 570/570, R4 23/24 (1 confirmed Sheet-side bug), R5 22/22, R6 3/3, R7 6/6, 0 quarantines, 0 untransferable links, 20/20 payments and 20/20 links transferred. If the re-run's actual result matches this exactly (using the offline fixture replay, it should — same input data, same now-correctly-ported logic), commit the real output as-is. If it differs (a live-Sheet re-run naturally will, since real data has moved on since 2026-09-19 — new POs, more sales days, etc.), that is expected and fine; report the real numbers, do not force them to match the original. If a genuine new mismatch appears that isn't explained by "the Sheet has more real data now," treat it as a real finding — do not silently paper over it to get a clean report. If you cannot resolve a genuine mismatch yourself with reasonable confidence, STOP and report it rather than guessing at a fix — this is exactly the kind of finding this whole stream exists to catch before Artem trusts a cutover verdict.

- [ ] **Step 3: Commit the real report**

```bash
mkdir -p "docs/dryrun/$(date +%Y-%m-%d)"
# (the orchestrator itself should have already written the report to this path or similar -- confirm its actual output location and commit that file)
git add docs/dryrun/
```

- [ ] **Step 4: Update `docs/BACKLOG.md`**

Add a section (or extend section B, wherever the migration-readiness items already live) marking the real-data dry-run item done, pointing at the new report, noting the same-day-decided rules (pooled containers, variance tiers) are now real platform behavior, not just a documented convention.

- [ ] **Step 5: Update `docs/BUILD-HISTORY.md`**

Add a "Backlog Stream L — Control Tower live integration" narrative section, following this repo's established per-stream format (see the Stream J/K entries immediately above it for the pattern): what was ported, what adaptation points required real judgment (the `markPaymentPaidCore`/`matchTransactionToPayment`-vs-double-write decision from Task 6 in particular — record whatever the implementer actually decided there and why), the final whole-branch review's findings (see Final Review section below), the actual re-run result from Step 2.

- [ ] **Step 6: Update `README.md`'s Current Status**

State the dry-run result honestly, matching the source branch's own original README delta style (quoted in the merge-tree preview earlier in this stream's investigation) but with the actual current re-run numbers, not the original 09-19 ones. Update the test count.

- [ ] **Step 7: Final full verification**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: full suite green, `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add docs/BACKLOG.md docs/BUILD-HISTORY.md README.md
git commit -m "docs: close out Backlog Stream L (Control Tower live integration)

Re-ran the dry-run against [live Sheet | the committed real fixture
snapshot] on current main -- see docs/dryrun/<date>/report.md for the real
result. Updates BACKLOG.md, BUILD-HISTORY.md, and README's Current Status.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Review

After all 10 tasks: dispatch the final whole-branch code reviewer (most capable available model) against the full diff from this stream's first commit to its last. This review needs to do more than the usual cross-task-interaction check — pay special attention to:

1. **Every one of the 9 adaptation points in the design doc actually got applied correctly**, not just "the code was ported." Re-verify each one against the final state of the relevant files, the same way this plan's own design doc verified them against `main`'s state before any task ran.
2. **Task 6's `markPaymentPaidCore`-vs-`matchTransactionToPayment` decision** (the one genuine design judgment call this plan delegates to the implementer rather than fully specifying) — read what was actually decided and trace through the real code to confirm no payment gets double-written or left in an inconsistent state when both a `paid: true` flag AND a `matchedRef` exist on the same Sheet row for the same payment.
3. **The pooled-container merge logic** (Task 5) actually produces the exact same result Artem's real decision specified (`Container 2`'s 3 per-SKU rows → 1 shipment, 3 lines, freight/duty shares from the Sheet's own per-row split) — trace this by hand against the real fixture data, don't just check the code shape matches the branch's.
4. **The variance-tier link-transfer rule** (1% exact, 5% for the decided FX-drift/partial-payment tier) is applied consistently between `reconcile-migration.ts` (the actual migration) and `reconcile.ts` (R5/R6 reconciliation-target checking) — a mismatch between the two would mean the migration transfers a link the reconciliation then reports as wrong, or vice versa.
5. **Task 10's actual re-run result** — read the real committed report and confirm it's genuinely the output of a real run against this stream's own final code, not stale/copied.

If the final whole-branch review returns findings, dispatch ONE fix subagent with the complete findings list, then one scoped re-review, per this project's established process. Update `docs/BACKLOG.md`/`docs/BUILD-HISTORY.md`/`README.md` again if the fix round changes the actual re-run result. Then push per the established `gh auth switch` dance (`gh auth switch --user Artem-SCM-AI`, push, `gh auth switch --user ArtemTucann`).
