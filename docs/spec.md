# SCAIT Stock+Money Platform (Accommerce/Jello first deployment) — Design

## Context & Motivation

SCAIT's original plan was for a third-party platform ("GradeApp") to build a shared Stock+Money module for all SCAIT clients, for free, in exchange for a 20-35% revenue share (confirmed 2026-08-27, spec: `plan-scait-gradeapp-sc-money-module-spec.md`). GradeApp's timeline is unknown as of 2026-09-11. Rather than wait, SCAIT is building this platform itself.

Two existing systems feed this build:
- **Jello Control Tower v2** (`acc/tools/jello-sc-tables.gs`, Google Sheets + Apps Script) — a real, battle-tested Money engine (FIFO Inventory Ledger, landed cost by PO wave, Daily COGS, Cashflow, Sales Plan FF/Mutual), **live and stable today**. It is the primary source of domain logic here, and there is no urgency to cut over — Control Tower keeps running the real business while this platform is built carefully.
- **Tucann inventory app** (`tucann-inventory`, Node/Express + tRPC + React + TiDB) — a real, tested (500+ tests) Stock/Ops engine. Built by Artem under the Tucann client contract; Artem owns the development and has Andrew Coleman's explicit permission to reuse it for other clients. Used as the technical vehicle (stack, scaffold) — not as the primary data model.

**End goal**: one shared codebase and schema template, not two separately-designed client apps — Jello first, Tucann a second deployment later (Money layer sold back to Andrew as a scope addition once proven, not billed against his current 25hrs/wk contract). **Deployment model: single-tenant per client, not multi-tenant SaaS.** Each client gets their own isolated instance — own database, own deployment — built from the same shared template and **hosted on infrastructure the client owns and controls**, not SCAIT's. SCAIT builds and deploys the code; the client's data never leaves their own server. Client-specific differences (bundles, holiday rules, shipping calculators, scorecards, scenario planning, notifications) are built later as modules that attach to the same template, not as branches of it.

## V1 Scope: The Skeleton

V1 is deliberately narrow: a working SQL database and app covering exactly what Control Tower already does today for the core Stock+Money loop, with proper auth from the start (the one gap that isn't safe to defer). Everything else identified during design — bundles, holiday-blackout, shipping/duty calculator, milestone scorecard, scenario planning, notifications, AI invoice ingestion, AI transaction matching — is explicitly **deferred** (see "Deferred Modules" below), designed for at the data level where cheap, but not built now.

### Goals (V1)
- Single source of truth per data type — no duplicated/derived fields that can silently drift (root cause of Tucann's known bugs: WAS computing differently across screens, SOH not reconciling between tabs).
- One shared schema template used to deploy every client's own separate instance — no per-client schema branching, but no shared database between clients either. Client-specific differences are data (`app_settings`, local to each instance), not separate tables, code paths, or a shared multi-tenant database.
- Auth built in from the start — not deferred, given this holds real financial data for paying clients. Tenant isolation is physical (each client's own database on their own infrastructure), not a row-level concern within a shared database.
- Full historical migration of Jello's real PO/Shipment/Ledger/Payment/Transaction data from Google Sheets into SQL, run in **parallel with Control Tower** (not a big-bang cutover) until reconciled.
- Full change/status history on PO/Shipment/Payment records, with required reason notes on delay/cost changes.

### Non-goals (V1 — deferred, see below)
Bundles, holiday-blackout enforcement, shipping/duty calculator, milestone scorecard, scenario planning, notifications/escalation, AI invoice recognition, AI transaction matching, live Shopify API sync, Tucann's own deployment itself.

## Architecture

- **Repo**: one template repository, `accommerce-inventory`, under SCAIT's own account — not `tucannaus`. Each client deployment is a separate deploy from this same template (see "Per-client deployment" below), not a shared running instance.
- **Stack**: Node/Express + tRPC + React, TiDB (MySQL-compatible), Drizzle ORM/migrations — matches `tucann-inventory` for direct pattern reuse, not a git fork. Selected modules (not the whole app) are copied and adapted deliberately, no shared git history.
- **Deploy**: **on the client's own infrastructure**, not SCAIT's. First deployment (Jello) goes on infrastructure Accommerce controls (their own Railway/cloud account, own TiDB Cloud instance) — SCAIT sets it up and maintains the code, the client owns the account and the data. Tucann's future instance is the same pattern, on Tucann's own infrastructure.
- **Backups**: TiDB Cloud managed automated backups/point-in-time recovery (standard DBaaS feature, enabled not built) — configured on the client's own instance. Additionally, a nightly scheduled export of core tables to CSV/Excel as a human-readable snapshot, for the same peace of mind Google Sheets gives today.
- **Per-client deployment & updates**: since every client runs their own isolated instance from the same template, shipping a core-schema/code improvement means deploying it to each client's instance separately (not one shared rollout). This trades away multi-tenant row-isolation risk for a repeatable-deployment discipline instead — worth a documented deploy checklist once there's more than one live instance, not needed for V1 with only Jello live.

### Coding principle: data over branching

Nearly every source of `if`-sprawl identified during design is a per-client *configuration* difference, not different business logic. The fix applied throughout:
- **Client differences live in `app_settings`** (enabled modules, warehouse list, identifier scheme, thresholds), local to that client's own instance — code is identical across every deployment, behavior differs only by the data it reads.
- **Lookup tables over `if/else` chains** for anything with named variants (duty methods, transport modes, identifier types) — each variant is a small function registered in a map, keyed by the variant; adding a new variant is a new map entry, not a new branch scattered through the codebase.
- **Thresholds and rules as data rows**, not hardcoded conditionals (e.g. stock-status bands, holiday windows, notification triggers) — evaluated by one generic function.
- **TypeScript discriminated unions with exhaustiveness checks** for anything with a closed set of types (SKU identifier types, ledger event types) — the compiler forces every case to be handled in exactly one place.

## Data Model — Skeleton (V1)

Ledger-centric core: computed values (SOH, Daily COGS, Cashflow) are views/aggregations over a small set of append-only source-of-truth tables, never separately stored.

**Every table below lives in one client's own single-tenant database — no `tenant_id` column anywhere in the schema.** Isolation comes from each client having their own physical database, not from a shared table filtered by tenant. The schema *template* (table structure) is identical across every client's deployment; the *data* in each instance is entirely separate.

**Auth & config**
- `app_settings` — single-row config local to this instance (enabled modules, warehouse list, identifier scheme, thresholds) — the socket that later modules attach to without schema rework.
- `users` — email, role (`editor` — the one SCAIT account with write access — or `viewer` — client-side, e.g. Andrew/Julian/Klemens, read-only dashboards), `manager_id` (self-referencing, for future escalation — unused in V1, cheap to store now).
- Auth via a standard session-based library (not built in-house).

**Catalog**
- `skus` — this instance's product catalog. Six identifier columns (`sku`, `ssku`, `asin`, `ean`, `fnsku`, `name`), all optional, plus `primary_identifier_type` marking which one is authoritative for display/matching. Unique constraint on `(primary_identifier_type, identifier_value)`, not per-column (most clients won't populate all six). `status` (`active`/`inactive`) — inactive SKUs are excluded from any future reorder suggestion (PO Builder) by construction, not by a filter someone has to remember to apply.
- `vendors`
- `warehouses` — this instance's own list (Jello: FF/DE, Mutual/CH; Tucann: its own structure) — count and names never hardcoded.

**Orders & fulfillment**
- `purchase_orders` + `po_line_items` — per-SKU qty/price, flexible payment-term slots, production timeline dates, `status` (draft → confirmed → in production → shipped → customs → delivered → closed).
- `shipments` — freight/customs (`customs_status`, `customs_declaration_link`), pooled-container SKU-split by weight/value share.
- `payments` — expected payment slots tied to PO/Shipment tranches; manual paid/unpaid + date + `amount` + `fx_rate` (entered at time of actual payment — not a standing rate) + computed `base_currency_amount`.
- `transactions` — raw real bank-transaction journal (date, amount, currency, `fx_rate`, counterparty, description), separate from `payments`, with an optional nullable `matched_payment_id` (filled manually in V1; AI-matching agent is a future phase using the same field).

**Inventory & sales**
- `inventory_ledger` — append-only; one row per stock event (receipt, sale, adjustment): `sku_id`, `warehouse_id` (non-nullable — structurally prevents blending channels), `event_type`, `qty`, `unit_cost` (landed, for FIFO), `date`, `source_ref`. SOH and FIFO landed cost derive from this table, never stored separately. Composite index on (`sku_id`, `warehouse_id`, `date`) from the first migration — the column set every SOH/WAS/Daily COGS query filters on; cheap now, keeps recompute-on-read fast at 10K+ SKU scale without needing materialized views.
- `sales_plan` — manual entry (low volume, planning data). `sales_actuals` — populated by a **daily scheduled Shopify pull** (a job, not a form), not manual per-row entry: real order volume (thousands/day for Jello) makes row-by-row entry unworkable. This is a batch job run once a day, distinct from the "live Shopify Admin API sync" in Deferred Modules below, which means real-time/continuous sync — the daily pull is V1 scope, real-time sync stays deferred. Sale events also write to `inventory_ledger` from the same daily job, same validation path as any other ledger write (no separate, less-trusted code path for automated writes).

**Change tracking**
- `change_log` — generic, reused across PO/Shipment/Payment: `entity_type`, `entity_id`, `field`, `old_value`, `new_value`, `reason_category` (fixed taxonomy — see Dashboards below), `reason_note` (free text, required only when category is "other"), `changed_by`, `changed_at`. Category+note required specifically for delay/cost changes.

### Dashboards (V1)

**Information architecture**: top-level nav is **Home, Stock, Purchase Orders, Shipments, Money** — 5 items grouped by domain, not one flat screen per table. Change Log is not a top-level nav item; it's reached from a "show history" link on any PO/Shipment/Payment record, or a small utility/search entry point.

- **Home** — configurable summary local to this instance (which metrics matter to this client, drawn from the underlying data below) — the single default landing view.
- **Stock** — SOH, days-of-cover, status thresholds (data rows, not hardcoded); per-SKU volatility index, a view over `sales_actuals` — usable standalone before the full reorder engine exists.
- **Purchase Orders** — status list/timeline (draft → ... → closed), separate from Shipments because the real relationship is many-to-many (one PO ships across multiple waves; one shipment can pool cargo from multiple POs in a container) — a forced 1:1 pipeline view would misrepresent that. Each PO links to its related shipments.
- **Shipments** — its own status/timeline (freight/customs/ETA), each shipment links back to the PO(s)/SKUs it's carrying.
- **Money** — one section, three tabs: Cashflow (planned `payments` vs actual `transactions`, unmatched-transaction list), Landed Cost (per SKU/shipment breakdown), Daily COGS/Sales (actual vs plan, per warehouse/channel and drilled down per SKU — plan-actual deviation is `sales_actuals − sales_plan` at SKU grain).
- **Change Log** (utility, not top-level nav) — filterable view over `change_log`, with `reason_category` (fixed taxonomy: production delay, artwork/documentation delay, customs/inspection hold, forwarder/logistics delay, payment/cash timing, vendor price change, freight rate change, holiday/capacity constraint, other — free-text note required only for "other") plus optional free-text note on every entry. Enables real aggregation ("how many delays this quarter were customs vs factory"), not just full-text search over free-form reasons.

## Deferred Modules (designed for, not built in V1)

Each attaches to the skeleton above via `app_settings` (enable/disable per client instance) without schema rework to the core tables:

- **Bundles** — optional module, enabled per instance (Jello has them, Tucann doesn't); component-demand explosion logic lives entirely inside the module, `skus.is_bundle` + component mapping is the only core-schema hook.
- **Holiday blackout** — `holiday_calendars` (region/factory/forwarder windows) + validation on PO/Shipment `planned_*` date fields; hard deadline block (not a capacity-derate), only applies to planned dates — an already-departed shipment (`actual_depart_date` set) is exempt.
- **Shipping & duty calculator** — per-SKU packaging attributes (unit/carton weight & dimensions, MOQ per vendor), transport-mode-specific volumetric-weight formulas (air/sea FCL/LCL/rail/local) and duty-calc methods (ad valorem vs fixed per unit), each registered in a lookup table, not branched inline.
- **Milestone scorecard** — `milestones` per PO/Shipment (factory-ready → depart China → arrival → final delivery), `responsible_party` (factory/forwarder/3PL), planned vs actual dates, delay computed automatically — builds vendor-performance history over time.
- **Scenario planning** — `scenarios` clone `sales_plan` (and downstream PO-Builder projections) into an independently editable branch for what-if comparison (pre-season, Black Friday, Chinese-holiday procurement options). Hard architectural rule: scenario-tagged rows can never write to `inventory_ledger`/`payments`/`transactions` — enforced in the write path, not by convention.
- **Notifications/escalation** — curated high-value triggers only (holiday-blackout risk, stockout risk, payment overdue past a threshold), routed to the responsible owner first, escalated to `manager_id` if unacknowledged within a window; manager can convert a notification into an action item. Thresholds live in `app_settings`.
- **PO Builder (reorder engine, from Tucann)** — WAS (variable-lookback), CV-based safety-stock buffer, seasonal drop-off, computed over `inventory_ledger` + `sales_actuals`. Always produces a *suggestion* for human review — never auto-commits a PO.
- **AI invoice/receipt ingestion** — upload PDF/image → Claude extracts vendor/amount/currency/line items/references (matched against any of the 6 SKU identifiers) → fuzzy-match against PO/Shipment → human-in-the-loop confirm before anything touches `inventory_ledger`/Cashflow. No silent auto-commit to money tables, ever.
- **AI-driven transaction matching** — agent proposes `transactions` ↔ `payments` matches for confirmation, using the same `matched_payment_id` field the manual flow uses.
- **Live (real-time) Shopify Admin API sync** — the V1 daily pull (see `sales_actuals` above) covers day-to-day operation; continuous/real-time sync is a future upgrade once Jello's token situation is fully resolved, not required for V1.
- **Tucann onboarding** — separate future spec: stand up Tucann's own instance from the same template, migrate Tucann's live data into it, sell the Money layer as a scope addition to the existing contract.
- **SCAIT Console** — a separate, SCAIT-owned app (not client data, lives on SCAIT's own infrastructure) giving a portfolio view across every client instance. Each client instance exposes one authenticated read-only summary API (the same query the Home dashboard already runs, just exposed externally via a scoped API key) — only pre-aggregated KPIs cross the boundary (fires, stockout-risk SKUs, near-term cash needs), raw PO/Shipment/Ledger/Payment data never leaves the client's own server. The Console shows all clients' status on one screen and deep-links into a specific instance (through that instance's own editor login, not a bypass). Meaningful only once 2+ instances are live — V1's Home dashboard should be written so its query can later be exposed as this same API without rework, but the Console itself is not built in V1.

## Migration Plan (Jello)

No urgency — Control Tower is live and stable. Migration runs in **parallel**, not as a cutover:
1. One-time import of real historical PO/Shipment/Ledger/Payment/Transaction data from the live Control Tower Sheet into the new schema.
2. Automated reconciliation (per-SKU/warehouse SOH and landed-cost totals, Sheet vs SQL) — any mismatch blocks proceeding.
3. Run both systems side by side for a defined period; investigate any divergence.
4. Only once reconciled and stable does Control Tower become a read-only historical reference — never deleted, kept as an audit copy.

## Error Handling & Testing

- Validation failures (negative stock, invalid state transitions) block save with an explicit message — never silently allowed through.
- Each calculation module (WAS, FIFO landed cost) gets unit tests against real historical Jello data pulled from Control Tower as fixtures, so migration can't silently change the numbers.
- Migration includes the automated reconciliation check above as a hard gate, not a manual spot-check.

## Open Questions

- **Multi-currency landed cost aggregation**: `payments`/`transactions` carry `fx_rate` at time of actual payment, but a single PO can have components in different currencies (EXW in USD/CNY, freight in EUR). How these aggregate into one landed-cost/unit figure in the instance's reporting currency isn't fully specified — needs a decision during implementation planning, not glossed over silently.

## Commercial/IP Notes

- Tucann Stock/Ops engine code: Artem owns the development; Andrew Coleman has given explicit permission to reuse it for other clients.
- Money engine (sourced from Jello's Control Tower methodology): built as a SCAIT-owned asset, not billed against Tucann's current contract. Plan is to sell it to Tucann as a scope addition once proven on Jello — not yet agreed with Andrew.
