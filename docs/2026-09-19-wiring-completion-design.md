# Wiring Completion (Backlog Stream A) — Design

## Context & Motivation

V1's final whole-branch review found seven pieces of backend logic that are already built and tested but structurally unreachable — no router procedure or UI action exposes them. Backlog Stream A groups these into one bundled task rather than nine separate features, per the original review's own recommendation.

A code survey done before this design confirmed the actual gap is bigger than pure wiring for three of the seven items: `customsStatus`/`actualArrivalDate` have schema columns but no write function at all, `listPaymentsForPo` doesn't exist yet, and `sales_plan` has no insert path. The other four (shipment progression via the existing `updateShipmentStatus`, `payments.history` via the existing generic `listChangeLog`, `listShipmentsForPo`, `matchTransactionToPayment`) are genuine pure-wiring — the function exists, only the router/UI layer is missing.

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
- `matchTransactionToPayment` (procedure already exists) wired to a real UI action on the Money page's Cashflow tab.

## Non-Goals

- Any new backend computation beyond what's listed above — this stream is wiring plus the three small write functions the survey found missing, not new features.
- Redesigning any existing page's layout beyond the additions named here.
- Changing `markShipmentDeparted`'s existing transition-table behavior (Stream B's shipment state machine) — the correction path is additive, not a loosening of that check.
- A payment-matching UI beyond a simple list + pick-a-payment action (no bulk matching, no fuzzy/automatic suggestion — Jello has twice rejected automated payment-matching, per Stream B's design notes).

## Design

### 1. Sales plan entry (new)

`createSalesPlanEntry(input: { skuId, warehouseId, periodDate, plannedQty, createdBy }): Promise<SalesPlanRow>` in `server/salesPlan.ts` — a plain insert into `sales_plan`, no audit trail needed (this is a forecast being created, not a change to an existing record — matches how `createExpectedPayment`/`createPurchaseOrder` have no audit trail for creation itself, only for later changes).

Router: `salesPlan.create` (editor-only, matches every other create procedure).

UI: new "Sales Plan" section on `StockPage.tsx` — a small form (SKU dropdown, warehouse dropdown, date, planned qty) that calls `salesPlan.create`, plus a table below it showing `getPlanActualDeviation`'s output for the selected SKU/warehouse and `getSalesVolatility`'s output as a single number next to it. This reuses the existing SKU/warehouse selection pattern already on this page (the days-of-cover table).

### 2. Shipment progression past `departed`

Router: `shipments.updateStatus` calling the existing `updateShipmentStatus(id, newStatus, { changedBy })` from Stream B — editor-only. No new backend logic; this is pure wiring, the function and its `change_log` audit already exist and are tested.

UI: `ShipmentsPage.tsx` — the existing per-shipment row gains a status-transition control (a button per valid next status, driven by `VALID_SHIPMENT_TRANSITIONS` — data-over-branching, not a hardcoded dropdown of all statuses) that calls `shipments.updateStatus`.

### 3. Customs status + actual arrival date (new)

`setShipmentCustomsStatus(id, newStatus, opts: { changedBy, reasonCategory, reasonNote? })` and `markShipmentArrived(id, actualArrivalDate, opts: { changedBy, reasonCategory, reasonNote? })` in `server/shipments.ts` — both audited via `logChange` (customs holds and arrival timing directly affect delay, matching the spec's existing "every field-level change to a Shipment that affects delay or cost" rule). `setShipmentCustomsStatus` validates the new value is one of `CUSTOMS_STATUSES` (data-over-branching: no transition table needed here per the spec — customs status isn't a strict progression the way shipment status is, a shipment can bounce between `declared`/`held` during a real customs hold).

Routers: `shipments.setCustomsStatus`, `shipments.markArrived` — both editor-only, both requiring `reasonCategory` in the input (mirroring the existing `recordShipmentCosts` procedure's shape).

UI: `ShipmentsPage.tsx` — extends the existing reason-category-driven edit pattern already used for cost fields on this page, adding a customs-status dropdown and an arrival-date field, each with the existing reason-category/note inputs.

### 4. Actual depart date correction (new)

`correctShipmentActualDepartDate(id, newDate, opts: { changedBy, reasonCategory, reasonNote? })` in `server/shipments.ts` — updates `actualDepartDate` directly via `db.update`, bypassing `VALID_SHIPMENT_TRANSITIONS` entirely (this is fixing a data-entry mistake, not a status progression — the shipment's `status` field is untouched by this function). Audited via `logChange` with a required `reasonCategory`, matching every other delay-affecting field change in this codebase.

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

### 8. Transaction matching UI (pure wiring)

Router: `payments.matchTransaction` — **already exists** (`server/routers.ts:131-133`, from V1's Task 16b), calling `matchTransactionToPayment(transactionId, paymentId)`. No router change needed for this item at all — it is UI-only wiring.

UI: `MoneyPage.tsx`'s Cashflow tab — replace the current unmatched-transaction *count* with an actual list (from the existing `listUnmatchedTransactions`), each row getting a "match to payment" action: a dropdown of open expected payments (unpaid, per `createExpectedPayment`'s existing shape) calling `payments.matchTransaction`. No fuzzy matching or auto-suggestion — a plain manual pick, per the spec's explicit rejection of automated matching.

## Testing

Every new function (`createSalesPlanEntry`, `setShipmentCustomsStatus`, `markShipmentArrived`, `correctShipmentActualDepartDate`, `listPaymentsForPo`) gets real-DB TDD tests, matching this codebase's existing convention (no mocks). The three audited functions (`setShipmentCustomsStatus`, `markShipmentArrived`, `correctShipmentActualDepartDate`) each need a test confirming the `change_log` row is written with the right `reasonCategory` and the correct prior value — the exact class of bug (wrong/missing prior value, missing audit entirely) that V1's own build caught twice in different functions (Tasks 6 and 7). Router procedures get the same `editorProcedure`/`protectedProcedure` treatment as every existing procedure — no new access-control pattern. UI changes are verified live in a browser per this codebase's established practice for frontend tasks (start dev server, exercise the actual flow), not just type-checked.

## Open Questions

None — the one open question from drafting (whether `payments.matchTransaction` already existed) was resolved by checking `routers.ts` directly before finalizing this spec.
