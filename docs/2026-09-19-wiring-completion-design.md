# Wiring Completion (Backlog Stream A) — Design

## Context & Motivation

V1's final whole-branch review found seven pieces of backend logic that are already built and tested but structurally unreachable — no router procedure or UI action exposes them. Backlog Stream A groups these into one bundled task rather than nine separate features, per the original review's own recommendation.

A code survey done before this design confirmed the actual gap is bigger than pure wiring for four of the seven items: `customsStatus`/`actualArrivalDate` have schema columns but no write function at all, `listPaymentsForPo` doesn't exist yet, `sales_plan` has no insert path, and (caught during this spec's own refinement pass, not the original survey) the transaction-matching UI needs a way to list open payments to match against, which also doesn't exist yet. The other three (shipment progression via the existing `updateShipmentStatus`, `payments.history` via the existing generic `listChangeLog`, `listShipmentsForPo`) are genuine pure-wiring — the function exists, only the router/UI layer is missing. `matchTransactionToPayment` itself is also pure wiring (the mutation already has a router procedure); only its supporting "list what's open" read path was missing.

This stream also carries one item surfaced during Backlog Stream B (migration & cutover readiness): `markShipmentDeparted`'s new transition-table check permanently removed the only way ops had to correct a wrongly-entered actual depart date, with no replacement built. Whoever wires up shipment progression needs to build that correction path alongside forward progression.

## Goals

- Insert path for `sales_plan` rows, so `getPlanActualDeviation` can return real data.
- Shipment progression past `departed` (customs → delivered) via the router, using the existing `updateShipmentStatus` from Stream B.
- New `setShipmentCustomsStatus` and `markShipmentArrived` functions (the schema columns exist; no code touches them yet).
- New `correctShipmentActualDepartDate` function — a dedicated correction path, separate from forward progression, closing the Stream-B-surfaced regression.
- `payments.history` router procedure reading back `change_log` rows for a payment.
- New `listPaymentsForPo` function + router procedure, so the Purchase Orders page's payments list survives a reload.
- `getSalesVolatility`/`getPlanActualDeviation` surfaced on the Stock page.
- `listShipmentsForPo` surfaced on the Purchase Orders page.
- New `listUnpaidPayments` function + router procedure, and `matchTransactionToPayment` (mutation already exists) wired to a real UI action on the Money page's Cashflow tab.

## Non-Goals

- Any new backend computation beyond what's listed above — this stream is wiring plus the four small write functions and two small read functions the survey and its own refinement pass found missing, not new features.
- Redesigning any existing page's layout beyond the additions named here.
- Changing `markShipmentDeparted`'s existing transition-table behavior (Stream B's shipment state machine) — the correction path is additive, not a loosening of that check.
- A payment-matching UI beyond a simple list + pick-a-payment action (no bulk matching, no fuzzy/automatic suggestion — Jello has twice rejected automated payment-matching, per Stream B's design notes).

## Design

### 1. Sales plan entry (new)

`createSalesPlanEntry(input: { skuId, warehouseId, periodDate, plannedQty, createdBy }): Promise<SalesPlanRow>` in `server/salesPlan.ts` — a plain insert into `sales_plan`, no audit trail needed (this is a forecast being created, not a change to an existing record — matches how `createExpectedPayment`/`createPurchaseOrder` have no audit trail for creation itself, only for later changes).

Router: `salesPlan.create` (editor-only, matches every other create procedure).

UI: new "Sales Plan" section on `StockPage.tsx` — a small form (SKU dropdown, warehouse dropdown, date, planned qty) that calls `salesPlan.create`, plus a table below it showing `getPlanActualDeviation`'s output for the selected SKU/warehouse and `getSalesVolatility`'s output as a single number next to it. This reuses the existing SKU/warehouse selection pattern already on this page (the days-of-cover table).

### 2. Shipment progression past `departed`

**Correction from convention check against the codebase, not just this stream's own code:** `updatePurchaseOrderStatus` (the existing PO equivalent) already accepts an *optional* `reasonCategory`/`reasonNote`, but Stream B's `updateShipmentStatus` was built without one at all — a Minor inconsistency flagged during Stream B's own review but left unfixed there since it wasn't exposed anywhere yet. Now that this stream exposes it to real users for the first time, closing that gap here is cheap and keeps the two entities' conventions aligned: extend `updateShipmentStatus`'s `opts` with the same optional `reasonCategory?: ReasonCategory`/`reasonNote?: string` PO already has, passed through to `logChange` when present. This does not touch `VALID_SHIPMENT_TRANSITIONS` or any transition logic — purely enriches the existing audit call.

Router: `shipments.updateStatus` calling `updateShipmentStatus(id, newStatus, { changedBy, reasonCategory?, reasonNote? })` — editor-only, `reasonCategory`/`reasonNote` optional, mirroring `purchaseOrders.updateStatus`'s existing input shape exactly.

UI: `ShipmentsPage.tsx` — the existing per-shipment row gains a status-transition control (a button per valid next status, driven by `VALID_SHIPMENT_TRANSITIONS` — data-over-branching, not a hardcoded dropdown of all statuses) that calls `shipments.updateStatus`, with the same optional reason-category/note inputs already used elsewhere on this page.

### 3. Customs status + actual arrival date (new)

`setShipmentCustomsStatus(id, newStatus, opts: { changedBy, reasonCategory, reasonNote? })` and `markShipmentArrived(id, actualArrivalDate, opts: { changedBy, reasonCategory, reasonNote? })` in `server/shipments.ts` — both audited via `logChange` (customs holds and arrival timing directly affect delay, matching the spec's existing "every field-level change to a Shipment that affects delay or cost" rule). `setShipmentCustomsStatus` validates the new value is one of `CUSTOMS_STATUSES` (data-over-branching: no transition table needed here per the spec — customs status isn't a strict progression the way shipment status is, a shipment can bounce between `declared`/`held` during a real customs hold).

Routers: `shipments.setCustomsStatus`, `shipments.markArrived` — both editor-only, both requiring `reasonCategory` in the input (mirroring the existing `recordShipmentCosts` procedure's shape).

UI: `ShipmentsPage.tsx` — extends the existing reason-category-driven edit pattern already used for cost fields on this page, adding a customs-status dropdown and an arrival-date field, each with the existing reason-category/note inputs.

### 4. Actual depart date correction (new)

`correctShipmentActualDepartDate(id, newDate, opts: { changedBy, reasonCategory, reasonNote? })` in `server/shipments.ts` — updates `actualDepartDate` directly via `db.update`, bypassing `VALID_SHIPMENT_TRANSITIONS` entirely (this is fixing a data-entry mistake, not a status progression — the shipment's `status` field is untouched by this function). Audited via `logChange` with a required `reasonCategory`, matching every other delay-affecting field change in this codebase.

**Logic check, caught before implementation:** because this function bypasses the transition table by design, it must not become a backdoor for *setting* the first actual depart date (which should always go through the transition-validated `markShipmentDeparted`/`updateShipmentStatus` path, per Stream B's whole point in building that check). `correctShipmentActualDepartDate` must throw if the shipment's current `actualDepartDate` is `null` — "correcting" a value that was never set isn't a correction, it's an unvalidated first-time set, and allowing it would quietly defeat the state machine.

Router: `shipments.correctActualDepartDate` — editor-only, `reasonCategory` required in the input.

UI: `ShipmentsPage.tsx` — a small "correct" action next to the existing actual-depart-date display, using the same reason-category/note inputs as the customs-status/arrival-date additions above.

### 5. Payments history (pure wiring)

Router: `payments.history` — calls the existing generic `listChangeLog("payment", paymentId)` from `server/changeLog.ts`. No new backend function needed.

UI: `PurchaseOrdersPage.tsx` (where the existing payments UI lives, per V1's Task 16b) — each payment row gets a "history" expand/link, rendering the same change-log-row format already used elsewhere (e.g. `ChangeLogPage.tsx`'s row shape) rather than inventing a new display format.

### 6. Payments re-listing (new)

`listPaymentsForPo(poId): Promise<Payment[]>` in `server/payments.ts` — a plain `select` filtered by `poId`, mirroring `listShipmentsForPo`'s existing shape.

Router: `payments.listForPo`.

UI: `PurchaseOrdersPage.tsx` — on load/expand of a PO, call `payments.listForPo` instead of relying on the current session-local React state, so a page reload doesn't lose visibility into payments that already exist in the database.

### 7. Shipments-per-PO (pure wiring)

Router: `shipments.listForPo` — calls the existing `listShipmentsForPo(poLineItemIds)`. No new backend function needed.

UI: `PurchaseOrdersPage.tsx` — each PO's expanded view gets a "Shipments" sub-list showing which shipments carry a share of that PO's line items, using `poLineItemIds` already available from the PO's own line items in that view.

### 8. Transaction matching UI

**Correction from a check made before finalizing this spec, not after:** matching itself is pure wiring (`payments.matchTransaction` **already exists**, `server/routers.ts:131-133`, calling `matchTransactionToPayment`). But the UI's "pick a payment" dropdown needs a list of *open* (unpaid) payments to choose from, and no such function exists — `grep` across `server/payments.ts` found only `listUnmatchedTransactions`, nothing symmetric for payments. This item is not pure wiring; it needs one more small new function, same class as `listPaymentsForPo` in Section 6.

`listUnpaidPayments(): Promise<Payment[]>` in `server/payments.ts` — a plain `select` filtered by `paid = false`, mirroring `listUnmatchedTransactions`'s existing shape and naming convention.

Router: `payments.listUnpaid` (new) + `payments.matchTransaction` (already exists, no change needed).

UI: `MoneyPage.tsx`'s Cashflow tab — replace the current unmatched-transaction *count* with an actual list (from the existing `listUnmatchedTransactions`), each row getting a "match to payment" action: a dropdown populated from `payments.listUnpaid`, calling `payments.matchTransaction`. No fuzzy matching or auto-suggestion — a plain manual pick, per the spec's explicit rejection of automated matching.

## Testing

Every new function (`createSalesPlanEntry`, `setShipmentCustomsStatus`, `markShipmentArrived`, `correctShipmentActualDepartDate`, `listPaymentsForPo`, `listUnpaidPayments`) gets real-DB TDD tests, matching this codebase's existing convention (no mocks). The three audited functions (`setShipmentCustomsStatus`, `markShipmentArrived`, `correctShipmentActualDepartDate`) each need a test confirming the `change_log` row is written with the right `reasonCategory` and the correct prior value — the exact class of bug (wrong/missing prior value, missing audit entirely) that V1's own build caught twice in different functions (Tasks 6 and 7). `correctShipmentActualDepartDate` additionally needs a test proving it throws when `actualDepartDate` is currently `null`, per the logic check in Section 4. Router procedures get the same `editorProcedure`/`protectedProcedure` treatment as every existing procedure — no new access-control pattern; new `reasonCategory` inputs reuse the existing shared `reasonCategorySchema` (`z.enum(REASON_CATEGORIES)`), not a fresh `z.string()`. Every new write function threads an optional `dbClient: DbClient = db` parameter, matching the convention Stream B established for every write function in this codebase — not because anything calls these inside a transaction yet, but because a function built without that thread-through point has to be retrofitted later exactly the way Stream B had to retrofit nine existing functions to make `runMigration`'s atomicity real. UI changes are verified live in a browser per this codebase's established practice for frontend tasks (start dev server, exercise the actual flow), not just type-checked.

## Open Questions

None. The self-refinement pass caught two real gaps the original survey missed (Section 8 needing a new `listUnpaidPayments` function; Section 2's `updateShipmentStatus` missing the `reasonCategory` PO's equivalent already has) and one logic gap in the correction path's design (Section 4's null-guard) — all closed above, not left as follow-up items.
