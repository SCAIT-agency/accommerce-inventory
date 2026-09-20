# Inventory Ledger Completion & Navigation Restructuring — Design

## 1. Problem

Two independent problems, bundled into one stream because the frontend work
(a batch-detail drill-down) is unbuildable without the backend work.

### 1a. The live app has no way to receive stock

`recordLedgerEvent` with `eventType: "receipt"` is only ever called from
`scripts/reconcile-migration.ts` — a one-time migration script. Nothing in
the live application's shipment-arrival flow writes a receipt event.
`markShipmentArrived` (`server/shipments.ts:201`) updates
`shipments.actualArrivalDate` and writes a change-log entry, and nothing
else. `getSoh`/`getSohForSkus` (`server/inventoryLedger.ts`) sum whatever
ledger rows exist — after a real go-live with no migration replay, that sum
never grows, because nothing ever inserts a `"receipt"` row.

This is silent: nothing throws, nothing looks broken in the UI. Stock just
never arrives. It was masked so far because every real verification in this
codebase's history has gone through the migration script (which does write
receipts) or direct SQL/test setup (which also writes receipts directly).

### 1b. No shipment carries a destination warehouse

`shipments` and `shipment_line_items` (`drizzle/schema.ts:138-170`) have no
`warehouseId` column anywhere. `inventoryLedger`, `salesPlan`, and
`salesActuals` all have one; shipments does not. There is structurally no
way to say "this shipment's units land in FF" vs "in Mutual" — which is a
prerequisite for writing a receipt event at all (`inventory_ledger.warehouseId`
is `NOT NULL`).

### 1c. Frontend structure doesn't match how the team already works

Separately: the app's navigation (Home/Stock/Purchase Orders/Shipments/
Money/ChangeLog) is the controller's own invented grouping, not the
13-tab structure the team already knows from the Google Sheets Control
Tower (`acc-ref-control-tower-overview.md`). Confirmed direction from the
brainstorming conversation:

- **Stock** gets an FF/Mutual toggle instead of one blended table (data
  already carries `warehouseId` per row; this is a display filter, not a
  new query).
- **Transactions** becomes its own page — pulled out of Money's Cashflow
  sub-tab, where it's currently a buried "Unmatched transactions" block.
- **Daily COGS and Cashflow stay together** on one page (already true —
  Money already has 3 sub-tabs: Cashflow / Daily COGS / Landed Cost; this
  doesn't change, only the removal of the Transactions block does).
- **Catalog** (SKU Master, Vendors, Warehouses) becomes a real page — the
  backend (`catalog` router) exists; there is no UI for it today.
- **Inventory Ledger / batch detail** becomes a drill-down page (same
  pattern as `ChangeLogPage` — reachable from Stock per SKU/warehouse, not
  a top-nav item), because it's supporting detail, not a primary workflow.

**Explicitly out of scope for this stream:** Fulfillment & DHL Actuals
(per-order cost modeling from Shopify data against DHL/3PL contract rates).
That's a separate, later spec — it depends on ingesting raw per-order
Shopify data (not the daily SKU/warehouse aggregate `run-daily-shopify-pull.mjs`
already does), and there is existing calibrated business logic in
`acc/tools/ff_invoice_audit/` (Python, validated against real FF/DHL
invoices within ~4%) that the future spec must reuse rather than
reinvent — notably: **packaging tier is chosen by physical unit count per
order** (`PACKAGING_RULES` in `expected.py`: 0-5→A1, 6-8→A3, 9+→B1), not by
weight; DHL's own charge *is* weight-banded (`WeightRate.price`, per
started 100g) but that's a separate, later step in the same pipeline.

## 2. Scope of this stream

1. Schema: add `warehouseId` to `shipments`.
2. Backend write path: `markShipmentArrived` writes one `"receipt"` ledger
   event per shipment line item, atomically.
3. Backend read path: `getRemainingBatches(skuId, warehouseId)` — current
   FIFO batch state.
4. Router additions for both.
5. Frontend: Stock FF/Mutual toggle, new Transactions page, Money page
   cleanup, new Catalog page, new Inventory Ledger drill-down page, nav
   update.

## 3. Schema change

Add to `shipments` (`drizzle/schema.ts:138`):

```ts
warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
```

Placed after `customsDeclarationLink`, before the planned/actual date
columns (grouping: identity/status fields, then warehouse, then dates —
matches this table's existing top-to-bottom ordering convention).

**Why on `shipments`, not `shipment_line_items`:** a shipment is one
physical container/delivery to one destination. Splitting SKUs within one
shipment across two warehouses has never come up in this codebase's
model (weightShare/valueShare on line items divide *shared freight cost*
across SKUs, not destination). One column on the parent row is the
correct grain.

**Migration:** no real production data exists yet (Jello is still on
Google Sheets; the one real-data dry run lives on the unmerged
`feat/real-data-dry-run` branch). `pnpm db:push` regenerates the dev
schema; no backfill-preserving migration is needed. `createShipment`'s
input (`server/shipments.ts`, `shipments.create` in `server/routers.ts`)
gains a required `warehouseId: number` field — the operator picks the
destination warehouse at booking time, same moment they pick the ship
method, matching the real-world sequence in
`acc-ref-control-tower-overview.md` step 4.

## 4. Write path: `markShipmentArrived`

Current (`server/shipments.ts:201-221`):

```ts
export async function markShipmentArrived(
  id: number,
  actualArrivalDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  await dbClient.update(shipments).set({ actualArrivalDate }).where(eq(shipments.id, id));
  await logChange({ /* ... */ });
}
```

New behavior, mirroring `recordSalesActual`'s existing atomic pattern
(`server/salesPlan.ts:31-54`, "both writes must land or neither does"):

```ts
export async function markShipmentArrived(
  id: number,
  actualArrivalDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment) {
    throw new Error(`markShipmentArrived: no shipment found with id ${id}`);
  }
  if (shipment.freightCost == null || shipment.dutyCost == null || shipment.costCurrency == null) {
    throw new Error(
      `markShipmentArrived: cannot record receipt for shipment ${id} — freight/duty costs ` +
      `must be recorded first (recordShipmentCosts) so the ledger receipt carries a real landed cost, ` +
      `not a silent EXW-only placeholder`,
    );
  }
  const landedCosts = await getShipmentLandedUnitCost(id);
  const lines = await dbClient.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, id));
  const landedCostBySkuId = new Map(landedCosts.map((lc) => [lc.skuId, lc.landedUnitCost]));

  await dbClient.transaction(async (tx) => {
    await tx.update(shipments).set({ actualArrivalDate }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "actualArrivalDate",
      oldValue: shipment.actualArrivalDate?.toISOString().slice(0, 10) ?? null,
      newValue: actualArrivalDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
    for (const line of lines) {
      const landedUnitCost = landedCostBySkuId.get(line.skuId);
      if (landedUnitCost === undefined) {
        throw new Error(`markShipmentArrived: no landed cost computed for sku ${line.skuId} on shipment ${id}`);
      }
      await recordLedgerEvent({
        skuId: line.skuId,
        warehouseId: shipment.warehouseId,
        eventType: "receipt",
        qty: line.qty,
        unitCost: landedUnitCost.toFixed(4),
        date: actualArrivalDate,
        sourceRef: shipment.shipmentRef,
      }, tx);
    }
  });
}
```

**Ruling — arrival requires costs to already be recorded.** The
alternative (default freight/duty to 0 and let the receipt carry an
EXW-only cost) fails silently: there is no "correct a receipt's landed
cost after the fact" operation anywhere in this codebase, so an
under-costed receipt would misprice every FIFO-consuming sale downstream
until someone notices — this system's established convention is to fail
loudly instead (see `recordLedgerEvent`'s own negative-stock guard, and
`getShipmentLandedUnitCost`'s currency-mismatch guard). Real-world
sequencing in `acc-ref-control-tower-overview.md` already has "Freight +
customs payments tracked" (step 5) before "Batch lands" (step 7) — this
ruling just enforces that ordering instead of silently tolerating a
skipped step. **Cost:** if a real shipment physically arrives before its
freight/duty invoice does, arrival must wait — operationally, the shipment
stays in `"customs"` status a little longer, which is honest (it isn't a
usable receipt yet either way).

**Confirmed:** `logChange` (`server/changeLog.ts:18`) currently always
writes via the bare `db` import — no `dbClient` parameter. Add one:

```ts
export async function logChange(input: LogChangeInput, dbClient: DbClient = db): Promise<void> {
  // ...
  await dbClient.insert(changeLog).values({ /* ... */ });
}
```

This is purely additive — an optional parameter with a default — so all 13
existing call sites (`payments.ts` ×3, `purchaseOrders.ts` ×2,
`shipments.ts` ×8) keep working unchanged; only the new call inside
`markShipmentArrived`'s transaction passes `tx` explicitly.

Existing tests for `markShipmentArrived` in `server/shipments.test.ts`
that don't first call `recordShipmentCosts` will start throwing — update
them to record costs first (they already create a full PO/shipment/line
item fixture; adding one `recordShipmentCosts` call is consistent with
that fixture style). Add new tests: happy path writes one receipt event
per line item with the right SKU/warehouse/qty/cost; missing-costs case
throws the named error; missing-shipment case throws the existing
not-found error; a shipment whose `getShipmentLandedUnitCost` throws
(currency mismatch) propagates that error without partially writing any
ledger rows (verify via `getSoh` unchanged after the throw).

## 5. Read path: `getRemainingBatches`

New function in `server/inventoryLedger.ts`, generalizing the FIFO
consumption loop `getDailyCogsForRange` already implements
(`server/salesPlan.ts:125-165`) — same batch-consumption rule, but
reporting the final remaining state instead of day-bucketed cost, and
additionally handling `"adjustment"` events (which `getDailyCogsForRange`
currently ignores — that function is not being changed; this is a new,
separate function with its own, wider event handling):

```ts
export interface RemainingBatch {
  batchDate: Date;
  sourceRef: string | null;
  unitCost: number;
  remainingQty: number;
}

export async function getRemainingBatches(skuId: number, warehouseId: number): Promise<RemainingBatch[]> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date);

  interface MutableBatch { qty: number; unitCost: number; date: Date; sourceRef: string | null }
  const batches: MutableBatch[] = [];

  const consume = (qtyToConsume: number, asOfDate: Date, context: string) => {
    let remaining = qtyToConsume;
    while (remaining > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= asOfDate);
      if (!batch) throw new Error(`getRemainingBatches: insufficient stock to consume ${remaining} units for ${context}`);
      const consumed = Math.min(batch.qty, remaining);
      batch.qty -= consumed;
      remaining -= consumed;
    }
  };

  for (const event of events) {
    if (event.eventType === "receipt") {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    } else if (event.eventType === "sale") {
      consume(Math.abs(event.qty), event.date, `sale event ${event.id}`);
    } else {
      // adjustment: negative consumes FIFO like a sale; positive is its own batch.
      if (event.qty < 0) {
        consume(Math.abs(event.qty), event.date, `adjustment event ${event.id}`);
      } else if (event.qty > 0) {
        batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
      }
    }
  }

  return batches
    .filter((b) => b.qty > 0)
    .map((b) => ({ batchDate: b.date, sourceRef: b.sourceRef, unitCost: b.unitCost, remainingQty: b.qty }))
    .sort((a, b) => a.batchDate.getTime() - b.batchDate.getTime());
}
```

Test against real seeded data: two receipts + partial sale leaves the
correct remainder on the older batch and the newer batch untouched
(oldest-first); a sale spanning two batches leaves the second batch
partially consumed; a positive adjustment appears as its own batch; a
negative adjustment consumes FIFO same as a sale; a fully-depleted SKU
returns `[]`; sum of `remainingQty` across all returned batches equals
`getSoh(skuId, warehouseId)` for the same SKU/warehouse (cross-check
against the existing, independently-computed aggregate).

## 6. Router additions (`server/routers.ts`)

```ts
inventoryLedger: router({
  remainingBatches: protectedProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number() }))
    .query(({ input }) => getRemainingBatches(input.skuId, input.warehouseId)),
}),
```

`shipments.create`'s input gains `warehouseId: z.number()`, threaded into
`createShipment`.

New in `payments.ts`/`server/routers.ts` for the Transactions page:

```ts
export async function listTransactions(): Promise<Transaction[]> {
  return db.select().from(transactions).orderBy(desc(transactions.date));
}
```

```ts
payments: router({
  // ...existing...
  listTransactions: protectedProcedure.query(() => listTransactions()),
}),
```

(`listUnmatchedTransactions` and `listUnpaid` stay as-is — the new
Transactions page needs the full list including already-matched rows, so
it can show match status per row rather than only the unmatched subset.)

## 7. Frontend

### Stock page (`client/src/pages/StockPage.tsx`)

Add a warehouse toggle above the table:

```tsx
const [warehouseFilter, setWarehouseFilter] = useState<number | "all">("all");
```

Rendered as a button group from `warehousesQuery.data` (already fetched).
Filters `data.flatMap(...)`'s inner `row.byWarehouse` before mapping to
`<tr>`. The Sales Plan section's warehouse `<select>` default value
follows the toggle (pre-selects the toggled warehouse when one is picked,
`""` when "all"), but stays independently changeable — it's a different
workflow (planning one SKU/warehouse pair at a time), not purely a filtered
view of the table above.

Add a "Batches" link/button per row (`w.warehouseId`, `row.skuId`)
navigating to `/inventory-ledger/:skuId/:warehouseId`.

### New: Inventory Ledger drill-down (`client/src/pages/InventoryLedgerPage.tsx`)

Same routing pattern as `ChangeLogRoute` in `client/src/main.tsx` (route
param, not a nav link):

```tsx
<Route path="/inventory-ledger/:skuId/:warehouseId" element={<InventoryLedgerRoute />} />
```

Page calls `trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId })`,
renders a table: Batch Date | Source | Unit Cost | Remaining Qty, oldest
first (FIFO order — the order units will actually be consumed in).

### New: Transactions page (`client/src/pages/TransactionsPage.tsx`)

Move `MatchTransactionRow` and the matching UI out of `MoneyPage.tsx`
(`client/src/pages/MoneyPage.tsx:4-30,96-108`) into this new file. Fetches
`trpc.payments.listTransactions.useQuery()` instead of only
`listUnmatchedTransactions` — renders every transaction with its
match status (`matchedPaymentId != null` → show "Matched"; else render
`MatchTransactionRow`'s existing picker). Add to `main.tsx` routes and
`AppNav.tsx`.

### Money page (`client/src/pages/MoneyPage.tsx`)

Remove the "Unmatched transactions" block and the now-unused
`unpaidQuery`/`onMatched` wiring that only served it (re-check: `onMatched`
also invalidates `dashboards.money` — the Cashflow sub-tab's numbers still
depend on transaction matching state, so keep that invalidation reachable
from the new Transactions page instead). Keep the existing 3 sub-tabs
(Cashflow / Daily COGS / Landed Cost) unchanged otherwise.

### New: Catalog page (`client/src/pages/CatalogPage.tsx`)

Three sections (SKUs / Vendors / Warehouses), each a simple list + create
form against the existing `catalog` router procedures
(`listSkus`/`createSku`, `listVendors`/`createVendor`,
`listWarehouses`/`createWarehouse` — all already implemented in
`server/db.ts` and wired in `server/routers.ts`, just never given a UI).
Same form/table conventions as every other page in this codebase.

### Nav (`client/src/components/nav/AppNav.tsx`)

Links become: Home, Stock, Purchase Orders, Shipments, Cost & Cashflow
(existing Money route, label changed), Transactions (new), Catalog (new).
ChangeLog and Inventory Ledger stay drill-down-only, no nav entry — same
as ChangeLog today.

## 7a. Blast radius of the `warehouseId` NOT NULL column

Every test that creates a shipment (via `createShipment` or a direct
`db.insert(shipments)`) needs a `warehouseId`. Confirmed by grep — exactly
3 files touch shipment creation: `server/shipments.test.ts`,
`server/landedCost.test.ts`, `server/dashboards.test.ts`. Only
`dashboards.test.ts` already imports `createWarehouse` and deletes
`warehouses` in its cleanup (it needs one regardless, for its SOH/ledger
tests) — its fix is a single new fixture call at its one `createShipment`
site. `shipments.test.ts` and `landedCost.test.ts` have zero warehouse
references today and need the import, the cleanup-delete, and a fixture
call added at every `createShipment` site (~20 in the former, 8 in the
latter) — real new work, not just extending an existing fixture. The
TypeScript compiler enforces completeness here: `warehouseId` becomes a
required field on `CreateShipmentInput`, so `pnpm check` fails loudly at
every missed call site.

## 8. Global constraints

- No change to `getDailyCogsForRange`'s existing behavior or tests — it
  keeps ignoring `"adjustment"` events, exactly as documented in its own
  doc comment (BACKLOG.md section D). `getRemainingBatches` is a new,
  separate function with wider event handling; the two are not required
  to be implemented by shared code.
- `markShipmentArrived`'s new cost-required guard is a behavior change —
  every existing test/fixture that calls it without first calling
  `recordShipmentCosts` needs updating, not working around.
- No caching, no precomputed batch tables — `getRemainingBatches` recomputes
  from the ledger on every call, matching this codebase's established
  correctness-over-cache-invalidation-risk stance (BACKLOG.md section D's
  Non-Goals).
- Every new/changed dashboard value proven against real seeded data in
  tests, not just asserted — matching every prior stream's testing
  convention in this codebase.
