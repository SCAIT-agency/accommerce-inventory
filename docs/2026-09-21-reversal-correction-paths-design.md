# Reversal / Correction Paths — Design

## 1. Problem

No reversal or correction path exists anywhere in this codebase for stock, cost, or payment data. Once a shipment is marked arrived, its receipt quantity and landed cost are permanently written into `inventory_ledger` (the single append-only source of truth for SOH and Daily COGS) with no way to fix a wrong value except raw SQL. Once a payment is marked paid, `markPaymentPaidCore` can technically be re-called and will silently overwrite `paidAmount`/`paidDate`/`fxRate` — but nothing makes this an explicit, intentional "correction" versus an accidental re-run.

This gap has been flagged repeatedly across this project's own history:

- Stream I's three-lens architecture review (2026-09-20, Operational/Cook lens): "no reversal or correction path exists anywhere for stock, cost, or payment data (a wrong receipt qty, landed cost, or payment can never be corrected or reversed)" — deliberately deferred at the time as needing its own design pass.
- Stream G's own build (2026-09-20): `getShipmentLandedUnitCost` was found to accept an invalid `weightShare`/`valueShare` and "silently compute (and, via `markShipmentArrived`, permanently write) a wrong or `NaN` landed cost into `inventory_ledger` with no reversal path" — found independently by all three review lenses. Fixed by adding input validation at write time, but the underlying question — what happens if a bad value gets written anyway, by some other path not yet imagined — was never answered.

This design closes that gap, as a **preventive, architectural pass ahead of production cutover** — not in response to any specific known-bad row in current data.

## 2. Scope

In scope: a correction mechanism for (a) a wrong receipt quantity or landed cost already written to `inventory_ledger` via a shipment arrival, and (b) a wrong amount/date/fxRate already recorded on a paid payment. Both a backend API (tRPC procedures, fully tested) and a minimal UI entry point on the existing Shipments/Transactions pages.

Out of scope (explicitly, not silently dropped):

- Retroactively rewriting historical Daily COGS. Corrections are **forward-only** — see §4.
- A generic "undo any mutation" framework. This is scoped to the three ledger/payment scenarios above.
- Reversal for `purchase_orders`/`vendors`/`warehouses` field edits — those already go through ordinary update functions with `change_log` audit; nothing about them is append-only or FIFO-sensitive, so they don't need this mechanism.
- A UI "preview" step showing what a correction will change before committing. Deferred — see §7's note on `consumedFromOtherBatches` as the chosen alternative.

## 3. Data model changes

`drizzle/schema.ts`'s `inventory_ledger` table gains five nullable columns (existing rows unaffected):

```ts
correctsEventId: int("correctsEventId"), // self-referencing FK, see note below
changedBy: int("changedBy").references(() => users.id),
reasonCategory: mysqlEnum("reasonCategory", REASON_CATEGORIES),
reasonNote: text("reasonNote"),
lineItemId: int("lineItemId").references(() => shipmentLineItems.id),
```

**`lineItemId` closes a real ambiguity this design would otherwise reintroduce.** Stream G's own build (2026-09-20) found and fixed exactly this bug class: a shipment can legitimately have two line items sharing the same SKU (e.g. two POs' worth of the same product pooled onto one physical shipment), and `getShipmentLandedUnitCost`/`markShipmentArrived` were changed at the time to key by `lineItemId`, not `skuId`, for precisely this reason. `inventory_ledger` itself, however, still only records `skuId` — so two such line items produce two `receipt` events that are genuinely indistinguishable from each other by any ledger-level query (same `sourceRef`, same `skuId`). Without `lineItemId` on the ledger, §5's correction wrappers would be unable to disambiguate which of the two receipts to correct — not a silent-corruption risk (the ambiguity guard in §5 throws rather than guessing), but a real "correction is simply impossible for this specific, already-known-to-occur shipment shape" gap. Since `markShipmentArrived` already has `line.id` in scope at the exact point it calls `recordLedgerEvent` (see `server/shipments.ts`'s existing loop), populating `lineItemId` going forward costs nothing extra. Historical rows written before this change keep `lineItemId: null` — no backfill attempted (forward-only, per this design's own principle); §5's lookup falls back to the current `skuId`-based query, with its existing ambiguity guard, only when `lineItemId` isn't available to disambiguate.

`correctsEventId` is a self-referencing FK back onto `inventory_ledger.id` — a correction's reversal row and its replacement receipt row both point at the id of the original, wrong event. This gives a hard trace ("show me everything that corrected event #4821") independent of parsing `sourceRef`/`reasonNote` text. This schema has no existing same-table self-reference to follow as precedent, but Drizzle's column builder supports it directly via the same lazy `.references(() => inventoryLedger.id)` callback every other FK in this file already uses (the callback defers evaluation until the table object exists, so referencing the table being defined is not a forward-reference problem) — no special two-step migration SQL needed. The invariant that only correction writes ever set this column is enforced entirely in application code (`correctLedgerReceipt`), same as every other business-rule invariant in this codebase that isn't itself expressible as a DB constraint.

`shared/constants.ts`'s `REASON_CATEGORIES` gains one new value: `"data_correction"` — distinct from the existing 9 (which describe *why a plan changed*, e.g. `production_delay`, `freight_rate_change`), because none of them honestly describe "we are fixing our own data-entry mistake." This category is set internally by every correction function in this design, never offered as a user-chosen dropdown option for corrections specifically (see §7).

No changes to `LEDGER_EVENT_TYPES` (`["receipt", "sale", "adjustment"]`) and no changes to `replayLedgerEventsFifo`'s consumption logic. A correction's reversal is an ordinary `"adjustment"` event with negative qty; its replacement is an ordinary `"receipt"` event. Both already have fully correct, already-tested FIFO-replay handling.

## 4. Core primitive: `correctLedgerReceipt`

`server/inventoryLedger.ts`:

```ts
export interface LedgerCorrectionResult {
  reversalId: number;
  correctedId: number;
  // true iff the reversal's FIFO consumption touched stock from a batch
  // OTHER than the one being corrected, because the original batch no
  // longer had enough remaining quantity to fully absorb its own reversal
  // (i.e. it had already been partly or fully sold through). This is the
  // direct, surfaced consequence of the forward-only design (see below) —
  // callers must not treat a correction as a no-op on other batches.
  consumedFromOtherBatches: boolean;
}

export async function correctLedgerReceipt(
  eventId: number,
  corrections: { qty?: number; unitCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
  dbClient: DbClient = db,
): Promise<LedgerCorrectionResult>
```

**Forward-only correction.** This design does NOT retroactively rewrite history: it never edits or deletes an existing ledger row, and it never re-runs FIFO replay against past sale events to make them "point at" the corrected batch. It only appends two new events, dated today, that net out to the corrected state going forward. Consequence: Daily COGS already computed and reported for past days does not change. This was confirmed as the intended trade-off in review (vs. a full retroactive replay, judged "surprisingly risky for an append-only ledger," and vs. a manual-only path, judged "less automated, more control" but not chosen).

**Algorithm** (one transaction — joins the caller's `tx` if `dbClient !== db`, exactly like `recordSalesActual`'s existing core/wrapper pattern):

1. Read the original event by `eventId`.
   - Throw `no ledger event found with id ${eventId}` if it doesn't exist.
   - Throw `event ${eventId} is not a receipt — only receipt events can be corrected` if `eventType !== "receipt"` (sales and adjustments are *derived* from receipts via FIFO replay; you correct the receipt that caused them, not the derived event itself).
   - Throw `event ${eventId} has already been corrected` if `exists(select 1 from inventory_ledger where correctsEventId = eventId)` — a correction of a correction targets the *new* corrected event's id, not the original, so this guard can never be worked around by re-submitting the same `eventId`.
2. Compute final `qty`/`unitCost`: `corrections.qty ?? original.qty`, `corrections.unitCost ?? original.unitCost`. At least one of `corrections.qty`/`corrections.unitCost` must differ from the original's value, or throw `correction changes nothing — refusing to write a no-op correction pair`.
3. Write the reversal: `recordLedgerEvent({ skuId: original.skuId, warehouseId: original.warehouseId, eventType: "adjustment", qty: -original.qty, unitCost: original.unitCost, date: new Date(), sourceRef: original.sourceRef, correctsEventId: eventId, changedBy: opts.changedBy, reasonCategory: "data_correction", reasonNote: opts.reasonNote }, tx)`. This goes through `recordLedgerEvent`'s existing negative-stock guard unless `opts.allowNegativeSoh` is true, in which case the guard is bypassed for this one call only (see §4.1).
4. Write the replacement: same shape, `eventType: "receipt"`, `qty: finalQty`, `unitCost: finalUnitCost`, same `sourceRef`, same `correctsEventId: eventId`, same `changedBy`/`reasonCategory`/`reasonNote`.
5. Compute `consumedFromOtherBatches`: `replayLedgerEventsFifo`'s internal `consume()` closure needs to report which batch(es) — identified by `sourceRef` — it actually drew from, not just the consumed cost total. Extend `consume()`'s return type to include the set of touched `sourceRef`s (a small, additive change; existing callers that only use the returned cost number are unaffected). After step 3's write, `correctLedgerReceipt` re-derives whether any touched batch had a different `sourceRef` than `original.sourceRef`.

### 4.1 `allowNegativeSoh`

The reversal in step 3 removes `original.qty` units from recorded stock. If more has already been sold against the wrong (too-high) quantity than physically exists once the correction is applied, `recordLedgerEvent`'s guard throws `would drive SOH negative` — correctly, since there is no real stock to reverse. This is not a bug to work around silently: it means the correction alone cannot resolve the situation (the erroneous sales themselves may need their own handling first, a scenario explicitly out of this design's scope). `allowNegativeSoh: true` is the deliberate escape hatch for an operator who has reviewed this and decided to proceed anyway — scoped to this one correction call, not a global toggle (unlike the existing instance-wide `allow_backorders` app setting, which would be the wrong tool here: flipping it just to perform one correction would silently permit backorders everywhere else too).

### 4.2 Concurrency

Two concurrent corrections targeting the same `eventId` could both pass step 1's "already corrected" check before either commits (the same class of TOCTOU race `recordLedgerEvent`'s own negative-stock guard already has and has accepted, documented in that function's comments: "a single-operator system with no concurrent-write path in practice today... revisit if a second writer is ever introduced"). This design applies the identical, already-established risk acceptance rather than introducing new locking machinery — consistent with the rest of this codebase, not a new gap.

## 5. Shipment-level wrappers

`server/shipments.ts`:

```ts
export async function correctShipmentReceiptQty(
  shipmentId: number,
  lineItemId: number,
  newQty: number,
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<LedgerCorrectionResult>
```

Takes `lineItemId` (a `shipment_line_items.id`, always known by the caller — it's exactly what the UI's line-item picker in §7 selects, and what the shipment's own line-item list already returns), not a bare `skuId` — this is the fix described in §3. Finds the receipt: `eventType = "receipt"`, `sourceRef = shipment.shipmentRef`, `lineItemId = lineItemId`, not already corrected (`correctsEventId IS NULL` on candidate rows AND no other row's `correctsEventId` points at a candidate). If no row carries this `lineItemId` (i.e. the receipt predates this design and only has `skuId` recorded), fall back to matching on `skuId` (looked up from `shipment_line_items.skuId` for this `lineItemId`) — and if that fallback still finds more than one candidate (the exact pre-existing ambiguity §3 describes, on old data only), throw `ambiguous: N uncorrected receipts found for shipment ${shipmentId}, and this shipment predates per-line-item ledger tracking — cannot disambiguate which one is line item ${lineItemId}`. Throws `no uncorrected receipt found for shipment ${shipmentId} / line item ${lineItemId}` if zero match either way. Calls `correctLedgerReceipt(event.id, { qty: newQty }, opts, tx)` inside its own transaction.

```ts
export async function correctShipmentLandedCost(
  shipmentId: number,
  costs: { freightCost?: string; dutyCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<{ corrections: LedgerCorrectionResult[] }>
```

One transaction:

1. Read the shipment. Update `freightCost`/`dutyCost` (only the fields passed). Call `logChange` for each changed field (`entityType: "shipment"`, `reasonCategory: "data_correction"`) — the same field-level audit pattern `recordShipmentCosts` already uses.
2. Recompute `getShipmentLandedUnitCost(shipmentId, tx)` with the new costs — this already returns `lineItemId` per result (see §3's note — this function has returned `{ lineItemId, skuId, landedUnitCost }[]` since Stream G).
3. For every line item, find its `receipt` event by `lineItemId` the same way `correctShipmentReceiptQty` does (falling back to `skuId` for pre-this-design rows), and call `correctLedgerReceipt(event.id, { unitCost: newLandedCost }, opts, tx)`.
4. If any line's correction throws (ambiguous, already-corrected, negative-SOH), the whole transaction rolls back — an all-or-nothing correction, never a partially-corrected shipment.

## 6. Payment-level wrapper

`server/payments.ts`:

```ts
export async function correctPaymentAmount(
  id: number,
  opts: { amount: string; fxRate: string; paidDate: Date; changedBy: number; reasonNote: string },
): Promise<Payment>
```

Throws `payment ${id} is not yet paid — use markPaymentPaid to record the first payment, correctPaymentAmount only corrects an already-recorded one` if `payment.paid !== true` — the same "only corrects an existing value" precondition `correctShipmentActualDepartDate` already establishes as this codebase's convention for a correction function. Otherwise calls `markPaymentPaidCore(id, { ...opts, reasonCategory: "data_correction" }, tx)` — the exact same underlying write `markPaymentPaid` already performs (it already supports being re-called and overwriting `paidAmount`/`paidDate`/`fxRate`/`baseCurrencyAmount`, with `change_log` audit on every field); this wrapper's only real job is to make that an explicit, named, precondition-checked entry point instead of an accidental side effect of calling the wrong function twice.

## 7. Minimal UI

One new control per page, following the established pattern (`CustomsArrivalControl`, `AdvanceStatusControl`, `StatusTransitionControl`):

- `ShipmentsPage.tsx` → `CorrectReceiptControl`, visible only on a `status === "delivered"` row. A small form: pick a line item from the shipment's own line-item list (already fetched for display — the picker shows SKU name via the existing `labels.ts` resolver, but submits the line item's real `id`, not its `skuId`, per §5), enter a new qty and/or new landed cost (via freight/duty), a required `reasonNote` free-text field. No `reasonCategory` dropdown — every correction is `"data_correction"` by construction, so offering a choice would be a false choice. Submits to `shipments.correctReceiptQty` or `shipments.correctLandedCost` depending on which field(s) changed. On success, if the response's `consumedFromOtherBatches` (or, for the landed-cost path, any entry in `corrections[]`) is true, show a toast: "This correction drew from a different batch than the one being corrected, because the original batch was already partly or fully sold — past Daily COGS is not recalculated."
- `TransactionsPage.tsx` (wherever the existing `PaymentHistory`/payment-list view lives) → `CorrectPaymentControl`, visible only on a `paid === true` row: amount, fxRate, paidDate, required `reasonNote`. Submits to `payments.correctAmount`.

**Copy convention** (Product/Jobs-lens finding): correction UI language stays neutral, not blame-laden — "Correct receipt quantity" / "Cost restated," never "Fix error" or "Report mistake." The `reasonNote` field's placeholder text should invite a factual explanation ("What changed and why"), not an apology.

New tRPC procedures (`server/routers.ts`): `shipments.correctReceiptQty`, `shipments.correctLandedCost`, `payments.correctAmount` — thin wrappers over the server functions above, following the existing auth/session pattern every other mutation procedure in this router already uses.

## 8. Testing

Real-DB tests (this codebase's established convention — no mocking of `db`):

1. `correctLedgerReceipt`: happy path (qty-only, cost-only, both); the double-correction guard; the not-a-receipt guard; the ambiguous-candidate case is N/A here (this function takes a resolved `eventId`, ambiguity is the wrapper's concern); `allowNegativeSoh` both set and unset against a scenario engineered to need it; `consumedFromOtherBatches` explicitly proven true in a scenario where the original batch is fully sold before the correction runs, and false in the ordinary case.
2. `correctShipmentReceiptQty` / `correctShipmentLandedCost`: the `lineItemId`-based happy path; the `skuId`-fallback path for a receipt seeded without `lineItemId` (simulating pre-this-design data); zero-candidates and multiple-candidates error paths, including the specific two-line-items-same-SKU scenario §3 describes, proven to resolve correctly via `lineItemId` and to correctly throw ambiguous only when forced onto the legacy `skuId` fallback; a real `getShipmentLandedUnitCost` recompute correctness check (not a stub); atomicity — force one line's correction to fail and assert the whole shipment's other lines are unchanged.
3. `correctPaymentAmount`: the `paid !== true` guard; `change_log` rows match the existing `markPaymentPaidCore` test's shape/pattern.
4. Regression: the full existing `getRemainingBatches`/`getDailyCogsForRange`/`replayLedgerEventsFifo` test suite must pass unchanged — this design adds no new branches to that function beyond the `consume()` return-shape extension in §4 step 5, which must not alter any existing caller's behavior (verified by keeping every existing call site's ignored second return value ignored, so nothing breaks by omission).

## Global Constraints

- `markShipmentArrived` (`server/shipments.ts`) must populate the new `lineItemId` column on every `receipt` event it writes going forward (`line.id` is already in scope at that call site — see §3) — this is not optional, since §5's correction wrappers depend on it to disambiguate same-SKU line items correctly.
- Forward-only: no correction may rewrite or delete an existing `inventory_ledger` row, and no correction may alter previously-computed Daily COGS for a past day.
- Every correction writes through `recordLedgerEvent` (never a raw insert bypassing its negative-stock guard) except where `allowNegativeSoh` is explicitly passed for that one call.
- `reasonCategory` for every correction is always `"data_correction"`, set internally — never a user-supplied choice among the other 9 categories.
- `reasonNote` is required (not optional) on every correction entry point, unlike most existing `reasonNote` fields in this codebase which are optional-except-when-category-is-"other".
- No changes to `LEDGER_EVENT_TYPES` or to `replayLedgerEventsFifo`'s core consumption branches (`receipt`/`sale`/`adjustment` handling) — only an additive extension to what `consume()` returns.
- All-or-nothing per shipment: `correctShipmentLandedCost` touching N line items either corrects all N or none.
