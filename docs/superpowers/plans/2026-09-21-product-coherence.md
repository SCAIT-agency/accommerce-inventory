# Product Coherence (Jobs lens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every bounded Product (Jobs-lens) finding from the three-lens architecture review: raw SKU-id display, Change Log reachability, guaranteed-to-fail shipment status controls, currency/date formatting, lead-time-aware stockout thresholds, an actionable Home page, and Catalog edit/archive.

**Architecture:** Six tasks against the existing `accommerce-inventory` codebase. Mostly frontend display-layer fixes plus one schema change (SKU lead-time/safety-stock columns) and its downstream stockout-status logic, plus reviving one previously-deleted backend function with new real callers.

**Tech Stack:** Node/Express + tRPC v11 + React + Drizzle ORM (MySQL/TiDB) + Vitest, same as the rest of the repo.

**Spec:** `docs/2026-09-21-product-coherence-design.md`

## Global Constraints

- Working directly on `main`, no worktree — same convention as every prior stream in this repo.
- Load env before any DB-touching command: `set -a && source .env && set +a`.
- `pnpm check` (`tsc --noEmit`) and `pnpm test` (`vitest run`) must both stay green after every task.
- Every schema change ships as a real migration, applied to the dev DB and verified there.
- Commit after each task: `type: summary`, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (uniform across this repo regardless of which model executes the task).
- Frontend-only changes in this plan have no meaningful automated test (label rendering, layout) — verify by reading the resulting JSX structure carefully, matching this codebase's existing bar for frontend-only changes elsewhere in its history.

---

### Task 1: Shared label helpers + replace raw SKU/warehouse-id display

**Files:**
- Create: `client/src/lib/labels.ts`
- Modify: `client/src/pages/MoneyPage.tsx` (adopt the shared helper, remove its own inline copy)
- Modify: `client/src/pages/StockPage.tsx` (adopt the shared `warehouseLabel`, remove its own inline map-building)
- Modify: `client/src/pages/ShipmentsPage.tsx` (add `catalog.listSkus` query, replace 3 raw-id spots)
- Modify: `client/src/pages/PurchaseOrdersPage.tsx` (replace 1 raw-id spot, reusing its existing `catalog.listSkus` query)
- Modify: `client/src/pages/InventoryLedgerPage.tsx` (add `catalog.listSkus`/`catalog.listWarehouses` queries, replace the raw-id header)

- [ ] **Step 1: Create `client/src/lib/labels.ts`**

```ts
// client/src/lib/labels.ts
export function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}

export function warehouseLabel(w: { id: number; code: string; name: string }): string {
  return `${w.code} — ${w.name}`;
}
```

- [ ] **Step 2: `MoneyPage.tsx` — adopt the shared helper**

Delete this file's own inline copy:
```ts
function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}
```
Add `import { skuLabel } from "../lib/labels";` near the top (alongside the existing `import { trpc } from "../lib/trpc";`). Then replace the Landed Cost tab's raw-id row:
```tsx
<tr key={row.skuId}><td>{row.skuId}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
```
with:
```tsx
<tr key={row.skuId}><td>{skuLabel(skusById.get(row.skuId) ?? { id: row.skuId })}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
```
This needs a `skusById` map built from the already-fetched `skusQuery.data` — add, near this file's other `useMemo`/derived-state (or plain `const`, matching whatever this file already does for similar lookups):
```ts
const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
```

- [ ] **Step 3: `StockPage.tsx` — adopt the shared `warehouseLabel`, delete the file's own inline map-building**

Replace:
```ts
const warehouseLabels = useMemo(() => {
  const map = new Map<number, string>();
  for (const w of warehousesQuery.data ?? []) map.set(w.id, `${w.code} — ${w.name}`);
  return map;
}, [warehousesQuery.data]);
```
with:
```ts
import { warehouseLabel } from "../lib/labels";
// ...
const warehouseLabels = useMemo(() => {
  const map = new Map<number, string>();
  for (const w of warehousesQuery.data ?? []) map.set(w.id, warehouseLabel(w));
  return map;
}, [warehousesQuery.data]);
```
(Add the import near this file's other imports; keep the `useMemo` wrapper and the map itself exactly as-is — only the label-building line changes, to now call the shared function instead of duplicating its format inline.)

- [ ] **Step 4: `ShipmentsPage.tsx` — add a SKU-label lookup, replace 3 raw-id spots**

Add near the top of the file: `import { skuLabel } from "../lib/labels";`.

This file has 3 separate components that each need SKU labels (`ShipmentRow`'s line-item list, `NewShipmentLineItemPicker`'s PO-line picker, and the new-shipment line-item summary — locate each by its exact current text below and confirm the surrounding component before editing, since the file has multiple similarly-shaped small components). Each needs its own `catalog.listSkus` query (React Query dedupes/caches identical queries across components automatically, so calling `trpc.catalog.listSkus.useQuery()` in more than one component in this file is not wasteful):

Replace (in the shipment line-item list, `data.lineItems.map`):
```tsx
<li key={li.id}>SKU {li.skuId} — qty {li.qty}</li>
```
with (add `const skusQuery = trpc.catalog.listSkus.useQuery();` and `const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));` to this component if not already present):
```tsx
<li key={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty}</li>
```

Replace (the PO-line picker's option labels):
```tsx
<option key={li.id} value={li.id}>SKU {li.skuId} — qty {li.qty} @ {li.unitPrice} {li.currency}</option>
```
with:
```tsx
<option key={li.id} value={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {li.unitPrice} {li.currency}</option>
```

Replace (the new-shipment line-item summary):
```tsx
SKU {li.skuId} — qty {li.qty} (weight {li.weightShare}, value {li.valueShare}){" "}
```
with:
```tsx
{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} (weight {li.weightShare}, value {li.valueShare}){" "}
```

Each of these 3 replacements is in a different component in this file — add the `catalog.listSkus` query and its `skusById` map to whichever specific component each snippet lives in (do not hoist to a single shared query unless the components already share props/context — follow this file's existing per-component data-fetching pattern).

- [ ] **Step 5: `PurchaseOrdersPage.tsx` — replace 1 raw-id spot using its existing `catalog.listSkus` query**

This file already fetches `catalog.listSkus` (in the create-PO line-item picker component). Find the component that renders:
```tsx
SKU {li.skuId} — qty {li.qty} @ {li.unitPrice} {li.currency}{" "}
```
and replace with (add `import { skuLabel } from "../lib/labels";` near the top; add a `catalog.listSkus` query + `skusById` map to this specific component if it doesn't already have access to one — check whether this component is the same one that already queries `catalog.listSkus`, or a sibling that needs its own):
```tsx
{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {li.unitPrice} {li.currency}{" "}
```

- [ ] **Step 6: `InventoryLedgerPage.tsx` — add SKU/warehouse name lookup, replace the raw-id header**

Replace the whole file:
```tsx
import { trpc } from "../lib/trpc";

export function InventoryLedgerPage({ skuId, warehouseId }: { skuId: number; warehouseId: number }) {
  const batchesQuery = trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId });

  if (batchesQuery.error) return <div>Failed to load batches: {batchesQuery.error.message}</div>;
  if (batchesQuery.isLoading || !batchesQuery.data) return <div>Loading…</div>;

  return (
    <div>
      <h1>Inventory Ledger — Batch Detail</h1>
      <p>SKU #{skuId}, warehouse #{warehouseId} — oldest batch first (the order units are actually consumed in).</p>
      <table>
        <thead><tr><th>Batch Date</th><th>Source</th><th>Unit Cost</th><th>Remaining Qty</th></tr></thead>
        <tbody>
          {batchesQuery.data.map((b, i) => (
            <tr key={i}>
              <td>{new Date(b.batchDate).toISOString().slice(0, 10)}</td>
              <td>{b.sourceRef ?? "—"}</td>
              <td>{b.unitCost.toFixed(4)}</td>
              <td>{b.remainingQty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {batchesQuery.data.length === 0 && <p>No remaining stock for this SKU/warehouse.</p>}
    </div>
  );
}
```
with:
```tsx
import { trpc } from "../lib/trpc";
import { skuLabel, warehouseLabel } from "../lib/labels";

export function InventoryLedgerPage({ skuId, warehouseId }: { skuId: number; warehouseId: number }) {
  const batchesQuery = trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId });
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();

  const error = batchesQuery.error ?? skusQuery.error ?? warehousesQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = batchesQuery.isLoading || skusQuery.isLoading || warehousesQuery.isLoading;
  if (isLoading || !batchesQuery.data) return <div>Loading…</div>;

  const sku = (skusQuery.data ?? []).find((s) => s.id === skuId);
  const warehouse = (warehousesQuery.data ?? []).find((w) => w.id === warehouseId);

  return (
    <div>
      <h1>Inventory Ledger — Batch Detail</h1>
      <p>
        {skuLabel(sku ?? { id: skuId })}, {warehouse ? warehouseLabel(warehouse) : `warehouse #${warehouseId}`}
        {" "}— oldest batch first (the order units are actually consumed in).
      </p>
      <table>
        <thead><tr><th>Batch Date</th><th>Source</th><th>Unit Cost</th><th>Remaining Qty</th></tr></thead>
        <tbody>
          {batchesQuery.data.map((b, i) => (
            <tr key={i}>
              <td>{new Date(b.batchDate).toISOString().slice(0, 10)}</td>
              <td>{b.sourceRef ?? "—"}</td>
              <td>{b.unitCost.toFixed(4)}</td>
              <td>{b.remainingQty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {batchesQuery.data.length === 0 && <p>No remaining stock for this SKU/warehouse.</p>}
    </div>
  );
}
```

- [ ] **Step 7: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass unchanged (this task adds no tests and changes no backend behavior — pure display-layer fix), `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/labels.ts client/src/pages/MoneyPage.tsx client/src/pages/StockPage.tsx client/src/pages/ShipmentsPage.tsx client/src/pages/PurchaseOrdersPage.tsx client/src/pages/InventoryLedgerPage.tsx
git commit -m "fix: replace raw SKU/warehouse-id display with real names everywhere

Shipments, Purchase Orders, Money's Landed Cost tab, and the Inventory
Ledger drill-down all displayed a bare numeric id (SKU #17) despite
catalog.listSkus already being fetched on several of these pages for other
purposes. Extracts the SKU/warehouse label logic StockPage and MoneyPage
had each independently reinvented into one shared client/src/lib/labels.ts,
and applies it everywhere a raw id was still shown.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Currency symbols and date-format standardization

**Files:**
- Modify: `client/src/lib/labels.ts` (add `formatMoney`)
- Modify: `client/src/pages/PurchaseOrdersPage.tsx` (currency symbols on payment/PO-line display; 3 `.toString()` date fixes)
- Modify: `client/src/pages/ShipmentsPage.tsx` (currency symbols on the 2 spots touched in Task 1)
- Modify: `client/src/pages/TransactionsPage.tsx` (currency symbols on transaction rows and the matching picker)
- Modify: `client/src/pages/ChangeLogPage.tsx` (1 `.toString()` date fix)

**Interfaces:**
- Consumes: `client/src/lib/labels.ts` from Task 1 (this task adds to the same file rather than creating a new one).

- [ ] **Step 1: Add `formatMoney` to `client/src/lib/labels.ts`**

```ts
const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CNY: "¥", GBP: "£" };

export function formatMoney(amount: string | number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase() + " ";
  const value = typeof amount === "string" ? amount : amount.toFixed(2);
  return `${symbol}${value}`;
}
```
(This file is misnamed slightly for holding a money formatter too, but per the design doc this stays in `labels.ts` rather than a new file — both are small display-formatting helpers with no other home in this codebase yet.)

- [ ] **Step 2: `PurchaseOrdersPage.tsx` — apply `formatMoney`, fix 3 `.toString()` dates**

Add `formatMoney` to this file's `import { skuLabel } from "../lib/labels";` line (from Task 1) so it reads `import { skuLabel, formatMoney } from "../lib/labels";`.

Replace:
```tsx
Payment #{payment.sequenceNo}: paid {payment.paidAmount} {payment.currency} on {payment.paidDate?.toString()}
```
with:
```tsx
Payment #{payment.sequenceNo}: paid {formatMoney(payment.paidAmount!, payment.currency)} on {payment.paidDate ? new Date(payment.paidDate).toISOString().slice(0, 10) : "—"}
```

Replace:
```tsx
Payment #{payment.sequenceNo}: expected {payment.expectedAmount} {payment.currency} on {payment.expectedDate.toString()}
```
with:
```tsx
Payment #{payment.sequenceNo}: expected {formatMoney(payment.expectedAmount, payment.currency)} on {new Date(payment.expectedDate).toISOString().slice(0, 10)}
```

Replace:
```tsx
<td>{po.plannedReadyDate?.toString() ?? "—"}</td>
```
with:
```tsx
<td>{po.plannedReadyDate ? new Date(po.plannedReadyDate).toISOString().slice(0, 10) : "—"}</td>
```

Also apply `formatMoney` to the PO line-item summary this file renders (found in Task 1's Step 5 — the same line that now calls `skuLabel`):
```tsx
{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {li.unitPrice} {li.currency}{" "}
```
becomes:
```tsx
{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {formatMoney(li.unitPrice, li.currency)}{" "}
```

- [ ] **Step 3: `ShipmentsPage.tsx` — apply `formatMoney`**

Add `formatMoney` to this file's `import { skuLabel } from "../lib/labels";` line (from Task 1).

The PO-line picker's option label (already touched in Task 1):
```tsx
<option key={li.id} value={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {li.unitPrice} {li.currency}</option>
```
becomes:
```tsx
<option key={li.id} value={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {formatMoney(li.unitPrice, li.currency)}</option>
```

- [ ] **Step 4: `TransactionsPage.tsx` — apply `formatMoney`**

Add `import { formatMoney } from "../lib/labels";` near the top.

Find the transaction-row rendering (`<td>{tx.amount} {tx.currency}</td>` or similar — read the file first to find the exact current text) and the matching-picker's option labels (`{p.expectedAmount} {p.currency}` or similar), and replace each `{amount} {currency}` pair with `{formatMoney(amount, currency)}`.

- [ ] **Step 5: `ChangeLogPage.tsx` — fix the 1 `.toString()` date**

Replace:
```tsx
<td>{e.changedAt.toString()}</td>
```
with:
```tsx
<td>{new Date(e.changedAt).toISOString().slice(0, 10)}</td>
```

- [ ] **Step 6: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass unchanged, `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/labels.ts client/src/pages/PurchaseOrdersPage.tsx client/src/pages/ShipmentsPage.tsx client/src/pages/TransactionsPage.tsx client/src/pages/ChangeLogPage.tsx
git commit -m "fix: currency symbols and consistent date formatting across the UI

Money was displayed as a bare amount plus a 3-letter currency code
everywhere, never a symbol; and dates rendered inconsistently -- most of
the app already used a clean YYYY-MM-DD (.toISOString().slice(0, 10)), but
Purchase Orders and Change Log used a raw Date.toString() (verbose, with a
full weekday/timezone string). Adds a shared formatMoney helper and
standardizes every remaining date display on the dominant existing
convention.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Change Log reachability + guaranteed-to-fail shipment status controls

**Files:**
- Modify: `client/src/pages/PurchaseOrdersPage.tsx` (add a Change Log link)
- Modify: `client/src/pages/ShipmentsPage.tsx` (add a Change Log link; fix `StatusTransitionControl` and `CustomsArrivalControl`)

- [ ] **Step 1: `PurchaseOrdersPage.tsx` — add a Change Log link**

Add `import { Link } from "react-router-dom";` near the top if not already present (check first — this file may not currently import it).

In the Status column (where `AdvanceStatusControl` already renders, from a prior stream), add a link:
```tsx
<td>
  <span className={PO_STATUS_BADGE_CLASS[po.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{po.status}</span>
  <AdvanceStatusControl po={po} onAdvanced={refetch} />
  <div><Link to={`/change-log/purchase_order/${po.id}`}>History</Link></div>
</td>
```
(Locate the real current JSX for this cell first — it was last touched in the Operational-cleanup stream to add `AdvanceStatusControl`; add the `Link` alongside it without disturbing the existing structure.)

- [ ] **Step 2: `ShipmentsPage.tsx` — fix `StatusTransitionControl`**

Find:
```ts
const nextStatuses = VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? [];
```
Replace with:
```ts
// "departed" and "delivered" always have a dedicated control (PlannedDepartureControl's
// "Mark departed" button, CustomsArrivalControl's "Save arrival date" button) --
// offering them here too would render a working-looking option that
// updateShipmentStatus (server/shipments.ts) unconditionally rejects.
const nextStatuses = (VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? []).filter(
  (s) => s !== "departed" && s !== "delivered",
);
```

- [ ] **Step 3: `ShipmentsPage.tsx` — gate `CustomsArrivalControl`'s arrival button**

Find the "Save arrival date" button in `CustomsArrivalControl`:
```tsx
<button
  disabled={!canSave || !form.actualArrivalDate || markArrived.isPending}
  onClick={() =>
    markArrived.mutate({
      id: shipment.id,
      actualArrivalDate: new Date(form.actualArrivalDate),
      reasonCategory: form.reasonCategory,
      reasonNote: noteRequired ? form.reasonNote : undefined,
    })
  }
>
  Save arrival date
</button>
```
Replace with:
```tsx
<button
  disabled={!canSave || !form.actualArrivalDate || shipment.status !== "customs" || markArrived.isPending}
  onClick={() =>
    markArrived.mutate({
      id: shipment.id,
      actualArrivalDate: new Date(form.actualArrivalDate),
      reasonCategory: form.reasonCategory,
      reasonNote: noteRequired ? form.reasonNote : undefined,
    })
  }
>
  Save arrival date
</button>
{shipment.status !== "customs" && <p>Available once the shipment has reached customs.</p>}
```

- [ ] **Step 4: `ShipmentsPage.tsx` — add a Change Log link to the Status cell**

Add `import { Link } from "react-router-dom";` near the top if not already present.

In `ShipmentRow`'s Status cell (where `PlannedDepartureControl`/`StatusTransitionControl`/`CustomsArrivalControl`/`DepartDateCorrectionControl` are already stacked), add one more line:
```tsx
<td>
  <span className={SHIPMENT_STATUS_BADGE_CLASS[shipment.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.status}</span>
  <div style={{ marginTop: "8px" }}>
    <PlannedDepartureControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
  </div>
  <div style={{ marginTop: "8px" }}>
    <StatusTransitionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
  </div>
  <div style={{ marginTop: "8px" }}>
    <CustomsArrivalControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
  </div>
  <div style={{ marginTop: "8px" }}>
    <DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
  </div>
  <div style={{ marginTop: "8px" }}><Link to={`/change-log/shipment/${shipment.id}`}>History</Link></div>
</td>
```
(This is the exact existing structure with one new `<div>` appended — do not otherwise restructure this cell; Steps 2-3 above are what actually reduce how many of the 4 controls render/enable at once for any given shipment.)

- [ ] **Step 5: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass unchanged (no backend behavior changed — `updateShipmentStatus`/`markShipmentArrived` were already correctly rejecting these cases; this task only changes what the client offers/allows), `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PurchaseOrdersPage.tsx client/src/pages/ShipmentsPage.tsx
git commit -m "fix: reachable Change Log links + guaranteed-to-fail shipment status controls

The shared /change-log/:entityType/:entityId route had no link anywhere
pointing to it. Separately, ShipmentsPage's StatusTransitionControl offered
'advance to departed'/'advance to delivered' options that
updateShipmentStatus unconditionally rejects (those transitions have
dedicated controls elsewhere in the same cell) -- the same bug class the
prior review flagged for CustomsArrivalControl's always-enabled arrival
button, independently present here for two more status values. Filters
StatusTransitionControl's offered transitions and gates the arrival button
on the shipment actually being in customs status.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Lead-time-aware stockout risk

**Files:**
- Modify: `drizzle/schema.ts` (`skus.leadTimeDays`, `skus.safetyStockDays`)
- Create: a new migration under `drizzle/` (via `drizzle-kit generate`)
- Modify: `server/dashboards.ts` (`getStockStatus`, `getStockDashboard`, `getHomeSummary`)
- Test: `server/dashboards.test.ts`

- [ ] **Step 1: Add the 2 columns to `drizzle/schema.ts`**

In the `skus` table definition, add (after `isBundle`, before `createdAt` — or wherever fits the existing column grouping):
```ts
leadTimeDays: int("leadTimeDays").default(66).notNull(),
safetyStockDays: int("safetyStockDays").default(14).notNull(),
```
(66/14 match this business's real known replenishment lead time and safety-stock buffer — every existing/new SKU gets a sane default with no manual entry required, while staying editable per SKU via Task 6's Catalog edit form.)

- [ ] **Step 2: Generate and apply the migration**

Run: `set -a && source .env && set +a && pnpm exec drizzle-kit generate`
Read the generated SQL — confirm it's exactly one `ALTER TABLE skus ADD COLUMN leadTimeDays ... DEFAULT 66 NOT NULL` and one equivalent for `safetyStockDays`, nothing else (a default value on a new NOT NULL column backfills every existing row automatically — this cannot fail on existing data the way Backlog Stream J's FK/decimal migrations could).

Run: `pnpm exec drizzle-kit migrate`
Expected: succeeds with no error.

- [ ] **Step 3: Rewrite `getStockStatus` in `server/dashboards.ts`**

Replace:
```ts
// In-code lookup for V1; move to app_settings-driven config when a real
// client needs to tune these thresholds — out of scope for this task.
const STOCK_STATUS_THRESHOLDS: { maxDays: number; label: "critical" | "low" | "ok" | "overstock" }[] = [
  { maxDays: 21, label: "critical" },
  { maxDays: 45, label: "low" },
  { maxDays: 90, label: "ok" },
  { maxDays: Infinity, label: "overstock" },
];
```
and:
```ts
function getStockStatus(daysOfCover: number | null): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const bucket = STOCK_STATUS_THRESHOLDS.find((t) => daysOfCover < t.maxDays);
  return bucket?.label ?? "overstock";
}
```
with:
```ts
// Reorder point = leadTimeDays + safetyStockDays: the days of cover below
// which a fresh order can no longer arrive before stock runs out, plus the
// buffer this business already plans around. Per-SKU rather than a fixed
// bucket, since different SKUs can have genuinely different vendor lead
// times (skus.leadTimeDays/safetyStockDays, editable per SKU in Catalog).
function getStockStatus(daysOfCover: number | null, leadTimeDays: number, safetyStockDays: number): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const reorderPoint = leadTimeDays + safetyStockDays;
  if (daysOfCover < leadTimeDays) return "critical";
  if (daysOfCover < reorderPoint) return "low";
  if (daysOfCover < reorderPoint * 3) return "ok";
  return "overstock";
}
```

- [ ] **Step 4: Update `getStockDashboard`'s call site**

Find where `getStockStatus` is called inside `getStockDashboard` (it currently passes only `daysOfCover`). Update the call to also pass the SKU's own `leadTimeDays`/`safetyStockDays` — `activeSkus` (from `listSkus("active")`) already carries both fields once Step 1's migration lands, so this is a matter of passing `sku.leadTimeDays, sku.safetyStockDays` alongside the existing `daysOfCover` argument at the call site (read the current call site's exact code first — its surrounding variable names determine the exact edit).

- [ ] **Step 5: Update `getHomeSummary`'s stockout-risk check**

Find:
```ts
if (daysOfCover !== null && daysOfCover < 21) {
  atRisk = true;
  break;
}
```
Replace with:
```ts
if (daysOfCover !== null && daysOfCover < sku.leadTimeDays + sku.safetyStockDays) {
  atRisk = true;
  break;
}
```
(`sku` is the outer loop variable already in scope — `for (const sku of activeSkus)` — confirm the exact variable name at this call site before editing; it may already be named `sku` per the existing code's structure from prior streams.)

- [ ] **Step 6: Add tests to `server/dashboards.test.ts`**

```ts
it("getStockDashboard classifies stockout status using each SKU's own lead time and safety stock, not a fixed threshold", async () => {
  const shortLeadSku = await createSku({ sku: "JELLO-SHORT-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 14, safetyStockDays: 7 });
  const longLeadSku = await createSku({ sku: "JELLO-LONG-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 66, safetyStockDays: 14 });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  // Both SKUs get identical SOH/sales history: 30 days of cover.
  for (const sku of [shortLeadSku, longLeadSku]) {
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO1" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
    }
  }
  // Both SOH ~= 0 after 30 days of 10/day sales against 300 received -- use a
  // fresh receipt today so daysOfCover reads a clean ~30 for both.
  await recordLedgerEvent({ skuId: shortLeadSku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });
  await recordLedgerEvent({ skuId: longLeadSku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });

  const stock = await getStockDashboard();
  const shortRow = stock.find((r) => r.skuId === shortLeadSku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);
  const longRow = stock.find((r) => r.skuId === longLeadSku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);

  // ~30 days of cover: above shortLeadSku's reorder point (14+7=21) -> "ok".
  // Below longLeadSku's own lead time (66) -> "critical".
  expect(shortRow?.status).toBe("ok");
  expect(longRow?.status).toBe("critical");
});

it("getHomeSummary's stockout-risk count uses each SKU's own reorder point, not a fixed 21-day cutoff", async () => {
  const sku = await createSku({ sku: "JELLO-CUSTOM-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 40, safetyStockDays: 10 });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO1" });
  for (let i = 0; i < 30; i++) {
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
  }
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });
  // getAverageDailySalesForSkus divides by a fixed 30-day window regardless
  // of how many of those days actually had a sale: 30 days x 10/day = 300
  // total qty -> avgDailySales = 300/30 = 10 exactly. The fresh receipt
  // brings SOH back to exactly 300, so daysOfCover = 300/10 = 30 exactly --
  // below this SKU's reorder point (40+10=50) -> at risk, even though 30 is
  // comfortably above the old fixed 21-day cutoff that code no longer exists.
  const summary = await getHomeSummary();
  expect(summary.stockoutRiskSkuCount).toBe(1);
});
```
(Verify `createSku`'s real signature accepts `leadTimeDays`/`safetyStockDays` directly — it should, since these are now plain columns on the `skus` table and `createSku` takes `Omit<InsertSku, "id">`; confirm by reading `server/db.ts`'s current `createSku` before finalizing this test.)

- [ ] **Step 7: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass including the 2 new tests, `tsc --noEmit` clean. If any EXISTING stockout-risk test's expected value assumed the old fixed 21/45/90 thresholds and now fails against the new default 66/14 reorder point, that is an expected consequence of this task, not a regression — update that test's expected value to match the new, correct behavior (do not revert the logic to make an old assumption pass).

- [ ] **Step 8: Commit**

```bash
git add drizzle/schema.ts drizzle/ server/dashboards.ts server/dashboards.test.ts
git commit -m "fix: replace fixed 21/45/90-day stockout thresholds with a per-SKU reorder point

The fixed thresholds had no relationship to this business's real ~66-day
replenishment lead time -- a SKU already too late to reorder read as merely
'low'. Adds skus.leadTimeDays/safetyStockDays (defaulting to Jello's real
known 66/14-day cycle, editable per SKU), and computes stockout status as
days-of-cover relative to each SKU's own reorder point (leadTimeDays +
safetyStockDays) instead of a business-agnostic bucket list.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Home page — actionable links

**Files:**
- Modify: `client/src/pages/HomePage.tsx`

- [ ] **Step 1: Wrap each stat in a link to where it can be acted on**

Replace the current file:
```tsx
import { trpc } from "../lib/trpc";

export function HomePage() {
  const { data, isLoading, error } = trpc.dashboards.home.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <div>
      <h1>Home</h1>
      <dl>
        <dt>Active SKUs</dt><dd>{data.activeSkuCount}</dd>
        <dt>Stockout-risk SKUs</dt><dd>{data.stockoutRiskSkuCount}</dd>
        <dt>Near-term cash needs (14d)</dt><dd>{data.nearTermCashNeeds.toFixed(2)}</dd>
        <dt>Overdue payables</dt><dd>{data.overduePayablesIsEstimated ? "≈ " : ""}{data.overduePayablesAmount.toFixed(2)}</dd>
        <dt>Unmatched transactions</dt><dd>{data.unmatchedTransactionCount}</dd>
      </dl>
    </div>
  );
}
```
with:
```tsx
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";

export function HomePage() {
  const { data, isLoading, error } = trpc.dashboards.home.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <div>
      <h1>Home</h1>
      <dl>
        <dt><Link to="/catalog">Active SKUs</Link></dt><dd>{data.activeSkuCount}</dd>
        <dt><Link to="/stock">Stockout-risk SKUs</Link></dt><dd>{data.stockoutRiskSkuCount}</dd>
        <dt><Link to="/money">Near-term cash needs (14d)</Link></dt><dd>{data.nearTermCashNeeds.toFixed(2)}</dd>
        <dt><Link to="/money">Overdue payables</Link></dt><dd>{data.overduePayablesIsEstimated ? "≈ " : ""}{data.overduePayablesAmount.toFixed(2)}</dd>
        <dt><Link to="/transactions">Unmatched transactions</Link></dt><dd>{data.unmatchedTransactionCount}</dd>
      </dl>
    </div>
  );
}
```

- [ ] **Step 2: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass unchanged, `tsc --noEmit` clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/HomePage.tsx
git commit -m "fix: make Home page stats clickable, linking to where they can be acted on

4 stats with no path to action -- each now links to the page where that
number's underlying data actually lives and can be worked (Catalog, Stock,
Cost & Cashflow, Transactions).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Catalog edit/archive (SKU) + edit (Vendor, Warehouse)

**Files:**
- Modify: `server/db.ts` (revive `updateSku`, add `updateVendor`, `updateWarehouse`)
- Modify: `server/routers.ts` (add `catalog.updateSku`/`updateVendor`/`updateWarehouse`)
- Modify: `client/src/pages/CatalogPage.tsx` (SKU status toggle + lead-time/safety-stock edit inputs; Vendor/Warehouse edit controls)
- Test: `server/db.test.ts`

**Interfaces:**
- Consumes: `skus.leadTimeDays`/`safetyStockDays` from Task 4.

- [ ] **Step 1: Revive `updateSku`, add `updateVendor`/`updateWarehouse` in `server/db.ts`**

Add (matching `createSku`'s existing shape exactly):
```ts
export async function updateSku(id: number, data: Partial<InsertSku>, dbClient: DbClient = db) {
  await dbClient.update(skus).set(data).where(eq(skus.id, id));
  const [row] = await dbClient.select().from(skus).where(eq(skus.id, id));
  return row;
}

export async function updateVendor(id: number, data: Partial<InsertVendor>, dbClient: DbClient = db) {
  await dbClient.update(vendors).set(data).where(eq(vendors.id, id));
  const [row] = await dbClient.select().from(vendors).where(eq(vendors.id, id));
  return row;
}

export async function updateWarehouse(id: number, data: Partial<InsertWarehouse>, dbClient: DbClient = db) {
  await dbClient.update(warehouses).set(data).where(eq(warehouses.id, id));
  const [row] = await dbClient.select().from(warehouses).where(eq(warehouses.id, id));
  return row;
}
```
(`InsertVendor`/`InsertWarehouse` should already be imported in this file — confirm; `skus`/`vendors`/`warehouses` table objects should already be imported too.)

- [ ] **Step 2: Add router procedures in `server/routers.ts`**

In the `catalog: router({...})` block, add:
```ts
updateSku: editorProcedure
  .input(z.object({
    id: z.number(),
    status: z.enum(["active", "inactive"]).optional(),
    leadTimeDays: z.number().int().positive().optional(),
    safetyStockDays: z.number().int().min(0).optional(),
  }))
  .mutation(({ input }) => updateSku(input.id, { status: input.status, leadTimeDays: input.leadTimeDays, safetyStockDays: input.safetyStockDays })),
updateVendor: editorProcedure
  .input(z.object({ id: z.number(), name: z.string().optional(), contactEmail: z.string().optional(), notes: z.string().optional() }))
  .mutation(({ input }) => updateVendor(input.id, { name: input.name, contactEmail: input.contactEmail, notes: input.notes })),
updateWarehouse: editorProcedure
  .input(z.object({ id: z.number(), code: z.string().optional(), name: z.string().optional() }))
  .mutation(({ input }) => updateWarehouse(input.id, { code: input.code, name: input.name })),
```
Add `updateSku, updateVendor, updateWarehouse` to this file's existing `import { listSkus, createSku, listVendors, createVendor, listWarehouses, createWarehouse } from "./db";` line.

- [ ] **Step 3: `CatalogPage.tsx` — SKU status toggle + lead-time/safety-stock edit**

In `SkusSection`, add a Status column and per-row edit controls. Replace:
```tsx
<table>
  <thead><tr><th>SKU</th><th>Name</th><th>Identifier Type</th></tr></thead>
  <tbody>
    {(skusQuery.data ?? []).map((s) => (
      <tr key={s.id}><td>{s.sku ?? "—"}</td><td>{s.name ?? "—"}</td><td>{s.primaryIdentifierType}</td></tr>
    ))}
  </tbody>
</table>
```
with:
```tsx
<table>
  <thead><tr><th>SKU</th><th>Name</th><th>Identifier Type</th><th>Status</th><th>Lead Time (days)</th><th>Safety Stock (days)</th></tr></thead>
  <tbody>
    {(skusQuery.data ?? []).map((s) => <SkuRow key={s.id} sku={s} onUpdated={() => utils.catalog.listSkus.invalidate()} />)}
  </tbody>
</table>
```
Add a new `SkuRow` component in this file (near `SkusSection`, before it or after — follow this file's existing top-to-bottom component ordering):
```tsx
function SkuRow({ sku, onUpdated }: { sku: { id: number; sku: string | null; name: string | null; primaryIdentifierType: string; status: "active" | "inactive"; leadTimeDays: number; safetyStockDays: number }; onUpdated: () => void }) {
  const [leadTimeDays, setLeadTimeDays] = useState(String(sku.leadTimeDays));
  const [safetyStockDays, setSafetyStockDays] = useState(String(sku.safetyStockDays));
  const updateSku = trpc.catalog.updateSku.useMutation({ onSuccess: onUpdated });

  return (
    <tr>
      <td>{sku.sku ?? "—"}</td>
      <td>{sku.name ?? "—"}</td>
      <td>{sku.primaryIdentifierType}</td>
      <td>
        <button
          disabled={updateSku.isPending}
          onClick={() => updateSku.mutate({ id: sku.id, status: sku.status === "active" ? "inactive" : "active" })}
        >
          {sku.status}
        </button>
      </td>
      <td>
        <input type="number" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} style={{ width: "4em" }} />
        <button disabled={updateSku.isPending} onClick={() => updateSku.mutate({ id: sku.id, leadTimeDays: Number(leadTimeDays) })}>Save</button>
      </td>
      <td>
        <input type="number" value={safetyStockDays} onChange={(e) => setSafetyStockDays(e.target.value)} style={{ width: "4em" }} />
        <button disabled={updateSku.isPending} onClick={() => updateSku.mutate({ id: sku.id, safetyStockDays: Number(safetyStockDays) })}>Save</button>
      </td>
      {updateSku.error && <td>Failed: {updateSku.error.message}</td>}
    </tr>
  );
}
```
Add `const utils = trpc.useUtils();` to `SkusSection` if it doesn't already have one (check first — it likely already does, for `createSku`'s `onSuccess`).

- [ ] **Step 4: `CatalogPage.tsx` — Vendor edit**

In `VendorsSection`, replace:
```tsx
<table>
  <thead><tr><th>Name</th></tr></thead>
  <tbody>
    {(vendorsQuery.data ?? []).map((v) => (<tr key={v.id}><td>{v.name}</td></tr>))}
  </tbody>
</table>
```
with:
```tsx
<table>
  <thead><tr><th>Name</th><th>Contact Email</th></tr></thead>
  <tbody>
    {(vendorsQuery.data ?? []).map((v) => <VendorRow key={v.id} vendor={v} onUpdated={() => utils.catalog.listVendors.invalidate()} />)}
  </tbody>
</table>
```
Add:
```tsx
function VendorRow({ vendor, onUpdated }: { vendor: { id: number; name: string; contactEmail: string | null }; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vendor.name);
  const [contactEmail, setContactEmail] = useState(vendor.contactEmail ?? "");
  const updateVendor = trpc.catalog.updateVendor.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });

  if (!editing) {
    return (
      <tr>
        <td>{vendor.name}</td>
        <td>{vendor.contactEmail ?? "—"}</td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></td>
      <td>
        <button disabled={updateVendor.isPending} onClick={() => updateVendor.mutate({ id: vendor.id, name, contactEmail: contactEmail || undefined })}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        {updateVendor.error && <div>Failed: {updateVendor.error.message}</div>}
      </td>
    </tr>
  );
}
```

- [ ] **Step 5: `CatalogPage.tsx` — Warehouse edit**

In `WarehousesSection`, replace:
```tsx
<table>
  <thead><tr><th>Code</th><th>Name</th></tr></thead>
  <tbody>
    {(warehousesQuery.data ?? []).map((w) => (<tr key={w.id}><td>{w.code}</td><td>{w.name}</td></tr>))}
  </tbody>
</table>
```
with:
```tsx
<table>
  <thead><tr><th>Code</th><th>Name</th></tr></thead>
  <tbody>
    {(warehousesQuery.data ?? []).map((w) => <WarehouseRow key={w.id} warehouse={w} onUpdated={() => utils.catalog.listWarehouses.invalidate()} />)}
  </tbody>
</table>
```
Add (same pattern as `VendorRow`):
```tsx
function WarehouseRow({ warehouse, onUpdated }: { warehouse: { id: number; code: string; name: string }; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(warehouse.code);
  const [name, setName] = useState(warehouse.name);
  const updateWarehouse = trpc.catalog.updateWarehouse.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });

  if (!editing) {
    return (
      <tr>
        <td>{warehouse.code}</td>
        <td>{warehouse.name}</td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={code} onChange={(e) => setCode(e.target.value)} /></td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td>
        <button disabled={updateWarehouse.isPending} onClick={() => updateWarehouse.mutate({ id: warehouse.id, code, name })}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        {updateWarehouse.error && <div>Failed: {updateWarehouse.error.message}</div>}
      </td>
    </tr>
  );
}
```
Both `VendorsSection` and `WarehousesSection` need `const utils = trpc.useUtils();` added if not already present (check first — likely already have one from their own `createVendor`/`createWarehouse` mutations).

- [ ] **Step 6: Add tests to `server/db.test.ts`**

```ts
it("updateSku persists a status/lead-time/safety-stock change", async () => {
  const sku = await createSku({ sku: "JELLO-UPDATE-TEST", primaryIdentifierType: "sku", status: "active" });
  const updated = await updateSku(sku.id, { status: "inactive", leadTimeDays: 30, safetyStockDays: 5 });
  expect(updated.status).toBe("inactive");
  expect(updated.leadTimeDays).toBe(30);
  expect(updated.safetyStockDays).toBe(5);
});

it("updateVendor persists a name/contact-email change", async () => {
  const vendor = await createVendor({ name: "Old Name" });
  const updated = await updateVendor(vendor.id, { name: "New Name", contactEmail: "new@example.com" });
  expect(updated.name).toBe("New Name");
  expect(updated.contactEmail).toBe("new@example.com");
});

it("updateWarehouse persists a code/name change", async () => {
  const warehouse = await createWarehouse({ code: "OLD-CODE", name: "Old Name" });
  const updated = await updateWarehouse(warehouse.id, { code: "NEW-CODE", name: "New Name" });
  expect(updated.code).toBe("NEW-CODE");
  expect(updated.name).toBe("New Name");
});
```
Add `updateSku, updateVendor, updateWarehouse` to this file's existing `import { createSku, listSkus, createVendor, createWarehouse, setAppSetting, getAppSetting } from "./db";` line.

- [ ] **Step 7: Run the full suite and type check**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass including the 3 new tests, `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add server/db.ts server/routers.ts server/db.test.ts client/src/pages/CatalogPage.tsx
git commit -m "feat: Catalog edit for SKU (status/lead-time/safety-stock), Vendor, Warehouse

SKU/Vendor/Warehouse could be created but never edited or archived.
Revives updateSku (deleted as dead code by the prior Engineering stream,
now with real callers) with the fields this task's UI needs, and adds
matching updateVendor/updateWarehouse. SKU archiving uses the status field
that already existed on the schema but had no UI toggle. Vendor/warehouse
archiving is deliberately out of scope -- neither table has a status
column today, and what 'archived' should mean for an entity with existing
POs/shipments is a real product question, not a bounded fix.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Review

After all 6 tasks: dispatch the final whole-branch code reviewer (most capable available model) against the full diff from this stream's first commit to its last, per this project's established subagent-driven-development process. Pay special attention to: (1) whether Task 3's `StatusTransitionControl` filter and `CustomsArrivalControl` gate actually eliminate every guaranteed-to-fail path for every shipment status, not just the two named — re-trace all 5 statuses (`planned`, `departed`, `in_transit`, `customs`, `delivered`) against the final code; (2) whether Task 4's reorder-point migration and logic change broke any existing dashboard test that assumed the old fixed thresholds, beyond the ones this plan anticipated; (3) whether Task 6's new `catalog.updateSku` procedure's Zod schema could let a caller silently no-op an update by omitting all 3 optional fields, and whether that's actually fine (a caller with nothing to change shouldn't need special-casing) or worth a `.refine()` requiring at least one field, matching this codebase's existing `.refine()` precedent on `createSku`. Update `docs/BACKLOG.md` (mark Product/Jobs items done, noting the deferred vendor/warehouse-archive item), `docs/BUILD-HISTORY.md` (new Stream K narrative section), and `README.md`'s Current Status, matching every prior stream's close-out convention, then push per the established `gh auth switch` dance.
