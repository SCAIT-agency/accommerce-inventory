# Wiring Completion (Backlog Stream A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose seven pieces of already-built-and-tested backend logic (plus close two small logic/consistency gaps found while designing this) through real router procedures and minimal UI, so nothing tested in this codebase remains structurally unreachable by an actual user.

**Architecture:** Each task pairs one small backend addition (a new function, or a signature extension on an existing one) with the router procedure(s) that expose it and the UI element that calls it — the same "backend + router + UI" task shape used throughout this codebase's build history. No new subsystems; every task either wires an existing tested function to the app for the first time, or adds one small write/read function following an exactly-precedented existing pattern (e.g. `setShipmentCustomsStatus` mirrors `recordShipmentCosts`'s shape).

**Tech Stack:** TypeScript, Express + tRPC v11, Drizzle ORM (MySQL dialect), React + `@tanstack/react-query` (via tRPC's client), Vitest — same stack as the rest of this repo, no new dependencies.

**Spec:** `/Users/artem/Claude v 1.0/accommerce-inventory/docs/2026-09-19-wiring-completion-design.md`

## Global Constraints

- Every new mutating server function that changes an existing record's delay- or cost-affecting field must call `logChange` with the field's real prior value — never a hardcoded placeholder. A creation-time value (a brand-new row) does not need an audit trail; only a change to an existing row does.
- Every new procedure requiring a reason category uses the existing shared `reasonCategorySchema = z.enum(REASON_CATEGORIES)` already defined in `server/routers.ts` — never a fresh `z.string()`.
- Mutating procedures are `editorProcedure`; read-only procedures are `protectedProcedure` — matching every existing procedure in `server/routers.ts`, no new access-control pattern.
- Every new write function threads an optional `dbClient: DbClient = db` parameter (import `type { DbClient }` from `./dbClient`), matching the convention every write function in this codebase already follows since Stream B.
- `correctShipmentActualDepartDate` must throw if the shipment's current `actualDepartDate` is `null` — it is a correction path, not a way to set the first depart date without going through the transition-validated flow.
- No new page layouts or redesigns — each UI addition extends an existing page's existing table/section using that page's own established patterns (local `useState` for form state, `trpc.<router>.<name>.useMutation`/`useQuery`, a `REASON_CATEGORIES` array literal duplicated per-file exactly as `ShipmentsPage.tsx`/`PurchaseOrdersPage.tsx` already do — this repo does not currently share that constant between client files, and fixing that is an unrelated, already-tracked cleanup item, not part of this plan).
- No automated/fuzzy transaction-to-payment matching — a plain manual dropdown pick only.
- A local dev database is running (`DATABASE_URL=mysql://root:devpassword@localhost:3306/accommerce_dev`; source `.env` with `set -a && source .env && set +a` before any direct `pnpm`/`node` command). Run the suite with `pnpm test`.

---

## File Structure

```
accommerce-inventory/
  server/
    salesPlan.ts              # MODIFY: add createSalesPlanEntry
    salesPlan.test.ts          # MODIFY: add its tests
    shipments.ts                # MODIFY: extend updateShipmentStatus; add
                                 #         setShipmentCustomsStatus, markShipmentArrived,
                                 #         correctShipmentActualDepartDate
    shipments.test.ts            # MODIFY: add their tests
    payments.ts                   # MODIFY: add listPaymentsForPo, listUnpaidPayments
    payments.test.ts               # MODIFY: add their tests
    routers.ts                      # MODIFY: new salesPlan router; new shipments/payments procedures
  client/src/pages/
    StockPage.tsx               # MODIFY: new Sales Plan section
    ShipmentsPage.tsx            # MODIFY: status transitions, customs/arrival, depart-date correction
    PurchaseOrdersPage.tsx         # MODIFY: payment history, real payment re-listing, shipments-per-PO
    MoneyPage.tsx                    # MODIFY: transaction matching UI
```

---

## Task 1: Sales Plan Entry

**Files:**
- Modify: `server/salesPlan.ts`
- Modify: `server/salesPlan.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/StockPage.tsx`

**Interfaces:**
- Produces: `createSalesPlanEntry(input: { skuId: number; warehouseId: number; periodDate: Date; plannedQty: number }, dbClient?: DbClient): Promise<SalesPlanRow>` (from `server/salesPlan.ts`, `SalesPlanRow` already exported from `drizzle/schema.ts`).
- Produces router procedures: `salesPlan.create` (mutation), `salesPlan.volatility` (query), `salesPlan.planActualDeviation` (query).
- Consumes: `getSalesVolatility`, `getPlanActualDeviation` (already exist in `server/salesPlan.ts`, unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// server/salesPlan.test.ts (addition to the existing describe block)
import { createSalesPlanEntry } from "./salesPlan"; // add to the existing import line instead if one already imports from "./salesPlan"

it("creates a sales plan entry with a direct insert, no audit trail", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  const entry = await createSalesPlanEntry({
    skuId: sku.id,
    warehouseId: ff.id,
    periodDate: new Date("2026-10-01"),
    plannedQty: 500,
  });

  expect(entry.plannedQty).toBe(500);
  expect(entry.skuId).toBe(sku.id);

  const rows = await db.select().from(salesPlan);
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/salesPlan.test.ts`
Expected: FAIL — `createSalesPlanEntry` is not exported from `./salesPlan`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/salesPlan.ts (add near the top, after the imports — add `type DbClient` to the existing `import { db } from "./dbClient"` line, making it `import { db, type DbClient } from "./dbClient";`)

export interface CreateSalesPlanEntryInput {
  skuId: number;
  warehouseId: number;
  periodDate: Date;
  plannedQty: number;
}

export async function createSalesPlanEntry(
  input: CreateSalesPlanEntryInput,
  dbClient: DbClient = db,
): Promise<typeof salesPlan.$inferSelect> {
  const [result] = await dbClient.insert(salesPlan).values(input);
  const [row] = await dbClient.select().from(salesPlan).where(eq(salesPlan.id, result.insertId));
  return row;
}
```

You will need to add `eq` to the existing `import { and, between, desc, eq } from "drizzle-orm";` line if `eq` isn't already imported there (check the current import line — `and`, `between`, `desc` are already imported per the existing file; add `eq` if missing).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/salesPlan.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts (add to the existing imports)
import { createSalesPlanEntry, getSalesVolatility, getPlanActualDeviation } from "./salesPlan";
```

```typescript
// server/routers.ts (add as a new top-level key inside appRouter, alongside catalog/purchaseOrders/shipments/payments)
salesPlan: router({
  create: editorProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), periodDate: z.date(), plannedQty: z.number() }))
    .mutation(({ input }) => createSalesPlanEntry(input)),
  volatility: protectedProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), weeks: z.number() }))
    .query(({ input }) => getSalesVolatility(input.skuId, input.warehouseId, input.weeks)),
  planActualDeviation: protectedProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), from: z.date(), to: z.date() }))
    .query(({ input }) => getPlanActualDeviation(input.skuId, input.warehouseId, input.from, input.to)),
}),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass (this step only adds a new router key, no existing procedure changes — confirms no regression).

- [ ] **Step 7: Add the Stock page UI**

```typescript
// client/src/pages/StockPage.tsx — replace the whole file with this content
import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

const STATUS_COLORS: Record<string, string> = {
  critical: "#b00020",
  low: "#b36b00",
  ok: "#1a7f37",
  overstock: "#5a5a5a",
  unknown: "#5a5a5a",
};

interface SalesPlanFormState {
  skuId: string;
  warehouseId: string;
  periodDate: string;
  plannedQty: string;
}

function defaultSalesPlanForm(): SalesPlanFormState {
  return { skuId: "", warehouseId: "", periodDate: new Date().toISOString().slice(0, 10), plannedQty: "" };
}

function SalesPlanSection() {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [form, setForm] = useState<SalesPlanFormState>(() => defaultSalesPlanForm());
  const createEntry = trpc.salesPlan.create.useMutation({
    onSuccess: () => {
      utils.salesPlan.planActualDeviation.invalidate();
      utils.salesPlan.volatility.invalidate();
    },
  });

  const selectedSkuId = form.skuId ? Number(form.skuId) : undefined;
  const selectedWarehouseId = form.warehouseId ? Number(form.warehouseId) : undefined;

  // 30-day window ending today, matching the convention used for MoneyPage's cashflow window.
  const { from, to } = useMemo(
    () => ({ from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now()) }),
    [],
  );

  const deviationQuery = trpc.salesPlan.planActualDeviation.useQuery(
    { skuId: selectedSkuId ?? 0, warehouseId: selectedWarehouseId ?? 0, from, to },
    { enabled: selectedSkuId !== undefined && selectedWarehouseId !== undefined },
  );
  const volatilityQuery = trpc.salesPlan.volatility.useQuery(
    { skuId: selectedSkuId ?? 0, warehouseId: selectedWarehouseId ?? 0, weeks: 8 },
    { enabled: selectedSkuId !== undefined && selectedWarehouseId !== undefined },
  );

  const canCreate = selectedSkuId !== undefined && selectedWarehouseId !== undefined
    && form.plannedQty.trim().length > 0;

  return (
    <div>
      <h2>Sales Plan</h2>
      <div>
        <select value={form.skuId} onChange={(e) => setForm((prev) => ({ ...prev, skuId: e.target.value }))}>
          <option value="">SKU…</option>
          {(skusQuery.data ?? []).map((sku) => <option key={sku.id} value={sku.id}>{sku.sku ?? sku.name ?? `#${sku.id}`}</option>)}
        </select>
        <select value={form.warehouseId} onChange={(e) => setForm((prev) => ({ ...prev, warehouseId: e.target.value }))}>
          <option value="">Warehouse…</option>
          {(warehousesQuery.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
        </select>
        <input
          type="date"
          value={form.periodDate}
          onChange={(e) => setForm((prev) => ({ ...prev, periodDate: e.target.value }))}
        />
        <input
          placeholder="planned qty"
          value={form.plannedQty}
          onChange={(e) => setForm((prev) => ({ ...prev, plannedQty: e.target.value }))}
        />
        <button
          disabled={!canCreate || createEntry.isPending}
          onClick={() =>
            createEntry.mutate({
              skuId: selectedSkuId!,
              warehouseId: selectedWarehouseId!,
              periodDate: new Date(form.periodDate),
              plannedQty: Number(form.plannedQty),
            })
          }
        >
          Add plan entry
        </button>
        {createEntry.error && <div>Failed to save: {createEntry.error.message}</div>}
      </div>
      {selectedSkuId !== undefined && selectedWarehouseId !== undefined && (
        <div>
          <p>Sales volatility (last 8 weeks): {volatilityQuery.data !== undefined ? volatilityQuery.data.toFixed(2) : "…"}</p>
          <table>
            <thead><tr><th>Date</th><th>Planned</th><th>Actual</th><th>Deviation</th></tr></thead>
            <tbody>
              {(deviationQuery.data ?? []).map((row) => (
                <tr key={row.date}><td>{row.date}</td><td>{row.planned}</td><td>{row.actual}</td><td>{row.deviation}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StockPage() {
  const stockQuery = trpc.dashboards.stock.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();

  const warehouseLabels = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of warehousesQuery.data ?? []) map.set(w.id, `${w.code} — ${w.name}`);
    return map;
  }, [warehousesQuery.data]);

  const error = stockQuery.error ?? warehousesQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = stockQuery.isLoading || warehousesQuery.isLoading;
  const data = stockQuery.data;
  if (isLoading || !data) return <div>Loading…</div>;

  return (
    <div>
      <h1>Stock</h1>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Warehouse</th>
            <th>SOH</th>
            <th>Avg daily sales</th>
            <th>Days of cover</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((row) =>
            row.byWarehouse.map((w) => (
              <tr key={`${row.skuId}-${w.warehouseId}`}>
                <td>{row.sku}</td>
                <td>{warehouseLabels.get(w.warehouseId) ?? `#${w.warehouseId}`}</td>
                <td>{w.soh}</td>
                <td>{w.avgDailySales.toFixed(2)}</td>
                <td>{w.daysOfCover === null ? "—" : w.daysOfCover.toFixed(1)}</td>
                <td style={{ color: STATUS_COLORS[w.status] }}>{w.status}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <SalesPlanSection />
    </div>
  );
}
```

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open the app, navigate to the Stock page. Confirm: the "Sales Plan" section renders with SKU/warehouse dropdowns populated from real catalog data; selecting a SKU+warehouse and adding an entry succeeds with no console error; the deviation table and volatility number appear once a SKU+warehouse are both selected (they may show `0`/empty if there's no real sales-actual data for that pair yet in the local dev DB — that is correct behavior, not a bug, confirm no error is thrown).

- [ ] **Step 9: Commit**

```bash
git add server/salesPlan.ts server/salesPlan.test.ts server/routers.ts client/src/pages/StockPage.tsx
git commit -m "feat: sales plan entry — insert path, dashboard query, Stock page UI"
```

---

## Task 2: Shipment Status Progression

**Files:**
- Modify: `server/shipments.ts`
- Modify: `server/shipments.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/ShipmentsPage.tsx`

**Interfaces:**
- Modifies: `updateShipmentStatus`'s `opts` parameter — adds optional `reasonCategory?: ReasonCategory` and `reasonNote?: string`, mirroring `updatePurchaseOrderStatus`'s existing shape exactly. Signature becomes `updateShipmentStatus(id: number, newStatus: (typeof SHIPMENT_STATUSES)[number], opts: { changedBy: number; reasonCategory?: ReasonCategory; reasonNote?: string }): Promise<void>`.
- Produces: router procedure `shipments.updateStatus` (mutation).

- [ ] **Step 1: Write the failing test**

```typescript
// server/shipments.test.ts (addition to the existing describe block)
it("accepts an optional reason category on a status transition and logs it", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", lineItems: [], createdBy: 1 });
  await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1, reasonCategory: "logistics_delay", reasonNote: undefined });

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].field).toBe("status");
  expect(entries[0].reasonCategory).toBe("logistics_delay");
});

it("still allows a status transition with no reason category (optional)", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", lineItems: [], createdBy: 1 });
  await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].reasonCategory).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/shipments.test.ts`
Expected: the first test FAILs (or the `reasonCategory` field on the logged entry is `null`/`undefined` even though a value was passed) — the current `updateShipmentStatus` never forwards a reason category since its `opts` type doesn't accept one.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/shipments.ts — replace the existing updateShipmentStatus function with this
export async function updateShipmentStatus(
  id: number,
  newStatus: (typeof SHIPMENT_STATUSES)[number],
  opts: { changedBy: number; reasonCategory?: ReasonCategory; reasonNote?: string },
): Promise<void> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!VALID_SHIPMENT_TRANSITIONS[shipment.status].includes(newStatus)) {
    throw new Error(`invalid transition from ${shipment.status} to ${newStatus}`);
  }
  await db.update(shipments).set({ status: newStatus }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "status",
    oldValue: shipment.status,
    newValue: newStatus,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/shipments.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts — add updateShipmentStatus and SHIPMENT_STATUSES to the existing imports
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, getShipmentWithLineItems, listShipments, recordShipmentCosts } from "./shipments";
import { REASON_CATEGORIES, PO_STATUSES, SHIPMENT_STATUSES } from "../drizzle/schema";
```

```typescript
// server/routers.ts — add inside the existing `shipments: router({ ... })` block, alongside recordCosts/history
updateStatus: editorProcedure
  .input(z.object({
    id: z.number(),
    newStatus: z.enum(SHIPMENT_STATUSES),
    reasonCategory: reasonCategorySchema.optional(),
    reasonNote: z.string().optional(),
  }))
  .mutation(({ input, ctx }) =>
    updateShipmentStatus(input.id, input.newStatus, {
      changedBy: ctx.user.id,
      reasonCategory: input.reasonCategory,
      reasonNote: input.reasonNote,
    }),
  ),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Add the Shipments page UI**

```typescript
// client/src/pages/ShipmentsPage.tsx — add near the top, after the existing REASON_CATEGORIES/ReasonCategory declarations
const VALID_SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  planned: ["departed"],
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};

interface StatusTransitionFormState {
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultStatusTransitionForm(): StatusTransitionFormState {
  return { reasonCategory: "logistics_delay", reasonNote: "" };
}
```

```typescript
// client/src/pages/ShipmentsPage.tsx — add this new component after ShipmentRow's own definition, before `export function ShipmentsPage`
function StatusTransitionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateStatus = trpc.shipments.updateStatus.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<StatusTransitionFormState>(() => defaultStatusTransitionForm());
  const nextStatuses = VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? [];
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  if (nextStatuses.length === 0) return null;

  return (
    <div>
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      {nextStatuses.map((next) => (
        <button
          key={next}
          disabled={!canSave || updateStatus.isPending}
          onClick={() =>
            updateStatus.mutate({
              id: shipment.id,
              newStatus: next as ShipmentListItem["status"],
              reasonCategory: form.reasonCategory,
              reasonNote: noteRequired ? form.reasonNote : undefined,
            })
          }
        >
          Mark {next}
        </button>
      ))}
      {updateStatus.error && <div>Failed to update status: {updateStatus.error.message}</div>}
    </div>
  );
}
```

Now use it inside `ShipmentRow`: add a `refetch` call the same way `recordCosts`'s `onSuccess` already does, and render `<StatusTransitionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />` in the `<td>` that shows `{shipment.status}` (change that `<td>` from a bare `{shipment.status}` to include the control below it).

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open Shipments page. Confirm: a shipment in `"planned"` status (or whatever status your local dev data has) shows a "Mark <next>" button matching its valid next status only, clicking it transitions the status and the row updates; a shipment in `"delivered"` shows no transition buttons.

- [ ] **Step 9: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts server/routers.ts client/src/pages/ShipmentsPage.tsx
git commit -m "feat: wire shipment status progression to router and UI, with optional reason category"
```

---

## Task 3: Customs Status + Actual Arrival Date

**Files:**
- Modify: `server/shipments.ts`
- Modify: `server/shipments.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/ShipmentsPage.tsx`

**Interfaces:**
- Produces: `setShipmentCustomsStatus(id: number, newStatus: (typeof CUSTOMS_STATUSES)[number], opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string }): Promise<void>`.
- Produces: `markShipmentArrived(id: number, actualArrivalDate: Date, opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string }): Promise<void>`.
- Produces router procedures: `shipments.setCustomsStatus`, `shipments.markArrived` (both mutations).

- [ ] **Step 1: Write the failing test**

```typescript
// server/shipments.test.ts (addition)
it("records a customs status change with a required reason category", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
  await setShipmentCustomsStatus(shipment.id, "held", { changedBy: 1, reasonCategory: "customs_hold" });

  const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
  expect(updated.customsStatus).toBe("held");

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].field).toBe("customsStatus");
  expect(entries[0].oldValue).toBe("not_declared");
  expect(entries[0].newValue).toBe("held");
  expect(entries[0].reasonCategory).toBe("customs_hold");
});

it("records an actual arrival date with the real prior value", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
  const arrivalDate = new Date("2026-10-15");
  await markShipmentArrived(shipment.id, arrivalDate, { changedBy: 1, reasonCategory: "logistics_delay" });

  const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
  expect(updated.actualArrivalDate?.toISOString()).toBe(arrivalDate.toISOString());

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].field).toBe("actualArrivalDate");
  expect(entries[0].oldValue).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/shipments.test.ts`
Expected: FAIL — neither function exists yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/shipments.ts — add CUSTOMS_STATUSES to the existing schema import line
import { shipments, shipmentLineItems, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
```

```typescript
// server/shipments.ts — add these two functions after recordShipmentCosts
export async function setShipmentCustomsStatus(
  id: number,
  newStatus: (typeof CUSTOMS_STATUSES)[number],
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  await dbClient.update(shipments).set({ customsStatus: newStatus }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "customsStatus",
    oldValue: shipment.customsStatus,
    newValue: newStatus,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}

export async function markShipmentArrived(
  id: number,
  actualArrivalDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  await dbClient.update(shipments).set({ actualArrivalDate }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "actualArrivalDate",
    oldValue: shipment.actualArrivalDate?.toISOString() ?? null,
    newValue: actualArrivalDate.toISOString(),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```

Note: `dbClient` is the last parameter here (after `opts`) rather than matching every other function's "last positional parameter" placement exactly — keep it consistent with how `updateShipmentPlannedDepartDate`-style functions in this same file already order parameters (`id, value, opts` with no `dbClient` at all is also a valid existing pattern in this file — if you find the majority of single-write shipment functions don't thread `dbClient`, it's fine to omit it here too for consistency with `updateShipmentPlannedDepartDate`/`markShipmentDeparted`'s existing shape; prioritize matching this file's own internal consistency over the Global Constraint if the two conflict, and note which you chose in your task report).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/shipments.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts — add to the existing shipments import
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, getShipmentWithLineItems, listShipments, recordShipmentCosts } from "./shipments";
import { REASON_CATEGORIES, PO_STATUSES, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
```

```typescript
// server/routers.ts — add inside the existing shipments router block
setCustomsStatus: editorProcedure
  .input(z.object({
    id: z.number(),
    newStatus: z.enum(CUSTOMS_STATUSES),
    reasonCategory: reasonCategorySchema,
    reasonNote: z.string().optional(),
  }))
  .mutation(({ input, ctx }) =>
    setShipmentCustomsStatus(input.id, input.newStatus, {
      changedBy: ctx.user.id,
      reasonCategory: input.reasonCategory,
      reasonNote: input.reasonNote,
    }),
  ),
markArrived: editorProcedure
  .input(z.object({
    id: z.number(),
    actualArrivalDate: z.date(),
    reasonCategory: reasonCategorySchema,
    reasonNote: z.string().optional(),
  }))
  .mutation(({ input, ctx }) =>
    markShipmentArrived(input.id, input.actualArrivalDate, {
      changedBy: ctx.user.id,
      reasonCategory: input.reasonCategory,
      reasonNote: input.reasonNote,
    }),
  ),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Add the Shipments page UI**

```typescript
// client/src/pages/ShipmentsPage.tsx — add near the other form-state interfaces
interface CustomsArrivalFormState {
  customsStatus: string;
  actualArrivalDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

const CUSTOMS_STATUSES = ["not_declared", "declared", "held", "cleared"] as const;

function defaultCustomsArrivalForm(shipment: ShipmentListItem): CustomsArrivalFormState {
  return {
    customsStatus: shipment.customsStatus,
    actualArrivalDate: shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "",
    reasonCategory: "customs_hold",
    reasonNote: "",
  };
}
```

```typescript
// client/src/pages/ShipmentsPage.tsx — add this component after StatusTransitionControl
function CustomsArrivalControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const setCustomsStatus = trpc.shipments.setCustomsStatus.useMutation({ onSuccess: onUpdated });
  const markArrived = trpc.shipments.markArrived.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<CustomsArrivalFormState>(() => defaultCustomsArrivalForm(shipment));
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  return (
    <div>
      <div>Customs: {shipment.customsStatus} · Arrived: {shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "—"}</div>
      <select
        value={form.customsStatus}
        onChange={(e) => setForm((prev) => ({ ...prev, customsStatus: e.target.value }))}
      >
        {CUSTOMS_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input
        type="date"
        value={form.actualArrivalDate}
        onChange={(e) => setForm((prev) => ({ ...prev, actualArrivalDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSave || setCustomsStatus.isPending}
        onClick={() =>
          setCustomsStatus.mutate({
            id: shipment.id,
            newStatus: form.customsStatus as (typeof CUSTOMS_STATUSES)[number],
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save customs status
      </button>
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
      {(setCustomsStatus.error ?? markArrived.error) && <div>Failed to save: {(setCustomsStatus.error ?? markArrived.error)!.message}</div>}
    </div>
  );
}
```

Render `<CustomsArrivalControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />` inside `ShipmentRow`, in the same `<td>` as (or a new `<td>` next to) the status transition control from Task 2.

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open Shipments page. Confirm: changing a shipment's customs status and saving succeeds and the display updates; setting an arrival date and saving succeeds; both require a reason category to be selected (the "other" category requires a note, matching the existing convention on this page).

- [ ] **Step 9: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts server/routers.ts client/src/pages/ShipmentsPage.tsx
git commit -m "feat: customs status and actual arrival date — new functions, router, Shipments page UI"
```

---

## Task 4: Actual Depart Date Correction

**Files:**
- Modify: `server/shipments.ts`
- Modify: `server/shipments.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/ShipmentsPage.tsx`

**Interfaces:**
- Produces: `correctShipmentActualDepartDate(id: number, newDate: Date, opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string }): Promise<void>` — throws if the shipment's current `actualDepartDate` is `null`.
- Produces router procedure: `shipments.correctActualDepartDate` (mutation).

- [ ] **Step 1: Write the failing test**

```typescript
// server/shipments.test.ts (addition)
it("corrects an already-recorded actual depart date with a required reason category", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", lineItems: [], createdBy: 1 });
  await db.update(shipments).set({ actualDepartDate: new Date("2026-09-01") }).where(eq(shipments.id, shipment.id));

  const correctedDate = new Date("2026-09-03");
  await correctShipmentActualDepartDate(shipment.id, correctedDate, { changedBy: 1, reasonCategory: "logistics_delay" });

  const [updated] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
  expect(updated.actualDepartDate?.toISOString()).toBe(correctedDate.toISOString());

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].field).toBe("actualDepartDate");
  expect(entries[0].oldValue).toBe(new Date("2026-09-01").toISOString());
});

it("rejects correcting a depart date that was never set — that's a first-time set, not a correction", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
  await expect(
    correctShipmentActualDepartDate(shipment.id, new Date("2026-09-03"), { changedBy: 1, reasonCategory: "logistics_delay" }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/shipments.test.ts`
Expected: FAIL — `correctShipmentActualDepartDate` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/shipments.ts — add after markShipmentArrived
export async function correctShipmentActualDepartDate(
  id: number,
  newDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
): Promise<void> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment.actualDepartDate) {
    throw new Error(
      "correctShipmentActualDepartDate: no actual depart date is set yet on this shipment — " +
      "use the normal departure flow to set it for the first time, this function only corrects an existing value",
    );
  }
  await db.update(shipments).set({ actualDepartDate: newDate }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "actualDepartDate",
    oldValue: shipment.actualDepartDate.toISOString(),
    newValue: newDate.toISOString(),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/shipments.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts — add correctShipmentActualDepartDate to the existing shipments import
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, getShipmentWithLineItems, listShipments, recordShipmentCosts } from "./shipments";
```

```typescript
// server/routers.ts — add inside the existing shipments router block
correctActualDepartDate: editorProcedure
  .input(z.object({
    id: z.number(),
    newDate: z.date(),
    reasonCategory: reasonCategorySchema,
    reasonNote: z.string().optional(),
  }))
  .mutation(({ input, ctx }) =>
    correctShipmentActualDepartDate(input.id, input.newDate, {
      changedBy: ctx.user.id,
      reasonCategory: input.reasonCategory,
      reasonNote: input.reasonNote,
    }),
  ),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Add the Shipments page UI**

```typescript
// client/src/pages/ShipmentsPage.tsx — add near the other form-state interfaces
interface DepartDateCorrectionFormState {
  newDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultDepartDateCorrectionForm(): DepartDateCorrectionFormState {
  return { newDate: new Date().toISOString().slice(0, 10), reasonCategory: "logistics_delay", reasonNote: "" };
}
```

```typescript
// client/src/pages/ShipmentsPage.tsx — add this component after CustomsArrivalControl
function DepartDateCorrectionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const correctDate = trpc.shipments.correctActualDepartDate.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<DepartDateCorrectionFormState>(() => defaultDepartDateCorrectionForm());
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  // markShipmentDeparted hasn't set an actual depart date yet on this shipment —
  // nothing to correct, so don't render the control at all.
  if (!shipment.actualDepartDate) return null;

  return (
    <div>
      <span>Actual depart: {new Date(shipment.actualDepartDate).toISOString().slice(0, 10)}</span>
      <input
        type="date"
        value={form.newDate}
        onChange={(e) => setForm((prev) => ({ ...prev, newDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSave || correctDate.isPending}
        onClick={() =>
          correctDate.mutate({
            id: shipment.id,
            newDate: new Date(form.newDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Correct depart date
      </button>
      {correctDate.error && <div>Failed to correct: {correctDate.error.message}</div>}
    </div>
  );
}
```

Render `<DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />` inside `ShipmentRow`. Note `ShipmentListItem` (the `trpc.shipments.list` output type) needs to actually include `actualDepartDate` and `customsStatus` fields for this and Task 3's UI to type-check — these come straight from the `shipments` table's own columns via `listShipments()`'s plain `select()`, so they're already present on the type; no server change needed for this, just confirm during implementation that the inferred type includes them (it will, since `listShipments` selects the whole row).

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open Shipments page. Confirm: a shipment with an actual depart date already set shows the correction control and successfully corrects it with a reason category; a shipment with no actual depart date set shows no correction control at all.

- [ ] **Step 9: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts server/routers.ts client/src/pages/ShipmentsPage.tsx
git commit -m "feat: dedicated actual depart date correction path, closing the Stream-B-surfaced regression"
```

---

## Task 5: Payments History

**Files:**
- Modify: `server/routers.ts`
- Modify: `client/src/pages/PurchaseOrdersPage.tsx`

**Interfaces:**
- Produces router procedure: `payments.history` (query) — calls the existing `listChangeLog("payment", paymentId)`. No new server function.
- Consumes: `listChangeLog` (already exists in `server/changeLog.ts`, unchanged).

- [ ] **Step 1: Wire the router** (pure wiring — no new backend logic, so no TDD red/green cycle for a server function; the router addition itself is verified by the full suite still passing plus a live UI check)

```typescript
// server/routers.ts — add inside the existing `payments: router({ ... })` block, alongside matchTransaction
history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("payment", input)),
```

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: all tests pass (no test file changes in this task — this is pure router wiring of an already-tested function).

- [ ] **Step 3: Add the Purchase Orders page UI**

```typescript
// client/src/pages/PurchaseOrdersPage.tsx — add this component after MarkPaidRow, before PoPaymentsSection
function PaymentHistory({ paymentId }: { paymentId: number }) {
  const [expanded, setExpanded] = useState(false);
  const historyQuery = trpc.payments.history.useQuery(paymentId, { enabled: expanded });

  return (
    <span>
      {" "}
      <button onClick={() => setExpanded((prev) => !prev)}>{expanded ? "Hide history" : "History"}</button>
      {expanded && historyQuery.data && (
        <ul>
          {historyQuery.data.map((entry) => (
            <li key={entry.id}>
              {entry.field}: {entry.oldValue ?? "—"} → {entry.newValue ?? "—"}
              {entry.reasonCategory && ` (${entry.reasonCategory}${entry.reasonNote ? `: ${entry.reasonNote}` : ""})`}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
```

Add `<PaymentHistory paymentId={payment.id} />` inside `MarkPaidRow`'s returned `<li>` (both the paid and unpaid render branches), right after the existing text content.

- [ ] **Step 4: Verify live in a browser**

Run: `pnpm dev`, open Purchase Orders page, expand a PO with at least one payment that has been marked paid (or create one and mark it paid to generate real history). Click "History" and confirm the `change_log` entries render (field/old/new/reason).

- [ ] **Step 5: Commit**

```bash
git add server/routers.ts client/src/pages/PurchaseOrdersPage.tsx
git commit -m "feat: wire payments.history to the router and Purchase Orders page UI"
```

---

## Task 6: Payments Re-Listing

**Files:**
- Modify: `server/payments.ts`
- Modify: `server/payments.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/PurchaseOrdersPage.tsx`

**Interfaces:**
- Produces: `listPaymentsForPo(poId: number, dbClient?: DbClient): Promise<Payment[]>` in `server/payments.ts`.
- Produces router procedure: `payments.listForPo` (query).

- [ ] **Step 1: Write the failing test**

```typescript
// server/payments.test.ts (addition)
it("lists payments for a PO, so they survive a reload instead of only existing in session state", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
  await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
  await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date("2026-09-09"), currency: "USD" });

  const result = await listPaymentsForPo(po.id);
  expect(result).toHaveLength(2);
  expect(result.map((p) => p.sequenceNo).sort()).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/payments.test.ts`
Expected: FAIL — `listPaymentsForPo` is not exported from `./payments`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/payments.ts — add after createExpectedPayment
export async function listPaymentsForPo(poId: number, dbClient: DbClient = db): Promise<Payment[]> {
  return dbClient.select().from(payments).where(eq(payments.poId, poId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/payments.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts — add listPaymentsForPo to the existing payments import
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo } from "./payments";
```

```typescript
// server/routers.ts — add inside the existing payments router block
listForPo: protectedProcedure.input(z.number()).query(({ input }) => listPaymentsForPo(input)),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Update the Purchase Orders page UI to use it as the source of truth**

```typescript
// client/src/pages/PurchaseOrdersPage.tsx — replace the whole PoPaymentsSection function with this
function PoPaymentsSection({ poId }: { poId: number }) {
  const utils = trpc.useUtils();
  const paymentsQuery = trpc.payments.listForPo.useQuery(poId);
  const [form, setForm] = useState<NewPaymentFormState>(() => defaultNewPaymentForm());
  const createPayment = trpc.payments.createExpectedPayment.useMutation({
    onSuccess: () => {
      utils.payments.listForPo.invalidate(poId);
      setForm((prev) => ({ ...defaultNewPaymentForm(), sequenceNo: String(Number(prev.sequenceNo) + 1) }));
      utils.dashboards.money.invalidate();
    },
  });
  const canCreate = form.expectedAmount.trim().length > 0 && form.currency.trim().length > 0;

  const refreshAfterPaid = () => {
    utils.payments.listForPo.invalidate(poId);
    utils.dashboards.money.invalidate();
  };

  if (paymentsQuery.error) return <div>Failed to load payments: {paymentsQuery.error.message}</div>;

  return (
    <div>
      <strong>Payments</strong>
      {paymentsQuery.isLoading && <div>Loading payments…</div>}
      {paymentsQuery.data && paymentsQuery.data.length > 0 && (
        <ul>
          {paymentsQuery.data.map((payment) => (
            <MarkPaidRow
              key={payment.id}
              payment={payment}
              onPaid={refreshAfterPaid}
            />
          ))}
        </ul>
      )}
      <div>
        <input
          placeholder="sequence no"
          value={form.sequenceNo}
          onChange={(e) => setForm((prev) => ({ ...prev, sequenceNo: e.target.value }))}
        />
        <input
          placeholder="expected amount"
          value={form.expectedAmount}
          onChange={(e) => setForm((prev) => ({ ...prev, expectedAmount: e.target.value }))}
        />
        <input
          type="date"
          value={form.expectedDate}
          onChange={(e) => setForm((prev) => ({ ...prev, expectedDate: e.target.value }))}
        />
        <input
          placeholder="currency"
          value={form.currency}
          onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
        />
        <button
          disabled={!canCreate || createPayment.isPending}
          onClick={() =>
            createPayment.mutate({
              poId,
              sequenceNo: Number(form.sequenceNo) || 1,
              expectedAmount: form.expectedAmount,
              expectedDate: new Date(form.expectedDate),
              currency: form.currency,
            })
          }
        >
          Add expected payment
        </button>
        {createPayment.error && <div>Failed to save: {createPayment.error.message}</div>}
      </div>
    </div>
  );
}
```

`MarkPaidRow`'s `onPaid` prop type changes from `(updated: Payment) => void` to `() => void` since the parent no longer merges the updated payment into local state — it just invalidates the query. Update `MarkPaidRow`'s own definition: change `onPaid: (updated: Payment) => void` to `onPaid: () => void` in its props type, and change its `useMutation({ onSuccess: onPaid })` call site to `useMutation({ onSuccess: () => onPaid() })` if needed to match the new no-argument signature (check whether tRPC's `onSuccess` callback signature mismatch causes a type error — if so, wrap it as shown).

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open Purchase Orders page, add a payment to a PO, then reload the page. Confirm the payment is still visible after reload (this is the actual regression this task fixes — verify it specifically, not just that the page loads).

- [ ] **Step 9: Commit**

```bash
git add server/payments.ts server/payments.test.ts server/routers.ts client/src/pages/PurchaseOrdersPage.tsx
git commit -m "feat: list payments for a PO from the database, fixing session-local payment loss on reload"
```

---

## Task 7: Shipments Linked to a Purchase Order

**Files:**
- Modify: `server/routers.ts`
- Modify: `client/src/pages/PurchaseOrdersPage.tsx`

**Interfaces:**
- Produces router procedure: `shipments.listForPo` (query, input `poId: number`) — internally resolves the PO's line item IDs via the existing `getPurchaseOrderWithLineItems`, then calls the existing `listShipmentsForPo(poLineItemIds)`. No new server function in `shipments.ts`/`purchaseOrders.ts`.

- [ ] **Step 1: Wire the router** (pure wiring of two already-tested existing functions composed together — no new backend logic, verified by the full suite plus a live UI check)

```typescript
// server/routers.ts — add listShipmentsForPo to the existing shipments import
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, getShipmentWithLineItems, listShipments, listShipmentsForPo, recordShipmentCosts } from "./shipments";
```

```typescript
// server/routers.ts — add inside the existing shipments router block
listForPo: protectedProcedure.input(z.number()).query(async ({ input }) => {
  const po = await getPurchaseOrderWithLineItems(input);
  return listShipmentsForPo(po.lineItems.map((li) => li.id));
}),
```

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Add the Purchase Orders page UI**

```typescript
// client/src/pages/PurchaseOrdersPage.tsx — add this component after PoPaymentsSection
function PoShipmentsSection({ poId }: { poId: number }) {
  const shipmentsQuery = trpc.shipments.listForPo.useQuery(poId);

  if (shipmentsQuery.error) return <div>Failed to load shipments: {shipmentsQuery.error.message}</div>;
  if (shipmentsQuery.isLoading || !shipmentsQuery.data) return <div>Loading shipments…</div>;
  if (shipmentsQuery.data.length === 0) return null;

  return (
    <div>
      <strong>Shipments</strong>
      <ul>
        {shipmentsQuery.data.map((shipment) => (
          <li key={shipment.id}>{shipment.shipmentRef} — {shipment.status}</li>
        ))}
      </ul>
    </div>
  );
}
```

Add `<PoShipmentsSection poId={po.id} />` inside the PurchaseOrdersPage's table body, in the same `<td>` as (or a new `<td>` next to) `<PoPaymentsSection poId={po.id} />`. If adding a new `<td>`, also add a matching `<th>Shipments</th>` to the table header row.

- [ ] **Step 4: Verify live in a browser**

Run: `pnpm dev`, open Purchase Orders page, confirm a PO that has a shipment carrying a share of one of its line items shows that shipment listed (use a PO/shipment pair that already exists in your local dev data, or create one via the Shipments page first).

- [ ] **Step 5: Commit**

```bash
git add server/routers.ts client/src/pages/PurchaseOrdersPage.tsx
git commit -m "feat: surface shipments linked to a Purchase Order in the UI"
```

---

## Task 8: Transaction Matching UI

**Files:**
- Modify: `server/payments.ts`
- Modify: `server/payments.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/MoneyPage.tsx`

**Interfaces:**
- Produces: `listUnpaidPayments(dbClient?: DbClient): Promise<Payment[]>` in `server/payments.ts`.
- Produces router procedure: `payments.listUnpaid` (query).
- Consumes: `payments.matchTransaction` (already exists, `server/routers.ts:131-133`, no change needed) and `getMoneyDashboard`'s existing `unmatchedTransactions` field (already the full `Transaction[]`, not just a count — confirmed by reading `server/dashboards.ts`, which assigns `unmatchedTransactions: unmatched` from `listUnmatchedTransactions()`'s real return value).

- [ ] **Step 1: Write the failing test**

```typescript
// server/payments.test.ts (addition)
it("lists only unpaid expected payments, for the transaction-matching picker", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
  const unpaid = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
  const toBePaid = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date("2026-09-09"), currency: "USD" });
  await markPaymentPaid(toBePaid.id, { amount: "200.00", fxRate: "1", paidDate: new Date("2026-09-10"), reasonCategory: "payment_timing", changedBy: 1 });

  const result = await listUnpaidPayments();
  expect(result.map((p) => p.id)).toEqual([unpaid.id]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/payments.test.ts`
Expected: FAIL — `listUnpaidPayments` is not exported from `./payments`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/payments.ts — add near listUnmatchedTransactions; add `and` to the existing `import { eq, isNull } from "drizzle-orm";` line if needed (not needed here — a single `eq` condition is enough)
export async function listUnpaidPayments(dbClient: DbClient = db): Promise<Payment[]> {
  return dbClient.select().from(payments).where(eq(payments.paid, false));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/payments.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the router**

```typescript
// server/routers.ts — add listUnpaidPayments to the existing payments import
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments } from "./payments";
```

```typescript
// server/routers.ts — add inside the existing payments router block
listUnpaid: protectedProcedure.query(() => listUnpaidPayments()),
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Add the Money page matching UI**

```typescript
// client/src/pages/MoneyPage.tsx — replace the whole file with this content
import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

function MatchTransactionRow({ transaction, onMatched }: { transaction: { id: number; amount: string; currency: string; date: Date; counterparty?: string | null }; onMatched: () => void }) {
  const unpaidQuery = trpc.payments.listUnpaid.useQuery();
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("");
  const matchTransaction = trpc.payments.matchTransaction.useMutation({ onSuccess: onMatched });

  return (
    <tr>
      <td>{new Date(transaction.date).toISOString().slice(0, 10)}</td>
      <td>{transaction.amount} {transaction.currency}</td>
      <td>{transaction.counterparty ?? "—"}</td>
      <td>
        <select value={selectedPaymentId} onChange={(e) => setSelectedPaymentId(e.target.value)}>
          <option value="">Match to payment…</option>
          {(unpaidQuery.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>#{p.sequenceNo} — {p.expectedAmount} {p.currency}</option>
          ))}
        </select>
        <button
          disabled={!selectedPaymentId || matchTransaction.isPending}
          onClick={() => matchTransaction.mutate({ transactionId: transaction.id, paymentId: Number(selectedPaymentId) })}
        >
          Match
        </button>
        {matchTransaction.error && <div>Failed to match: {matchTransaction.error.message}</div>}
      </td>
    </tr>
  );
}

export function MoneyPage() {
  const [tab, setTab] = useState<"cashflow" | "landed_cost" | "daily_cogs">("cashflow");
  const utils = trpc.useUtils();

  // Daily COGS needs a SKU+warehouse to scope to; Landed Cost needs a shipment.
  // A real picker belongs in a follow-up polish pass — these are placeholder
  // selections (first SKU/warehouse/shipment in each list) just to prove the
  // wiring end-to-end for V1.
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const shipmentsQuery = trpc.shipments.list.useQuery();

  const selectedSkuId = skusQuery.data?.[0]?.id;
  const selectedWarehouseId = warehousesQuery.data?.[0]?.id;
  const selectedShipmentId = shipmentsQuery.data?.[0]?.id;

  // Computed once per mount, not inline per render: a fresh `new Date(Date.now() ± …)`
  // on every render changes react-query's input-derived cache key by a few
  // milliseconds each time, which never lets the query settle — it restarts
  // in "loading" state forever instead of resolving.
  const { from, to } = useMemo(
    () => ({ from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 30 * 86400000) }),
    [],
  );

  const moneyQuery = trpc.dashboards.money.useQuery({
    from,
    to,
    skuId: selectedSkuId,
    warehouseId: selectedWarehouseId,
    shipmentId: selectedShipmentId,
  });

  const error = skusQuery.error ?? warehousesQuery.error ?? shipmentsQuery.error ?? moneyQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = skusQuery.isLoading || warehousesQuery.isLoading || shipmentsQuery.isLoading || moneyQuery.isLoading;
  const data = moneyQuery.data;
  if (isLoading || !data) return <div>Loading…</div>;

  const onMatched = () => {
    utils.dashboards.money.invalidate();
    utils.payments.listUnpaid.invalidate();
  };

  return (
    <div>
      <h1>Money</h1>
      <div>
        <button onClick={() => setTab("cashflow")}>Cashflow</button>
        <button onClick={() => setTab("landed_cost")}>Landed Cost</button>
        <button onClick={() => setTab("daily_cogs")}>Daily COGS/Sales</button>
      </div>
      {tab === "cashflow" && (
        <>
          <table>
            <thead><tr><th>Date</th><th>Planned</th><th>Actual</th></tr></thead>
            <tbody>
              {data.cashflow.map((d) => (
                <tr key={d.date}><td>{d.date}</td><td>{d.plannedOutflow.toFixed(2)}</td><td>{d.actualOutflow.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
          {data.unmatchedTransactions.length > 0 && (
            <div>
              <h3>Unmatched transactions</h3>
              <table>
                <thead><tr><th>Date</th><th>Amount</th><th>Counterparty</th><th>Action</th></tr></thead>
                <tbody>
                  {data.unmatchedTransactions.map((tx) => (
                    <MatchTransactionRow key={tx.id} transaction={tx} onMatched={onMatched} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tab === "daily_cogs" && (
        <table>
          <thead><tr><th>Date</th><th>COGS</th></tr></thead>
          <tbody>
            {data.dailyCogs.map((d) => (
              <tr key={d.date}><td>{d.date}</td><td>{d.cogs.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "landed_cost" && (
        <table>
          <thead><tr><th>SKU</th><th>Landed unit cost</th></tr></thead>
          <tbody>
            {data.landedCost.map((row) => (
              <tr key={row.skuId}><td>{row.skuId}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Verify live in a browser**

Run: `pnpm dev`, open Money page's Cashflow tab. If there are unmatched transactions in your local dev data, confirm the list renders (not just a count), the payment dropdown is populated from real unpaid payments, and matching one succeeds and removes it from the unmatched list. If there's no unmatched transaction in local dev data, create one via `payments.recordTransaction` (or the existing UI path for it, if any) plus an unpaid expected payment first, so this can actually be exercised live, not just type-checked.

- [ ] **Step 9: Commit**

```bash
git add server/payments.ts server/payments.test.ts server/routers.ts client/src/pages/MoneyPage.tsx
git commit -m "feat: real transaction-matching UI on the Money page's Cashflow tab"
```

---

## Self-Review Notes

**Spec coverage check:** all 8 design sections map 1:1 to Tasks 1-8. The two logic gaps the spec's own refinement pass caught (Section 2's missing `reasonCategory`, Section 4's null-guard) are both implemented in Tasks 2 and 4 respectively, not left as follow-ups.

**Placeholder scan:** every step has real, complete code. The one deliberately-flagged ambiguity (Task 3's `dbClient` parameter placement, given this file's own inconsistent existing convention) is a real, bounded judgment call for the implementer to resolve and report — not a placeholder, since either choice is fully specified and correct.

**Type consistency cross-check:** `updateShipmentStatus`'s new `reasonCategory?`/`reasonNote?` fields (Task 2) are consumed identically by the router in the same task. `setShipmentCustomsStatus`/`markShipmentArrived`/`correctShipmentActualDepartDate` (Tasks 3-4) all use the exact same `opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string }` shape, matching `recordShipmentCosts`'s existing precedent. `listPaymentsForPo`/`listUnpaidPayments` (Tasks 6, 8) both return `Payment[]`, matching `Payment` as already exported from `drizzle/schema.ts` and already used throughout `payments.ts`. `shipments.listForPo`'s router procedure (Task 7) composes two already-tested functions (`getPurchaseOrderWithLineItems`, `listShipmentsForPo`) with no new server function, verified their signatures line up (`getPurchaseOrderWithLineItems(id)` returns `{ ...po, lineItems }` where each line item has an `id` field, confirmed against the function's actual current implementation in `server/purchaseOrders.ts`).
