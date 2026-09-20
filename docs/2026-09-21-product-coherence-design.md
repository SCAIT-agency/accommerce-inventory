# Product Coherence (Jobs lens) — Design

Backlog Stream K. Addresses every Product (Jobs) item from `docs/BACKLOG.md` section I / `docs/2026-09-20-three-lens-architecture-review.md` that is a bounded fix. Third and final tier of the priority order the user set explicitly after Stream I ("1-100%, 3, 2" → Operational, then Engineering, then Product), following the Operational cleanup (2026-09-20/21) and Backlog Stream J (Engineering, 2026-09-21).

## Scope

1. Replace raw SKU-id display (`SKU #17`) with real names/codes everywhere it appears.
2. Make the Change Log genuinely reachable from the UI.
3. Fix a class of "guaranteed-to-fail" shipment status controls, and the resulting 4-controls-in-one-cell layout.
4. Add currency symbols and standardize date formatting.
5. Replace the fixed 21/45/90-day stockout-risk thresholds with a per-SKU, lead-time-aware reorder point.
6. Rebuild Home from 4 static counters into clickable, actionable entries.
7. Add edit to Catalog (SKU edit + archive via its existing `status` field; Vendor/Warehouse edit).

Explicitly out of scope (deferred, tracked separately): Vendor/Warehouse archiving (needs its own design pass — unlike SKU, these tables have no `status` column today, and "archiving a vendor with open POs" is a real product question, not a bounded fix); a full visual redesign of any page (this stream fixes concrete coherence defects, not a restyle); router-layer numeric input validation (already deferred by the Engineering stream's design doc).

## 1. Replace raw SKU-id display with names

**Current state, verified by reading each file:**

- `client/src/pages/ShipmentsPage.tsx:387,480,533` — three spots render `SKU {li.skuId}` in a shipment's line-item list, the PO-line picker's option labels, and the new-shipment line-item summary. This file fetches `purchaseOrders.list`/`getWithLineItems` and `catalog.listWarehouses`, but never `catalog.listSkus`.
- `client/src/pages/PurchaseOrdersPage.tsx:340` — same pattern in a PO's line-item summary. This file already fetches `catalog.listSkus` (for the create-PO line-item picker at a different spot), so the query exists but isn't reused for this display.
- `client/src/pages/MoneyPage.tsx:127` — the Landed Cost tab's table renders `<td>{row.skuId}</td>`. This file already has a `skuLabel()` helper (added in the Operational-cleanup stream for the SKU picker) and already fetches `catalog.listSkus` — the landed-cost table just never adopted it.
- `client/src/pages/InventoryLedgerPage.tsx` — the whole page header reads `SKU #{skuId}, warehouse #{warehouseId}` with zero name lookup; this page fetches nothing from `catalog` today.
- `client/src/pages/StockPage.tsx` — **already correct**, confirmed by reading it: `getStockDashboard` returns a `sku` field alongside `skuId`, and the table renders `{row.sku}` directly plus a `warehouseLabels` map for warehouse names. Not touched by this task — it's the reference pattern the others should match.

**Fix:** each file builds a `Map<number, string>` (or reuses `MoneyPage.tsx`'s existing `skuLabel()` function, moved to a shared location — see below) from `catalog.listSkus`, keyed by id, and looks up the label instead of rendering the raw id.

`skuLabel()` currently lives inline in `MoneyPage.tsx`:
```ts
function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}
```
Move this to a new small shared module `client/src/lib/labels.ts` (this codebase's `client/src/lib/` already holds `trpc.ts`; a `labels.ts` sibling is the natural home), export it, and import it from every page that needs it: `MoneyPage.tsx` (replacing its own inline copy), `ShipmentsPage.tsx`, `PurchaseOrdersPage.tsx`, `InventoryLedgerPage.tsx`. `InventoryLedgerPage.tsx` also needs a warehouse label — reuse the same `${w.code} — ${w.name}` format `StockPage.tsx` already uses for its `warehouseLabels` map (extract that into `labels.ts` too as `warehouseLabel()`, and have `StockPage.tsx` adopt it instead of its own inline map-building, so there is one shared definition rather than two that could drift).

`InventoryLedgerPage.tsx` needs new queries (`catalog.listSkus`, `catalog.listWarehouses`) it doesn't currently have; the other three files already fetch `catalog.listSkus` for other purposes (or, for `ShipmentsPage.tsx`, need to add it — confirmed no existing fetch).

## 2. Make the Change Log reachable

**Current state, verified:** `client/src/main.tsx`'s route `/change-log/:entityType/:entityId` and `ChangeLogPage.tsx` both exist and work — `grep -rn "change-log" client/src/` (excluding `main.tsx` itself) returns **zero** results. No page anywhere links to it. `payments.history` is separately and correctly reachable via an inline `PaymentHistory` component in `PurchaseOrdersPage.tsx` (verified in the Engineering stream) — that one is fine and untouched by this task; this task is specifically about the shared `/change-log/:entityType/:entityId` route, whose only consumers today are `purchase_order` and `shipment`, and which nothing links to.

**Fix:** add one link per entity, next to where its status is already shown:
- `PurchaseOrdersPage.tsx`: a `<Link to={\`/change-log/purchase_order/${po.id}\`}>History</Link>` in the Status column, next to the existing status badge and `AdvanceStatusControl`.
- `ShipmentsPage.tsx`: a `<Link to={\`/change-log/shipment/${shipment.id}\`}>History</Link>` in the Status cell, next to the status badge (see section 3 below — this cell is being reorganized in the same task anyway).

Both files already import `Link` from `react-router-dom` for other purposes (confirmed: `StockPage.tsx` uses it for the batch-detail drill-down; check each target file's own imports before adding — add the import if genuinely missing).

## 3. Fix guaranteed-to-fail shipment status controls

**Current state, verified by reading `ShipmentsPage.tsx` in full.** The Status cell (`ShipmentRow`, around line 366-383) unconditionally stacks 4 controls in one `<td>`: `PlannedDepartureControl`, `StatusTransitionControl`, `CustomsArrivalControl`, `DepartDateCorrectionControl`. Two of these render even when their action is guaranteed to fail:

- **`StatusTransitionControl`** (line 182) computes `nextStatuses = VALID_SHIPMENT_TRANSITIONS[shipment.status]` and only hides when that list is empty. But `VALID_SHIPMENT_TRANSITIONS` is `{ planned: ["departed"], departed: ["in_transit"], in_transit: ["customs"], customs: ["delivered"], delivered: [] }`, while the backend `updateShipmentStatus` function *explicitly rejects* `newStatus === "departed"` and `newStatus === "delivered"` with a message telling the caller to use `markShipmentDeparted`/`markShipmentArrived` instead (confirmed in `server/shipments.ts`). So for a `planned` shipment, this control renders a working-looking "advance to departed" option that always fails; same for a `customs` shipment advancing to "delivered". This is the exact same bug class the backlog flagged for `CustomsArrivalControl`, independently present here for two more status values — not previously named in the review, found while designing this task's fix.
- **`CustomsArrivalControl`** (line 228) has no status guard at all — it always renders its "Save arrival date" button (calling `markArrived`), which the backend rejects unless `shipment.status === "customs"` (confirmed: `markShipmentArrived` checks `VALID_SHIPMENT_TRANSITIONS[shipment.status].includes("delivered")`). The customs-status dropdown/button (`setCustomsStatus`) is a genuinely independent field with no status-transition guard on the backend — that part is correctly always-available and must stay that way.

**Fix:**
- `StatusTransitionControl`: change `nextStatuses = VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? []` to filter out the two statuses that always have a dedicated control: `.filter((s) => s !== "departed" && s !== "delivered")`. This makes the control naturally show only for the two transitions it's actually meant for (`departed → in_transit`, `in_transit → customs`) and naturally disappear for `planned`/`customs`, where the dedicated controls already exist.
- `CustomsArrivalControl`: disable (not hide — the customs-status dropdown must stay available regardless) the "Save arrival date" button when `shipment.status !== "customs"`, and add a short inline hint (e.g. "available once customs status is set" is wrong framing — the real gate is shipment status, so: "available once the shipment has reached customs" or similar) next to the disabled button so a user understands why it's greyed out rather than silently guessing.

**Net effect on the cell**, once both fixes land: for any given shipment, at most 2 of the 4 stacked controls render/enable at once (the one status-appropriate control, plus `DepartDateCorrectionControl` which is orthogonal and only shows once `actualDepartDate` is set) — this substantially resolves the "4 controls in one cell" coherence complaint without a full layout rewrite, since the remaining controls are now genuinely each other's replacement across the shipment lifecycle rather than 4 simultaneously-relevant options.

Add the Change Log link (section 2) into this same cell while it's being touched.

## 4. Currency symbols and date-format standardization

**Currency, current state:** money is displayed as `{amount} {currency}` (a 3-letter code) in most places — never a symbol. Add a small shared helper alongside `labels.ts` (or in the same file):
```ts
const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CNY: "¥", GBP: "£" };

export function formatMoney(amount: string | number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase() + " ";
  const value = typeof amount === "string" ? amount : amount.toFixed(2);
  return `${symbol}${value}`;
}
```
Apply it everywhere a `{amount} {currency}` pair is currently rendered as two separate interpolations — confirmed spots: `PurchaseOrdersPage.tsx` (payment display, PO line-item display), `ShipmentsPage.tsx` (PO-line picker, line-item summary), `TransactionsPage.tsx` (transaction row, matching-picker options), `MoneyPage.tsx`'s cashflow/COGS tables already just show a bare number with no currency at all — those stay as-is (they're single-currency-normalized totals, not a raw amount+currency pair; adding a currency label there is a separate, larger design question about which currency to label a multi-source total with, out of scope here).

**Dates, current state, verified:** the dominant, correct convention across the app is `new Date(x).toISOString().slice(0, 10)` (a clean `YYYY-MM-DD`), used in `ShipmentsPage.tsx`, `StockPage.tsx`, and elsewhere. Two files deviate with a raw `.toString()` (verbose, includes a full weekday/timezone string): `PurchaseOrdersPage.tsx` (`payment.paidDate?.toString()`, `payment.expectedDate.toString()`, `po.plannedReadyDate?.toString()`) and `ChangeLogPage.tsx` (`e.changedAt.toString()`). Fix: replace all 4 with the same `.toISOString().slice(0, 10)` pattern (guard for `null`/`undefined` exactly as the existing `?? "—"` idiom elsewhere in the same files already does).

## 5. Lead-time-aware stockout risk (replaces the fixed 21/45/90-day thresholds)

**Current state:** `server/dashboards.ts`'s `STOCK_STATUS_THRESHOLDS` is a fixed, business-agnostic bucket list (`critical <21d`, `low <45d`, `ok <90d`, `overstock` else), and `getHomeSummary`'s stockout-risk count uses a hardcoded `daysOfCover < 21` check — neither has any relationship to this business's real replenishment cycle. Per this engagement's own records (Jello's actual PO-to-warehouse lead time is ~66 days, with a further ~14-day safety buffer already used in prior Jello planning work), a SKU with 30 days of cover reads as merely "low" today when it is, in reality, already past the point where a fresh order could arrive before stockout.

**Schema change:** add two columns to `skus` (`drizzle/schema.ts`), defaulting to Jello's real known numbers so every existing/new SKU gets a sane value with no manual entry required, while still being editable per SKU (per this engagement's standing "everywhere must have manual input options" principle — some SKUs genuinely have a different vendor lead time):
```ts
leadTimeDays: int("leadTimeDays").default(66).notNull(),
safetyStockDays: int("safetyStockDays").default(14).notNull(),
```

**New status logic**, replacing `STOCK_STATUS_THRESHOLDS` in `server/dashboards.ts`:
```ts
function getStockStatus(daysOfCover: number | null, leadTimeDays: number, safetyStockDays: number): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const reorderPoint = leadTimeDays + safetyStockDays;
  if (daysOfCover < leadTimeDays) return "critical"; // can't outlast the replenishment lead time itself
  if (daysOfCover < reorderPoint) return "low"; // below the reorder point -- should reorder now
  if (daysOfCover < reorderPoint * 3) return "ok";
  return "overstock";
}
```
`getStockStatus` and `getStockDashboard`/`getHomeSummary`'s callers now need each SKU's `leadTimeDays`/`safetyStockDays` (already fetched alongside the SKU row via `listSkus`, no new query needed) instead of the removed fixed thresholds. `getHomeSummary`'s stockout-risk check (`daysOfCover < 21`) becomes `daysOfCover < sku.leadTimeDays + sku.safetyStockDays` — the SKU's own reorder point, matching `getStockStatus`'s "low" boundary exactly (being at or below the reorder point IS the at-risk condition, by definition).

This migration needs its own pre-flight check (same discipline as the Engineering stream's schema changes): confirm no existing test or real data assumes the old fixed-threshold behavior in a way a reorder-point-based threshold would break — expected to be fine since every existing stockout test uses concrete SOH/sales numbers, not a hardcoded day count, but verify by running the existing suite after the change, not assuming.

## 6. Home page: from static counters to actionable entries

**Current state:** `client/src/pages/HomePage.tsx` is a plain `<dl>` of 5 stat pairs (Active SKUs, Stockout-risk SKUs, Near-term cash needs, Overdue payables, Unmatched transactions) — none are links, none suggest what to do about the number shown.

**Fix, scoped to "make it actionable," not a visual redesign:** wrap each stat in a `<Link>` to the page where it can actually be acted on:
- Active SKUs → `/catalog` (where SKUs are managed).
- Stockout-risk SKUs → `/stock` (where the per-SKU/warehouse breakdown and status live).
- Near-term cash needs / Overdue payables → `/money` (Cost & Cashflow — where both figures come from and where payments get recorded/matched).
- Unmatched transactions → `/transactions` (where matching happens).

Each becomes a real navigation entry point instead of a dead-end number, using this app's existing routing (`react-router-dom`'s `Link`, already used elsewhere) — no new page, no new layout system, matching this task's bounded scope. A full Home redesign (a real dashboard-shaped page with charts, sparklines, or a genuinely different information architecture) is a larger design exercise this task deliberately does not attempt; this closes the concrete "no path to action" complaint without inventing new visual language for a single page.

## 7. Catalog: SKU edit/archive, Vendor/Warehouse edit

**SKU.** `skus.status` (`active`/`inactive`) already exists in the schema and is already accepted by `createSku`, but `CatalogPage.tsx`'s SKU table doesn't display it and there's no way to change it after creation. `server/db.ts`'s `updateSku` was deleted as confirmed-dead code by the Engineering stream (zero callers at the time) — this task revives it with the same shape it had before deletion, now with real callers:
```ts
export async function updateSku(id: number, data: Partial<InsertSku>, dbClient: DbClient = db) {
  await dbClient.update(skus).set(data).where(eq(skus.id, id));
  const [row] = await dbClient.select().from(skus).where(eq(skus.id, id));
  return row;
}
```
Add a `catalog.updateSku` router procedure (editor-only, matching `createSku`'s access level) accepting `{ id, status?, leadTimeDays?, safetyStockDays? }` — scoped to exactly the 3 fields this task's UI needs to edit (status toggle, and the 2 new lead-time fields from section 5), not a general-purpose PATCH of every column; identifier fields (`sku`/`name`/etc.) stay create-only for now, since editing a live identifier has real downstream implications (it's the join key `identifierValue` is generated from) that are out of scope for this task. `CatalogPage.tsx`'s SKU table gains a Status column (with an active/inactive toggle button) and editable inputs for `leadTimeDays`/`safetyStockDays` per row.

**Vendor/Warehouse edit** (no archive — see Scope above for why). Add `catalog.updateVendor`/`catalog.updateWarehouse` router procedures and matching `updateVendor`/`updateWarehouse` functions in `server/db.ts` (same shape as `updateSku` above), covering: vendor `name`/`contactEmail`/`notes`; warehouse `code`/`name`. `CatalogPage.tsx`'s Vendor/Warehouse tables gain an inline edit control per row (an "Edit" button that turns the row's cells into inputs, or a always-visible inline form per row — implementer's choice, following whatever inline-edit pattern feels most consistent with this codebase's existing per-row edit controls, e.g. `ShipmentsPage.tsx`'s `PlannedDepartureControl` pattern of a form appearing next to a display value).

## Testing requirements

- Section 1 (SKU-id display): a test per file isn't meaningful here (this is UI label rendering, not business logic) — verify by reading the rendered output structure in each file's own existing test coverage if any exists, otherwise this is a visual-inspection item like other frontend-only changes in this codebase's history.
- Section 3 (status controls): add/adjust `server/shipments.test.ts` coverage is not needed (the backend already correctly rejects these transitions and is already tested — this task only changes what the *client* shows, not backend behavior). No new backend test required.
- Section 5 (reorder point): new tests in `server/dashboards.test.ts` for `getStockStatus`'s 4 status buckets using the new formula (a SKU with `daysOfCover` between `leadTimeDays` and `leadTimeDays+safetyStockDays` must read "low", not "critical" or "ok" — test the boundary values precisely), and a test that `getHomeSummary`'s stockout-risk count changes when a SKU's `leadTimeDays` changes but its `daysOfCover` doesn't (proving the per-SKU parameter is actually used, not just present). Migration needs the same pre-flight-check discipline as Backlog Stream J's migrations (check for existing rows, verify the migration applies cleanly to the dev DB, not just generates).
- Section 7 (Catalog edit): a test per new `update*` function in `server/db.test.ts` (create if it doesn't exist — check first) proving the update actually persists and a subsequent read reflects it, matching this codebase's existing test style for `createSku`/`createVendor`/`createWarehouse`.
