# Migration & Cutover Readiness (Backlog Stream B) — Design

## Context & Motivation

V1's final whole-branch review (see [`BUILD-HISTORY.md`](./BUILD-HISTORY.md)) found that the system, while internally correct and tested, isn't yet safe to run a real migration against: the migration script only covers `inventory_ledger` (not PO/Shipment/Payment/Transaction as the platform spec requires), there is zero referential integrity anywhere in the schema, no negative-stock validation despite the spec naming it explicitly, and Shipments have no status state machine (unlike Purchase Orders). These are tracked as Stream B in [`BACKLOG.md`](./BACKLOG.md).

**This is preparatory hardening of the code, not a real data migration.** No real Accommerce/Jello data is touched by this work. The actual migration against the live Control Tower Sheet remains a separate, later, explicitly-gated decision — this stream exists to make that eventual migration trustworthy when it happens.

## Goals

- Extend `scripts/migrate-from-sheet.ts` to cover Purchase Orders, Shipments, Payments, and Transactions — not just the inventory ledger — matching the platform spec's Migration Plan.
- Extend `reconcileMigration` to check landed-cost totals per SKU/shipment, not just SOH.
- Make the core ownership relationships in the schema impossible to violate by construction (real foreign keys), consistent with this platform's existing "structurally prevents X" design philosophy (e.g. `warehouse_id` non-nullable to prevent channel blending).
- Add a `VALID_TRANSITIONS`-style state machine for Shipment status, mirroring the existing Purchase Order pattern.
- Add negative-stock validation, per the spec's explicit requirement.
- Add a unique constraint on `skus(primary_identifier_type, identifier_value)` before any real SKU auto-creation from Sheet data can happen.
- Add real CLI entrypoints for `runMigration` and `generateParallelRunReport` — both are library functions today, callable only from a REPL.
- Add a vendor/forwarder reference number field to Purchase Orders and Shipments, separate from Accommerce's own internal PO/shipment numbering — real vendor invoices carry their own numbering that doesn't match the internal scheme, and reconciling against real invoices needs both.

## Non-Goals

- Running an actual migration against real Control Tower data.
- Shipment status **progression via the app itself** (a router procedure + UI to actually move a shipment through customs/delivered) — that's Backlog Stream A ("wiring completion"), a product-facing concern. This stream only builds the validation logic the migration script uses internally to avoid creating invalid shipment states; it does not expose a way to change shipment status through the API beyond what already exists (`updateShipmentPlannedDepartDate`, `markShipmentDeparted`).
- Security hardening (Stream C), performance (Stream D), the Shopify-pull idempotency/timezone/currency-enforcement fixes (Stream E), or cleanup items (Stream F).
- A fully faithful reconstruction of Control Tower's real 13-tab structure. The real Sheet export's exact column names are not available in this environment (no Google Sheets API access) — the new transform functions use reasonable, explicit field names following the same pattern `transformSheetExport`'s ledger transform already established, and will need column-name adjustment against the real export when a migration is actually run. This is the same caveat V1's migration script shipped with.

## Design

### 1. Referential integrity — hybrid (DB-level FKs + one targeted app check)

Real foreign keys on the core ownership edges, added to `drizzle/schema.ts` via Drizzle's `.references()`:

- `po_line_items.po_id → purchase_orders.id`
- `po_line_items.sku_id → skus.id`
- `shipment_line_items.shipment_id → shipments.id`
- `shipment_line_items.po_line_item_id → po_line_items.id`
- `shipment_line_items.sku_id → skus.id`
- `payments.po_id → purchase_orders.id` (nullable)
- `payments.shipment_id → shipments.id` (nullable)
- `transactions.matched_payment_id → payments.id` (nullable)
- `inventory_ledger.sku_id → skus.id`
- `inventory_ledger.warehouse_id → warehouses.id`

This is the concrete fix for the review's flagged case: `recordLedgerEvent` currently accepts a nonexistent `sku_id`/`warehouse_id`, undermining the ledger-as-source-of-truth invariant, and such orphaned rows would slip past migration reconciliation silently. With a real FK, the database itself rejects the write.

`matchTransactionToPayment` additionally gets an application-level check: an FK proves the target payment *exists*, but not that the transaction isn't *already* matched to a different payment, or that the payment isn't already matched by someone else. That's a business-state check, not a referential-integrity one, and stays in code — following this platform's convention of clear, fail-loud error messages rather than relying on a generic DB constraint violation to communicate the problem.

No FKs on `created_by`/`changed_by` (referencing `users.id`) — `change_log` deliberately has no FK there today for audit-durability reasons (a deleted user shouldn't orphan their history), and that reasoning extends here.

**Migration ordering consequence:** `runMigration` must insert in FK-respecting order: vendors → skus/warehouses → purchase_orders → po_line_items → shipments → shipment_line_items → payments → transactions → inventory_ledger.

### 2. Shipment state machine

Mirrors `purchase_orders`'s `VALID_TRANSITIONS` pattern exactly — a lookup table, not branching logic (per this platform's "data over branching" principle):

```typescript
const VALID_SHIPMENT_TRANSITIONS: Record<(typeof SHIPMENT_STATUSES)[number], (typeof SHIPMENT_STATUSES)[number][]> = {
  planned: ["departed"],
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};
```

`markShipmentDeparted` is updated to check this table (it already exists and hard-sets `status: "departed"` with no check today). A new `updateShipmentStatus(id, newStatus, opts)` function (deliberately unexposed by any router in this stream — see Non-Goals) provides the general transition path for future live use, once Stream A wires up a real way to progress a shipment through the app.

**Correction from an internal logic check:** the migration script does **not** use this transition-validated function to reconstruct history. Control Tower's Sheet only ever recorded a shipment's *current* status as a snapshot, never a change-by-change history of how it got there (the same reason `change_log` didn't exist as a concept in Sheets). There is no real sequence of transitions to replay, so simulating one would mean inventing transition dates that were never actually recorded. The migration instead inserts each shipment directly with its real final known status (a raw insert establishing a historical fact, not a live transition), and the transition-validated function governs only what happens *after* the system is live.

### 3. Migration scope widening

One transform function per entity, each independently testable with synthetic fixtures — not one large function:

- `transformPurchaseOrders(rows)` → `{ purchaseOrders: [...], poLineItems: [...] }`, including the new `vendorReference` field.
- `transformShipments(rows)` → `{ shipments: [...], shipmentLineItems: [...] }`, including `vendorReference`, `freightCost`/`dutyCost`/`costCurrency`.
- `transformPayments(rows)` → `{ payments: [...] }`.
- `transformTransactions(rows)` → `{ transactions: [...] }` — **migrated as unmatched** (`matchedPaymentId: null`) regardless of what the source Sheet implies about matching. Jello has twice explicitly rejected automated per-row payment-transaction matching as unnecessary complexity; re-deriving matches from historical Sheet data would be exactly that. Real matching happens manually after migration, through the matching UI already built in Task 16b.

`runMigration` orchestrates all transforms and inserts in the FK-respecting order from Design §1, **wrapped in a single database transaction** (`db.transaction(async (tx) => {...})`). A migration is meaningless half-done — if row 5,000 of 10,000 fails a check, the whole attempt rolls back cleanly rather than leaving the database in a partially-migrated state that's unclear to reconcile against. This also makes re-running after fixing a data problem safe: there's never a lingering partial import to clean up first.

**Malformed-row handling (quarantine, not abort):** each transform function collects rows it cannot parse (missing required fields, an unparseable date, an `event_type` outside the known enum) into a `skippedRows` list with a reason, instead of throwing on the first bad row. `runMigration` prints a clear summary at the end — rows imported, rows quarantined with reasons — so the operator can fix source data incrementally across multiple runs rather than facing one all-or-nothing failure on a large historical export. This mirrors `runDailyShopifyPull`'s existing skip-and-continue behavior for unknown SKUs/warehouses, applied consistently here.

`reconcileMigration` gains a second check type alongside the existing SOH comparison: per-SKU/shipment landed-cost totals (Sheet-reported vs. `getShipmentLandedUnitCost`'s computed figure). **This comparison uses a small tolerance — the greater of $0.01 or 0.1% of the compared total — not an exact match** — unlike SOH, which is a hard integer count that must match exactly, landed cost is a computed figure subject to real, already-known historical rounding/estimation artifacts in how pooled-container costs were split by weight/value share in the original Sheet-based process. Treating it as pass/fail-on-any-cent-difference would produce false failures on legitimately-close-enough historical data. The two failure modes (stock-count mismatch vs. cost mismatch beyond tolerance) are reported as distinguishable mismatch categories.

**Negative-stock validation stays active during migration.** It would be tempting to bypass Design §5's new negative-stock guard while importing historical data, since real historical Jello data is known to have had reconciliation gaps. Deliberately not doing that: a historical point where recorded sales would drive stock negative indicates either a real data error in the source or a genuine untracked adjustment (a return, a write-off) — exactly the kind of problem this platform's "fail loudly, never silently" principle exists to surface, not paper over during a one-time import. If real historical data trips this guard, that's the quarantine mechanism's job to report clearly so the underlying gap gets investigated, not a reason to weaken the guard.

**Adding real FKs requires a clean local dev database.** The existing local dev/test database has known cross-test residue (documented in `BUILD-HISTORY.md`/the test suite's own `beforeEach` truncation pattern) that may already violate the new constraints. Since this is disposable local dev data, not production, the straightforward fix is a full local reset (drop and recreate via `pnpm db:push` against an empty schema) rather than trying to migrate the existing messy dev state forward — call this out explicitly as a one-time step in the implementation plan, not something to work around in code.

### 4. Vendor reference fields

`purchase_orders.vendor_reference` and `shipments.vendor_reference` — both nullable `varchar`, no uniqueness constraint (different vendors use their own numbering, and a real invoice number isn't guaranteed unique across vendors or even guaranteed to exist for every historical record). Accommerce's own `po_number`/`shipment_ref` remain the sole unique identifiers. The new migration transform functions populate this from whatever column the real Sheet export uses for the vendor's own invoice/reference number.

**Scope confirmed as PO- and Shipment-level only, not `payments`** — even though a real vendor invoice often corresponds to one specific payment tranche rather than the whole PO. Adding it to `payments` now without a concrete driving need would be exactly the kind of premature schema growth this platform's YAGNI discipline has consistently avoided elsewhere — if per-tranche invoice tracing turns out to matter once real migration is attempted, it's a cheap, additive follow-up then, not a blocker to design in now.

### 5. Negative-stock validation

`recordLedgerEvent` (and by extension `recordSalesActual`, which calls it) throws if a `sale`/`adjustment` event would drive a SKU/warehouse's running SOH below zero — computed via the existing `getSoh` aggregation before the write commits. Matches the spec's explicit requirement and this platform's established fail-loud pattern (e.g. `computeFifoCogs`'s "insufficient stock" throw, `getShipmentLandedUnitCost`'s qty guard).

### 6. SKU identifier uniqueness

Unique constraint on `skus(primary_identifier_type, identifier_value)` — deferred during V1 specifically until "before real end-user SKU data entry begins," which this migration work now triggers (`runMigration` auto-creates SKUs from Sheet rows).

### 7. CLI entrypoints

`scripts/run-migration.mjs` and `scripts/run-parallel-check.mjs`, following the exact pattern already established by `scripts/run-nightly-export.mjs` (tsx-executable, calls the library function, `process.exit(0)`/`process.exit(1)` on success/failure).

## Testing

Every new transform function gets unit tests with synthetic fixtures (no real Sheet access available), following the existing `transformSheetExport`/`reconcileMigration` test pattern, including at least one fixture row per function that's deliberately malformed to prove the quarantine path (skipped with a reason, not thrown). The FK additions are verified by tests asserting a rejected insert (e.g. `recordLedgerEvent` with a nonexistent `sku_id` now throws instead of silently succeeding) — real regression tests against a real local database, not mocks, per this platform's existing convention. The shipment state machine gets the same test shape as the existing PO transition tests (a rejected invalid transition, an accepted valid one), plus a test confirming migration's direct-insert path does *not* go through transition validation. `runMigration`'s transaction wrapping is verified with a test that fails partway through a multi-row import and asserts nothing committed (a real rollback, not a mock). The landed-cost tolerance gets tests on both sides of the boundary (just inside tolerance passes, just outside fails).

## Open Questions

- Real Control Tower Sheet column names for PO/Shipment/Payment/Transaction tabs are unknown in this environment — the transform functions' field names are reasonable placeholders (matching the existing ledger transform's approach) that will need adjustment against the real export before an actual migration run.
