# App-wide UX Redesign — Design

## 1. Problem

Most of the app's 7 pages (Catalog, Home, Stock, Purchase Orders, Shipments, Cost & Cashflow, Transactions) were built functionality-first and never got a real UX pass — several are bare `<table>`/`<div>` markup with no relation to the design-system tokens Stream K introduced (`client/src/index.css`), the one exception being Home's 09-24 upgrade. Separately, a page-by-page comparison against the real Jello Control Tower Google Sheet (`acc/tools/tool-jello-sc-tables-backup-2026-09-14.gs`) — the system of record this platform is meant to replace — surfaced real field-parity gaps: data Artem relies on in the Sheet today that this platform doesn't show or compute at all (richest example: Stock's `StockModel — FF`/`StockModel — Mutual` tabs' pipeline-visibility fields).

A third pass, done after all 7 pages were otherwise decided, asked a forward-looking question: could this run 20 clients semi-automatically, not just Jello? That pass found zero alerting/notification code anywhere in the repo and a fully manual deployment runbook (`RAILWAY.md`) — real gaps, but ones that only become load-bearing once a second real client exists. Three small, cheap wins from that pass are folded into this design (bulk SKU/Vendor import, FX-rate auto-fetch, transaction match auto-suggestion); the rest is recorded as an explicit backlog (§10) rather than spec'd now.

## 2. Scope

**In scope**: UI/UX redesign of all 7 pages — confirmed field additions (cross-checked against the real Sheet and against each page's own current tRPC/schema surface), visual-design-system adoption, and the 3 "scale past one client" automations named above.

**Out of scope**:
- The replenishment engine (WAS, blackout calendar, growth-rate overrides, recommended order quantity) — a separate module, explicitly gated on the Shraks deal signing. Requirements already captured in `plan-accommerce-inventory-replenishment-requirements.md` (derived from Tucann's proven design). Stock's redesign (§5) gives real pipeline-visibility numbers a human can act on, but deliberately stops short of an automated "order X units" suggestion.
- Platform-level automation for running multiple clients (cross-client rollup, automated instance provisioning, real Shopify Admin API integration, notification/alerting infrastructure) — recorded as backlog (§10), not designed here. Building these against a single not-yet-cut-over client would mean guessing requirements instead of learning them from a real second deployment.
- PPV (Purchase Price Variance) tracking — present in the Sheet's `PO_COLUMNS`, explicitly declined by Artem ("не потрібен, не користуємось").

## 3. Catalog

Page restructures from 3 stacked sections into 3 top-level tabs (SKUs / Vendors / Warehouses), same button-based tab pattern as `MoneyPage.tsx`.

### 3.1 SKU tab
- New **Identifier** column showing the real identifier value regardless of `primaryIdentifierType` — fixes a real display bug: the table currently only has SKU/Name columns, so a row whose primary type is `ssku`/`asin`/`ean`/`fnsku` shows "—" in both and its real identifier is invisible.
- **Bundle badge** — `skus.isBundle` exists in the schema but is rendered nowhere today.
- **Status as a badge + separate Activate/Deactivate button** — today one button's own label doubles as the current state, which reads as confusing.
- **Search/filter bar**: by SKU/name text, status, bundle-only toggle.
- **Lead Time / Safety Stock inline-edit stays exactly as-is** (`leadTimeDays`/`safetyStockDays`, flat per SKU) — explicitly decided NOT to split into a production/shipping-mode (sea/air) pair now. `getStockStatus()` doesn't consume shipping mode today, and `shipments.shipMethod` plus real planned/actual dates already capture the true mode once a real shipment exists. A SKU-level production+transit split is exactly the shape the future replenishment module will need (see requirements doc §7/§16) — building it speculatively now risks guessing the wrong shape for whatever real client drives its design. Revisit when that module is actually spec'd.
- No `vendorId` added to `skus` — the vendor↔SKU relationship stays at the PO level, not a Catalog concern.

### 3.2 Vendors tab — schema migration
New columns on `vendors`, one migration:
- `type`: fixed enum `manufacturer` / `trading_company` / `agent` / `other` — not free text, to avoid "Manufacturer"/"manufacturer"/"Mfr" drift that would break type-based filtering/reporting.
- `products`: a flexible list, not 3 rigid "Product 1/2/3" columns as in the Sheet — a 4th product tag would otherwise force another migration.
- `active`: boolean, same badge+toggle pattern as SKU status.
- `createdBy`/`updatedBy` audit columns, added in the **same** migration — resolves the previously-open "Catalog audit trail" question (asked 09-24) by bundling it with this schema touch instead of a second one later, matching the precedent Tucann's Cook I3 fix set.
- UI: table gains Type / Products / Active columns; the inline-edit form also finally surfaces `notes` (exists in schema, never shown before).

### 3.3 Warehouses tab
- Add Active/Inactive (badge + toggle, same pattern) — lets a warehouse be retired (e.g. dropping a 3PL) without deleting its history in `shipments`/`inventory_ledger`. No other gap found against the Sheet.

### 3.4 Bulk SKU/Vendor import
Reuses the tab-separated-paste + preview-table pattern built for Transactions (§9.2): a new client arrives with an existing catalog (hundreds of SKUs) and vendor list, and one-by-one Add SKU/Add Vendor forms don't scale to onboarding. This makes bulk-paste a genuinely reusable pattern across the app (Transactions, Catalog SKUs, Catalog Vendors) rather than a one-off built for a single page.

## 4. Home

Existing 5 `StatCard`s (Active SKUs, Stockout-risk SKUs, Near-term cash needs 14d, Overdue payables, Unmatched transactions) are kept unchanged — already polished 09-24.

### 4.1 Two new StatCards
So every nav item has a Home presence (today Purchase Orders and Shipments have none):
- **"Open Purchase Orders"** → `/purchase-orders`, count where `status` in (`confirmed`, `in_production`, `shipped`, `customs`) — excludes `draft` (not a real commitment yet) and `delivered`/`closed` (done).
- **"Shipments in transit"** → `/shipments`, count where `status` in (`departed`, `in_transit`, `customs`) — excludes `planned` and `delivered`.

### 4.2 New "Cashflow Outlook" section (below the KPI grid)
- **14-day daily bar chart** — `getCashflowForecast(today, +14d)`, already computed server-side for the existing "Near-term cash needs" card, now also returned as the raw per-day array instead of only the reduced sum. One series (planned outflow), no legend (dataviz skill rule: a single series needs no legend, the chart title names it), hover tooltip per bar (amount + date).
- **13-week bar chart** — the same `getCashflowForecast(from, to)` call with a 91-day window; the server aggregates the daily rows into 13 weekly buckets before returning (client stays dumb). A standard treasury-style 13-week cashflow view, a distinct horizon from the 14-day short-term one. Sparse/empty far-out weeks are expected (no PO/payment planned that far ahead yet, not a bug) — ships with a small caption saying so.
- `plannedOutflowIsEstimated` (the mixed-currency flag, already computed, never surfaced on Home before) is shown as a muted/textured bar treatment per the dataviz skill's status-color rules.
- Server change: `getHomeSummary()` returns both forecast arrays alongside its existing fields — still one `trpc.dashboards.home` call, no new endpoint.

## 5. Stock

### 5.1 Source: the real Control Tower Sheet's StockModel tabs
`StockModel — FF` / `StockModel — Mutual` (`acc/tools/tool-jello-sc-tables-backup-2026-09-14.gs:1862-2130`) is a 360-day daily projection engine per warehouse — far richer than this platform's current flat "SOH + 30-day trailing average + days of cover." Its per-SKU, per-date fields:

| Field | Meaning |
|---|---|
| `IN` | Qty landing that date (landed, or planned-not-yet-landed with a known ETA for future dates) |
| `Batch` | Shipment id(s) landing that date |
| `/day` | Daily sell rate (actual for past dates, planned Sales Plan rate for future dates) |
| `Stock` | Running balance at start of date (prev `Stock` + prev `IN` − prev `/day`) |
| `Trans d` | Days until the nearest shipment **in transit** lands (departed by this date AND effective-ETA still after it; effective ETA = actual arrival if landed, else ETA) |
| `Prod d` | Days until the earliest still-in-production PO's `Planned Ready Date` (that PO has `Qty Remaining to Produce` > 0) |
| `Stk d` | Days of stock the current `Stock` alone covers — cumulative sum of future daily rates, not a flat average |
| `Pipeline d` | `Stk d + Trans d + Prod d` — total real runway including everything already committed |
| `Status` | Color/emoji bucket off `Stk d`, one flat threshold set for every SKU in the Sheet (<=0 stockout, <21 critical, 21-45 low, 45-90 ok, >90 overstock) |

### 5.2 Decided translation into accommerce-inventory
- **Do not reproduce the literal 360-day date grid.** That's a spreadsheet simulation artifact (each formula references the row above it) — an unusable web table at that size, and not something a human reads row-by-row. Compute the same fields for **today** as a live snapshot, not a stored day-by-day grid.
- **No new tables needed** — confirmed by reading the schema, only new aggregation logic in `server/dashboards.ts`:
  - `Prod d`: `purchaseOrders.plannedReadyDate` + `poLineItems.qtyProduced` (qty remaining = `qty − qtyProduced`).
  - `Trans d`: `shipments.actualDepartDate` / `plannedArrivalDate` / `actualArrivalDate` + `shipmentLineItems`.
  - `Stk d`: the existing `sales_plan` table (already populated by this page's own "Weekly Sales Plan" section), read forward from today, cumulative-summed against current SOH — replaces the current flat 30-day-trailing-average `daysOfCover` with a real forward simulation wherever a forward plan exists for that SKU; falls back to the existing flat-average method where it doesn't. No silent blending between the two methods — same "don't let two engines disagree silently" principle as the replenishment-requirements doc.
- **Status thresholds stay per-SKU** (`skus.leadTimeDays`/`safetyStockDays`, already implemented and editable in Catalog) instead of the Sheet's one-size 21/45/90-day bands — but now computed off `Pipeline d` instead of the old flat `daysOfCover`, so status reflects the SKU's real total runway (stock + in-transit + in-production), not stock alone.
- **Page structure**: tabs per warehouse, dynamic from the real `warehouses` table (not hardcoded "FF"/"Mutual" — this platform is multi-client), same tab pattern as Money/Catalog, **plus one "All Warehouses" tab** preserving the existing cross-warehouse combined Total row (already built) as its own tab instead of an inline subtotal row.
- **Columns per warehouse tab**: SKU · Stock · IN (today, batch/shipment id on hover) · /day · Trans d · Prod d · Stk d · Pipeline d · Status.
- **Inline "+ Add SKU"** — a compact button/modal on the Stock page itself, reusing Catalog's `createSku` mutation, so a stockout gap found here doesn't require navigating away to register a new SKU.

### 5.3 Explicitly not in scope
No recommended-order-quantity / "how much to order" number on this page — that stays the separate replenishment module (§2). This page gives real runway visibility (`Pipeline d`, `Status`) to inform a human's own ordering decision, not an automated suggestion.

**Known limitation to disclose once shipped**: the production DB is empty until cutover — `Stk d`/`Trans d`/`Prod d` will read as "—"/0 for most SKUs until real historical and forward data is loaded. Not a bug.

## 6. Purchase Orders

`PurchaseOrdersPage.tsx` was checked against its own code and the Sheet's `PO_COLUMNS` (`acc/tools/tool-jello-sc-tables-backup-2026-09-14.gs:467`) for a field-parity gap, same method as Catalog/Stock.

**Finding: functionality is already complete, no real data gap.** Create PO, status advance (with reason/audit), Planned/Actual Ready Date, Payments (mark paid/correct/history), Shipments, Line Items (cost-component breakdown + production progress), Links, and change-log history are all already built and already collapsed into summary+details-toggle (09-24 real-data-scale fix).

**One field-parity gap found and explicitly declined**: PPV (Purchase Price Variance — Standard vs Actual Landed Cost/unit per warehouse, PPV/unit, PPV%, split Freight/Duty/Factory, PPV Trigger). Artem's call: not needed, not used — do not build.

**Remaining scope is UI polish only** (matches Home's own 09-24 upgrade from bare markup to the real design system):
1. Status badges for all 7 PO statuses (`draft`/`confirmed`/`in_production`/`shipped`/`customs`/`delivered`/`closed`) — currently only `delivered`/`closed`/`customs` have a real color, the rest fall to neutral. Every status gets its own color so the whole pipeline reads at a glance.
2. Collapse "New Purchase Order" into a "+ New PO" button (currently an always-open form at the top of the page) — expands on click, keeps the PO list as the primary focus.
3. Search/filter bar above the table (by vendor, by status) — same real-data-scale reasoning as Catalog/Stock.

No changes to the existing details sections (Payments/Shipments/Line Items/Links/History) — already well-structured, kept as-is.

## 7. Shipments

`ShipmentsPage.tsx` checked against the Sheet's `SHIPMENTS_COLUMNS` (`acc/tools/tool-jello-sc-tables-backup-2026-09-14.gs:1007`) — same method. Functionality already complete (Planned/Actual Depart, status transitions, Customs status+arrival, cost recording/correction/locking, Links, Method, shipment-owned Payments, change-log history), already summary+details-toggle.

### 7.1 Two real gaps found, both confirmed wanted
1. **Gross Cost/unit + Net Cost/unit shown directly on the shipment row** (costs section), not only on Money → Landed Cost tab — reuses the existing `getShipmentLandedUnitCost` computation (§8.1 extends it to return both), just also rendered here. Kept on Money too — shown in **both** places per Artem's explicit call, not moved.
2. **Implied Duty Rate** (`Duty ÷ Customs Declared Value`) — a sanity check absent from accommerce-inventory entirely. Added "just in case" per Artem ("контроль зайвим не буває") — shown next to the Duty cost field. `customsDeclaredValue` is a **new manually-entered field on `shipments`** (from the real commercial invoice — Artem explicitly rejected deriving it from the EXW price, since declared value is not the same as EXW value), joining the existing freight/adminFees/duty/eust/vat manual-entry group in the Shipments page's "Save costs" form.

### 7.2 UI polish (same pattern as Purchase Orders)
1. Status badges for all 5 shipment statuses (`planned`/`departed`/`in_transit`/`customs`/`delivered`) and all 4 customs statuses (`not_declared`/`declared`/`held`/`cleared`) — currently only 2 of 5 and 2 of 4 have real colors.
2. Collapse "New Shipment" into a "+ New Shipment" button (currently an always-open form at the top of the page).
3. Search/filter bar above the table (by warehouse, by status).

No changes to the existing details controls (Planned Departure, Status Transition, Customs Arrival, Depart Date Correction, Correct Receipt, Links, Ship Method, Payments) — already well-structured.

## 8. Cost & Cashflow

`MoneyPage.tsx` (3 tabs: Cashflow, Landed Cost, Daily COGS/Sales) functions correctly but isn't visually polished — bare tables, like Home before its 09-24 upgrade.

### 8.1 Landed Cost tab — carries over the Shipments decision (§7.1)
- `getShipmentLandedUnitCost` (`server/landedCost.ts`) currently returns only what the Sheet calls **Net** Cost/unit (`EXW + allocated freight + allocated duty − allocated recoverable VAT/EUST`). Extend it to also return **Gross** Cost/unit (same formula, without subtracting the recoverable portion) — both shown as columns here.
- **Implied Duty Rate** is computed and displayed (not stored) wherever Duty is shown — both the shipment row (§7.1) and this tab, off the same `customsDeclaredValue` field. Not computed two different ways in two places.

### 8.2 Everything else: visual polish
Design-system tables/badges, matching Home's 09-24 upgrade. The Cashflow tab keeps its wider ±30-day window (detailed day-by-day plan-vs-actual reconciliation) — deliberately distinct from Home's new 14-day/13-week forward-only charts (§4.2), not a duplicate. Daily COGS/Sales tab unchanged.

### 8.3 FX-rate auto-fetch ("20-client ERP" pass addition)
`fxRate` is currently hand-typed on every payment/transaction form across the app. `server/cashflow.ts` already has `getStandardFxRate(currency)` — wire it as a default/suggested value on these forms (still editable, never silently overridden) instead of forcing a manual lookup every time.

## 9. Transactions

`TransactionsPage.tsx` reviewed against real-world context found in `acc/tools/jello-transaction-journal.gs`'s own SUPERSEDED comment: the accountant's actual process is logging one transaction at a time as it happens — no bank-feed/API integration exists anywhere in this ecosystem today, confirming the direction below.

### 9.1 Three approaches explored for "how to make entry convenient"
- **(A, declined)** Inline single-row entry in the table itself — faster than the current separate form, but still one-at-a-time.
- **(B, chosen) Bulk paste** — see §9.2.
- **(C, declined)** Bank CSV/OFX upload with per-bank column mapping — too much engineering for how the process actually works (the accountant curates entries, doesn't dump a raw bank export as-is).

### 9.2 Bulk paste (chosen)
A new textarea accepting tab-separated rows (the format Excel/Google Sheets produces when copying a cell range) — same column order as the existing single form: `date · amount · currency · fxRate · counterparty · description`. A caption above the field states the expected column order and date format (`YYYY-MM-DD`). Pasting renders a **preview table**, each row inline-editable, with per-field validation shown before commit (reuses the same `nonNegativeDecimalString` rules the single-row form already validates against). One "Record N transactions" button calls a **new bulk tRPC procedure** (not a client-side loop of N single calls) — one round trip, reporting "recorded X of Y" if some rows failed validation.

The existing single-row "Record a bank transaction" form stays as a fallback for the one-off case — bulk paste becomes the primary path for real volume, not a replacement.

This same tab-separated-paste + preview-table pattern is reused for Catalog's bulk SKU/Vendor import (§3.4) — a shared component, not two independent implementations.

### 9.3 Match auto-suggestion ("20-client ERP" pass addition)
For each unmatched transaction, compute candidate matches by amount (exact, or within a small tolerance for FX rounding) plus date proximity to a payment's `expectedDate`, ranked best-first, shown as one-click suggestion chips above the existing full dropdown. The dropdown stays as a fallback for the no-good-match case — this cuts the repetitive case (scrolling every unpaid payment to find an obvious match) without removing the escape hatch for the genuinely ambiguous one.

## 10. Platform-level backlog (deferred, not part of this spec)

A direct audit (`grep` across `server/`/`scripts/` for notify/webhook/slack/alert — zero results) found no alerting of any kind in the codebase. The only real automation today is a local launchd cron (`ops/com.scait.accommerce-parallel-run.plist`) running the dry-run check on Artem's own machine; `run-daily-shopify-pull.ts` and `run-nightly-export.ts` exist as scripts but are wired to no server-side schedule.

These are real gaps for running 20 clients, but building them now — against a single not-yet-cut-over client — would mean guessing requirements instead of learning them from an actual second deployment. Recorded here for when that changes:

1. **No alerting/notification layer.** Everything today is pull (open a dashboard). At meaningful scale, needs a push layer (daily digest, Slack/email) for stockout-risk, overdue payables, and stalled PO/shipment status.
2. **No cross-client rollup view.** The architecture is intentionally "physically isolated per client, no `tenant_id`" (`accommerce-inventory/CLAUDE.md`) — N clients means N separate instances/logins. A real open question, not just a feature: either a separate lightweight service polling each instance's API for headline KPIs, or this stays deliberately outside the app (ClickUp/Notion) and each instance stays genuinely isolated.
3. **No automated instance provisioning.** `RAILWAY.md` is a manual click-through runbook — standing up Jello's single instance took a full live session (TiDB Cloud + Railway signup together). Repeating that by hand per client is a real bottleneck past 2-3 clients.
4. **No real recurring data-pull automation.** Shopify sales import is a manual script expecting an already-shaped JSON file (blocked on a real Admin API token — see `hot-accommerce.md`); nightly export exists but isn't wired to any cron. At scale, every recurring data flow needs to run unattended with failure alerting (ties to #1).
5. **No background-job health visibility.** If a cron silently fails for one client among many, nobody finds out until something breaks downstream from it.

## 11. Implementation note

Every page section above implies real backend work (new aggregation logic for Stock's pipeline fields, a schema migration for Vendors, a new bulk-insert tRPC procedure for Transactions/Catalog import, an `getShipmentLandedUnitCost` extension, a new `customsDeclaredValue` field). None of it has been implemented — per the brainstorming process this spec followed, nothing was built during the design pass itself. The next step is an implementation plan (`writing-plans`) breaking this into ordered, independently reviewable tasks, most likely one per page/section above, each going through this codebase's established design→plan→subagent-driven-development→whole-branch-review cycle (per `accommerce-inventory/CLAUDE.md`'s Code Workflow).
