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

`markShipmentDeparted` is updated to check this table (it already exists and hard-sets `status: "departed"` with no check today). A new `updateShipmentStatus(id, newStatus, opts)` function (deliberately unexposed by any router in this stream — see Non-Goals) provides the general transition path the migration script uses to reconstruct a shipment's real historical status from Sheet data without the ability to produce an invalid sequence.

### 3. Migration scope widening

One transform function per entity, each independently testable with synthetic fixtures — not one large function:

- `transformPurchaseOrders(rows)` → `{ purchaseOrders: [...], poLineItems: [...] }`, including the new `vendorReference` field.
- `transformShipments(rows)` → `{ shipments: [...], shipmentLineItems: [...] }`, including `vendorReference`, `freightCost`/`dutyCost`/`costCurrency`.
- `transformPayments(rows)` → `{ payments: [...] }`.
- `transformTransactions(rows)` → `{ transactions: [...] }` — **migrated as unmatched** (`matchedPaymentId: null`) regardless of what the source Sheet implies about matching. Jello has twice explicitly rejected automated per-row payment-transaction matching as unnecessary complexity; re-deriving matches from historical Sheet data would be exactly that. Real matching happens manually after migration, through the matching UI already built in Task 16b.

`runMigration` orchestrates all transforms and inserts in the FK-respecting order from Design §1.

`reconcileMigration` gains a second check type alongside the existing SOH comparison: per-SKU/shipment landed-cost totals (Sheet-reported vs. `getShipmentLandedUnitCost`'s computed figure), reported as its own category of mismatch so the two failure modes (stock accounting vs. cost accounting) are distinguishable in the report.

### 4. Vendor reference fields

`purchase_orders.vendor_reference` and `shipments.vendor_reference` — both nullable `varchar`, no uniqueness constraint (different vendors use their own numbering, and a real invoice number isn't guaranteed unique across vendors or even guaranteed to exist for every historical record). Accommerce's own `po_number`/`shipment_ref` remain the sole unique identifiers. The new migration transform functions populate this from whatever column the real Sheet export uses for the vendor's own invoice/reference number.

### 5. Negative-stock validation

`recordLedgerEvent` (and by extension `recordSalesActual`, which calls it) throws if a `sale`/`adjustment` event would drive a SKU/warehouse's running SOH below zero — computed via the existing `getSoh` aggregation before the write commits. Matches the spec's explicit requirement and this platform's established fail-loud pattern (e.g. `computeFifoCogs`'s "insufficient stock" throw, `getShipmentLandedUnitCost`'s qty guard).

### 6. SKU identifier uniqueness

Unique constraint on `skus(primary_identifier_type, identifier_value)` — deferred during V1 specifically until "before real end-user SKU data entry begins," which this migration work now triggers (`runMigration` auto-creates SKUs from Sheet rows).

### 7. CLI entrypoints

`scripts/run-migration.mjs` and `scripts/run-parallel-check.mjs`, following the exact pattern already established by `scripts/run-nightly-export.mjs` (tsx-executable, calls the library function, `process.exit(0)`/`process.exit(1)` on success/failure).

## Testing

Every new transform function gets unit tests with synthetic fixtures (no real Sheet access available), following the existing `transformSheetExport`/`reconcileMigration` test pattern. The FK additions are verified by tests asserting a rejected insert (e.g. `recordLedgerEvent` with a nonexistent `sku_id` now throws instead of silently succeeding) — real regression tests against a real local database, not mocks, per this platform's existing convention. The shipment state machine gets the same test shape as the existing PO transition tests (a rejected invalid transition, an accepted valid one).

## Open Questions

- Real Control Tower Sheet column names for PO/Shipment/Payment/Transaction tabs are unknown in this environment — the transform functions' field names are reasonable placeholders (matching the existing ledger transform's approach) that will need adjustment against the real export before an actual migration run.
