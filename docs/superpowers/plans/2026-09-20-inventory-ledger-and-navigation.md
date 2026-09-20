# Inventory Ledger Completion & Navigation Restructuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live app a real write path from "shipment arrived" to an `inventory_ledger` receipt event (today only a one-time migration script ever writes receipts), add a read path to inspect the resulting FIFO batch state, and restructure the frontend navigation to match the 13-tab Google Sheets Control Tower structure the team already knows.

**Architecture:** A new `warehouseId` column on `shipments` (there is currently no way to say which warehouse a shipment lands in) feeds a rewritten, transactional `markShipmentArrived` that writes one ledger receipt per SKU line item using the existing `getShipmentLandedUnitCost`. A new `getRemainingBatches` read function reconstructs current FIFO batch state from ledger history for a UI drill-down. Six frontend pages get reorganized: Stock gains a warehouse toggle, Transactions and Catalog become new standalone pages, Money sheds its buried transaction-matching UI, and a new Inventory Ledger drill-down page (route-param based, no nav entry, same pattern as ChangeLog) shows batch detail.

**Tech Stack:** Node/Express + tRPC v11 + React + MySQL via Drizzle ORM + Vitest.

**Spec:** `docs/2026-09-20-inventory-ledger-and-navigation-design.md`

## Global Constraints

- No change to `getDailyCogsForRange`'s existing behavior or its tests — it keeps ignoring `"adjustment"` ledger events exactly as already documented in its own doc comment. `getRemainingBatches` is a new, separate function with wider event handling; the two do not share code.
- `markShipmentArrived`'s new "costs must already be recorded" guard is a deliberate behavior change (spec section 4's ruling) — every existing test/fixture that calls it must be updated to call `recordShipmentCosts` first, never worked around.
- No caching, no precomputed batch tables — `getRemainingBatches` recomputes from the ledger on every call.
- Every new/changed dashboard or ledger value must be proven against real seeded data in tests, not just asserted.
- Fulfillment & DHL Actuals is explicitly out of scope — do not add any task for it.
- The dev DB needs env vars loaded before test/check commands: `set -a && source .env && set +a` in the shell, once per session, before `pnpm test` / `pnpm check`.

---

### Task 1: Add `warehouseId` to `shipments`

**Files:**
- Modify: `drizzle/schema.ts:138-158` (shipments table)
- Modify: `server/shipments.ts:14-45` (`CreateShipmentInput`, `createShipment`)
- Modify: `server/routers.ts` (`shipments.create` input schema)
- Modify: `server/dashboards.test.ts` (one `createShipment` call site, ~line 119)
- Modify: `server/landedCost.test.ts` (imports, `beforeEach`, 8 `createShipment` call sites)
- Modify: `server/shipments.test.ts` (imports, `beforeEach`, all `createShipment` call sites — see Step 7)

**Interfaces:**
- Consumes: `createWarehouse(data: { code: string; name: string })` from `server/db.ts` (already exists).
- Produces: `shipments.warehouseId: number` (schema column); `CreateShipmentInput.warehouseId: number` (now required); every later task that reads a shipment can rely on `shipment.warehouseId` being present and non-null.

- [ ] **Step 1: Add the column to the schema**

In `drizzle/schema.ts`, inside the `shipments` table definition, add `warehouseId` right after `customsDeclarationLink` and before `plannedDepartDate`:

```ts
export const shipments = mysqlTable("shipments", {
  id: int("id").autoincrement().primaryKey(),
  shipmentRef: varchar("shipmentRef", { length: 64 }).notNull().unique(),
  vendorReference: varchar("vendorReference", { length: 128 }),
  status: mysqlEnum("status", SHIPMENT_STATUSES).default("planned").notNull(),
  customsStatus: mysqlEnum("customsStatus", CUSTOMS_STATUSES).default("not_declared").notNull(),
  customsDeclarationLink: varchar("customsDeclarationLink", { length: 512 }),
  warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
  plannedDepartDate: timestamp("plannedDepartDate"),
  actualDepartDate: timestamp("actualDepartDate"),
  plannedArrivalDate: timestamp("plannedArrivalDate"),
  actualArrivalDate: timestamp("actualArrivalDate"),
  freightCost: varchar("freightCost", { length: 32 }),
  dutyCost: varchar("dutyCost", { length: 32 }),
  costCurrency: varchar("costCurrency", { length: 8 }),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
```

`warehouses` is already defined earlier in this same file (line 71), so no new import is needed.

- [ ] **Step 2: Push the schema change to the dev DB**

Run: `set -a && source .env && set +a && pnpm db:push`
Expected: drizzle-kit reports the new `warehouseId` column added to `shipments`. If it asks whether this is a new column or a rename (drizzle-kit sometimes asks this for a NOT NULL column with no default on a table that may have existing rows), answer "new column" — this is dev-only data, no production data exists yet (see spec section 3).

- [ ] **Step 3: Update `CreateShipmentInput` and `createShipment`**

In `server/shipments.ts`:

```ts
export interface CreateShipmentInput {
  shipmentRef: string;
  vendorReference?: string;
  initialStatus?: (typeof SHIPMENT_STATUSES)[number];
  warehouseId: number;
  /** Migration-only initial values: no audit trail, since a creation-time value
   * isn't a "change" with a prior value — mirrors vendorReference/initialStatus
   * above. Use `recordShipmentCosts` for a live, audited change instead. */
  freightCost?: string;
  dutyCost?: string;
  costCurrency?: string;
  lineItems: { poLineItemId: number; skuId: number; qty: number; weightShare: string; valueShare: string }[];
  createdBy: number;
}

export async function createShipment(input: CreateShipmentInput, dbClient: DbClient = db): Promise<Shipment> {
  const [result] = await dbClient.insert(shipments).values({
    shipmentRef: input.shipmentRef,
    vendorReference: input.vendorReference,
    status: input.initialStatus ?? "planned",
    warehouseId: input.warehouseId,
    freightCost: input.freightCost,
    dutyCost: input.dutyCost,
    costCurrency: input.costCurrency,
    createdBy: input.createdBy,
  });
  if (input.lineItems.length > 0) {
    await dbClient.insert(shipmentLineItems).values(
      input.lineItems.map((li) => ({ ...li, shipmentId: result.insertId })),
    );
  }
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, result.insertId));
  return shipment;
}
```

- [ ] **Step 4: Update the router input schema**

In `server/routers.ts`, find `shipments: router({ ... create: editorProcedure.input(z.object({ ... }))` and add `warehouseId`:

```ts
create: editorProcedure
  .input(z.object({
    shipmentRef: z.string(),
    warehouseId: z.number(),
    lineItems: z.array(z.object({ skuId: z.number(), qty: z.number(), unitPrice: z.string(), currency: z.string() })),
  }))
  .mutation(({ input, ctx }) => createShipment({ ...input, createdBy: ctx.user.id })),
```

(Only the `input` schema's object gains the field — the rest of that procedure is unchanged.)

- [ ] **Step 5: Run the type checker to find every broken call site**

Run: `set -a && source .env && set +a && pnpm check`
Expected: FAILS with TypeScript errors at every `createShipment(...)` call site missing `warehouseId` — this list is your worklist for Steps 6-7. Do not skip any reported error.

- [ ] **Step 6: Fix `server/dashboards.test.ts`**

This file already imports `createWarehouse` and already deletes `warehouses` in its `beforeEach` (nothing to add there). Find the one `createShipment` call in the test `"getMoneyDashboard degrades landedCost to an error field instead of throwing on a currency mismatch, leaving other sections intact"` and add a warehouse fixture immediately before it:

```ts
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
```

- [ ] **Step 7: Fix `server/landedCost.test.ts`**

Add `warehouses` to the schema import and `createWarehouse` to the `./db` import at the top of the file:

```ts
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, inventoryLedger, payments, warehouses } from "../drizzle/schema";
import { createSku, createVendor, createWarehouse } from "./db";
```

Add `await tx.delete(warehouses);` to the `beforeEach`'s cleanup block, after `await tx.delete(vendors);`:

```ts
        await tx.delete(skus);
        await tx.delete(vendors);
        await tx.delete(warehouses);
```

Then, in each of the file's 8 tests, add one `const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });` line immediately before that test's `createShipment` call, and add `warehouseId: ff.id,` to that call's input object. All 8 `createShipment` calls in this file, verbatim as they exist today, with the required addition:

1. `"allocates shipment freight/duty to each SKU line..."` — before `const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", ...`, insert the `createWarehouse` line; add `warehouseId: ff.id,` after `shipmentRef: "PO1-W4-Container2",`.
2. `"computes correct per-line landed cost for multiple line items..."` — same pattern, shipmentRef `"PO1-W4-Container3"`.
3. `"throws a clear error instead of crashing when a shipment line item references a PO line item that doesn't exist"` — same pattern, shipmentRef `"PO1-W4-Container4"`.
4. `"throws instead of dividing by zero when a shipment line item has qty 0"` — same pattern, shipmentRef `"PO1-W4-Container2"`.
5. `"rejects computing landed cost when the PO line's currency doesn't match..."` — same pattern, shipmentRef `"PO1-W4-Container1"`.
6. `"still computes landed cost correctly when currencies match (no regression)"` — same pattern, shipmentRef `"PO1-W4-Container1"`.
7. `"does not treat differently-cased currency codes as a mismatch..."` — same pattern, shipmentRef `"PO1-W4-Container1"`.
8. `"computes EXW-only landed cost when shipment costCurrency is null..."` — same pattern, shipmentRef `"PO1-W4-Container1"`.

Example of the exact transform for test 1 (apply the same shape to all 8):

```ts
    const [lineItem] = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));

    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container2",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: lineItem.id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
```

- [ ] **Step 8: Fix `server/shipments.test.ts`**

This file has roughly 20 `createShipment(...)` call sites, most sharing the identical literal `{ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 }`. Rather than one-off fixtures per test, give the whole file one shared warehouse per test via `beforeEach`:

Add `warehouses` to the schema import and `createWarehouse` to the `./db` import:

```ts
import { shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments, warehouses } from "../drizzle/schema";
import { createSku, createVendor, createWarehouse } from "./db";
```

Add a module-level (inside `describe("shipments", ...)`, above the `it()` blocks — or above `describe` if `seedPoWithLineItem` is also module-level, matching whichever scope `seedPoWithLineItem` already uses) mutable variable, set fresh in `beforeEach` right after cleanup:

```ts
let ffWarehouseId: number;

beforeEach(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(changeLog);
      await tx.delete(payments);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(skus);
      await tx.delete(vendors);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  ffWarehouseId = ff.id;
});
```

Then add `warehouseId: ffWarehouseId,` to every `createShipment({...})` call's input object in this file — every one of them, whether single-line (`createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 })` → `createShipment({ shipmentRef: "PO1-W4-Container2", warehouseId: ffWarehouseId, lineItems: [], createdBy: 1 })`) or multi-line. Run `grep -n "createShipment(" server/shipments.test.ts` to enumerate every call site — there is no ambiguity about which ones need it: all of them do, `CreateShipmentInput.warehouseId` is required.

- [ ] **Step 9: Re-run the type checker, then the full test suite**

Run: `set -a && source .env && set +a && pnpm check`
Expected: PASS, zero errors. If any `createShipment` call site was missed (in these 3 files or anywhere else), this step will still report it — fix it the same way before proceeding.

Run: `set -a && source .env && set +a && pnpm test`
Expected: all tests pass (this task doesn't change behavior, only adds a required field, so no test's assertions should need changing beyond the fixture additions above).

- [ ] **Step 10: Commit**

```bash
git add drizzle/schema.ts server/shipments.ts server/routers.ts server/dashboards.test.ts server/landedCost.test.ts server/shipments.test.ts
git commit -m "feat: add warehouseId to shipments"
```

---

### Task 2: Write path — `markShipmentArrived` records a ledger receipt

**Files:**
- Modify: `server/changeLog.ts` (`logChange` gains an optional `dbClient` parameter)
- Modify: `server/shipments.ts:201-221` (`markShipmentArrived`)
- Modify: `server/shipments.test.ts` (existing `markShipmentArrived` tests + new tests)

**Interfaces:**
- Consumes: `recordLedgerEvent(event, dbClient?)` from `server/inventoryLedger.ts` (Task 1's `shipment.warehouseId`; already exists, already accepts a `dbClient`); `getShipmentLandedUnitCost(shipmentId): Promise<{ skuId: number; landedUnitCost: number }[]>` from `server/landedCost.ts` (already exists, unchanged).
- Produces: `logChange(input, dbClient?: DbClient)` — every other call site in the codebase keeps working via the default parameter. `markShipmentArrived(id, actualArrivalDate, opts): Promise<void>` — signature drops its former unused `dbClient` parameter (nothing calls it with a custom client today — confirmed by grep) since it now always opens its own top-level transaction.

- [ ] **Step 1: Add `dbClient` to `logChange`**

In `server/changeLog.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { changeLog, REASON_CATEGORIES } from "../drizzle/schema";

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export interface LogChangeInput {
  entityType: string;
  entityId: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reasonCategory?: ReasonCategory;
  reasonNote?: string;
  changedBy: number;
}

export async function logChange(input: LogChangeInput, dbClient: DbClient = db): Promise<void> {
  if (input.reasonCategory === "other" && !input.reasonNote) {
    throw new Error("reasonNote is required when reasonCategory is 'other'");
  }
  await dbClient.insert(changeLog).values({
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    reasonCategory: input.reasonCategory ?? null,
    reasonNote: input.reasonNote ?? null,
    changedBy: input.changedBy,
  });
}
```

(`listChangeLog` is unchanged.)

- [ ] **Step 2: Write the failing tests for the new `markShipmentArrived` behavior**

In `server/shipments.test.ts`, find the existing test that calls `markShipmentArrived` (around line 247, inside a test using `seedPoWithLineItem()`). First, add `recordShipmentCosts` before the existing `markShipmentArrived` call so the existing test keeps passing under the new guard — find:

```ts
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: 1, reasonCategory: "logistics_delay" });
```

and read the surrounding test to find how `shipment` was created there (it uses `seedPoWithLineItem()`'s `lineItemId`/`skuId`, then a real `createShipment` call with those, then presumably transitions status through `departed`/`in_transit`/`customs` before arrival — keep all of that as-is). Immediately before the `markShipmentArrived` call, add:

```ts
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "150.00", dutyCost: "20.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );
```

(Use `costCurrency: "USD"` to match `seedPoWithLineItem`'s PO line currency, `"USD"` — a mismatched currency here would throw in `getShipmentLandedUnitCost`, which is not what this test is checking.)

Then add new tests in the same `describe("shipments", ...)` block:

```ts
  it("markShipmentArrived throws if freight/duty costs aren't recorded yet", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container5",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: 1, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/freight\/duty costs must be recorded first/);
  });

  it("markShipmentArrived writes one receipt ledger event per line item, at the shipment's landed cost", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container6",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    const arrivalDate = new Date("2026-09-20");
    await markShipmentArrived(shipment.id, arrivalDate, { changedBy: 1, reasonCategory: "logistics_delay" });

    const soh = await getSoh(skuId, ffWarehouseId, arrivalDate);
    expect(soh).toBe(90000);

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    const receipt = events.find((e) => e.eventType === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt?.warehouseId).toBe(ffWarehouseId);
    expect(receipt?.qty).toBe(90000);
    expect(receipt?.sourceRef).toBe("PO1-W4-Container6");
    // (90000 * 0.15 EXW + 900 freight * 1.0 share + 100 duty * 1.0 share) / 90000
    expect(parseFloat(receipt?.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 900 + 100) / 90000, 4);
  });

  it("markShipmentArrived does not write a partial receipt if getShipmentLandedUnitCost throws", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container7",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: 1 });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: 1 });
    // seedPoWithLineItem's PO line is priced in USD; recording costs in EUR
    // creates the currency mismatch getShipmentLandedUnitCost rejects.
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "900.00", dutyCost: "100.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: 1 },
    );

    await expect(
      markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: 1, reasonCategory: "logistics_delay" }),
    ).rejects.toThrow(/currency/i);

    const soh = await getSoh(skuId, ffWarehouseId);
    expect(soh).toBe(0);
  });
```

Add `getSoh` and `inventoryLedger` to this file's imports:

```ts
import { getSoh } from "./inventoryLedger";
import { inventoryLedger } from "../drizzle/schema";
```

(`inventoryLedger` joins the existing `shipments, shipmentLineItems, poLineItems, purchaseOrders, skus, vendors, changeLog, payments, warehouses` import from Task 1's Step 8.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `set -a && source .env && set +a && pnpm test server/shipments.test.ts -t "markShipmentArrived"`
Expected: FAIL — `markShipmentArrived` doesn't yet throw on missing costs, and doesn't yet write any ledger event.

- [ ] **Step 4: Rewrite `markShipmentArrived`**

In `server/shipments.ts`, add `recordLedgerEvent` to the import from `./inventoryLedger` and `getShipmentLandedUnitCost` from `./landedCost`:

```ts
import { recordLedgerEvent } from "./inventoryLedger";
import { getShipmentLandedUnitCost } from "./landedCost";
```

Replace `markShipmentArrived`:

```ts
export async function markShipmentArrived(
  id: number,
  actualArrivalDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
): Promise<void> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment) {
    throw new Error(`markShipmentArrived: no shipment found with id ${id}`);
  }
  if (shipment.freightCost == null || shipment.dutyCost == null || shipment.costCurrency == null) {
    throw new Error(
      `markShipmentArrived: cannot record receipt for shipment ${id} — freight/duty costs must be recorded first ` +
      `(recordShipmentCosts) so the ledger receipt carries a real landed cost, not a silent EXW-only placeholder`,
    );
  }
  const landedCosts = await getShipmentLandedUnitCost(id);
  const lines = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, id));
  const landedCostBySkuId = new Map(landedCosts.map((lc) => [lc.skuId, lc.landedUnitCost]));

  await db.transaction(async (tx) => {
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

Note the dropped `dbClient` parameter (was unused by any caller — confirmed by grep in the design phase) and the pre-transaction read of `getShipmentLandedUnitCost`/`lines` (a pure read with no dependency on the arrival write, matching this codebase's established pattern of reading before opening the transaction that acts on the read).

- [ ] **Step 5: Update the router call site**

In `server/routers.ts`, `markArrived`'s mutation calls `markShipmentArrived(input.id, input.actualArrivalDate, {...})` — this call shape is unchanged (it never passed a 4th argument), so no edit is needed here. Just confirm this with `grep -n "markShipmentArrived(" server/routers.ts` after Step 4.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `set -a && source .env && set +a && pnpm test server/shipments.test.ts`
Expected: PASS, including the updated existing test and the 3 new ones.

- [ ] **Step 7: Run the full suite**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: PASS. (`server/routers.test.ts` or any integration test exercising `markArrived` end-to-end, if one exists, may need the same "record costs first" fixture fix — check for any other caller of `markShipmentArrived` across `*.test.ts` files with `grep -rn "markShipmentArrived(" --include=*.test.ts .` and fix the same way as Step 2 if any are found beyond `shipments.test.ts`.)

- [ ] **Step 8: Commit**

```bash
git add server/changeLog.ts server/shipments.ts server/shipments.test.ts
git commit -m "feat: markShipmentArrived writes a real inventory ledger receipt"
```

---

### Task 3: Read path — `getRemainingBatches`

**Files:**
- Modify: `server/inventoryLedger.ts` (new `getRemainingBatches` function + `RemainingBatch` interface)
- Modify: `server/inventoryLedger.test.ts` (new tests)

**Interfaces:**
- Consumes: `inventoryLedger` table rows (`skuId`, `warehouseId`, `eventType`, `qty`, `unitCost`, `date`, `sourceRef`) — already exists, unchanged.
- Produces: `getRemainingBatches(skuId: number, warehouseId: number): Promise<RemainingBatch[]>` where `RemainingBatch = { batchDate: Date; sourceRef: string | null; unitCost: number; remainingQty: number }`, sorted oldest-first — consumed by Task 4's router procedure.

- [ ] **Step 1: Write the failing tests**

In `server/inventoryLedger.test.ts`, add (using this file's existing `createSku`/`createWarehouse` helpers and `recordLedgerEvent`):

```ts
  it("getRemainingBatches reports oldest-first remaining stock after a partial sale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 200, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -150, unitCost: null, date: new Date("2026-09-10"), sourceRef: "shopify-2026-09-10" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-05"), sourceRef: "PO2", unitCost: 2.5, remainingQty: 150 },
    ]);
  });

  it("getRemainingBatches leaves an untouched newer batch alone when the older one fully covers a sale", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 200, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -60, unitCost: null, date: new Date("2026-09-03"), sourceRef: "shopify-2026-09-03" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-01"), sourceRef: "PO1", unitCost: 2.0, remainingQty: 40 },
      { batchDate: new Date("2026-09-05"), sourceRef: "PO2", unitCost: 2.5, remainingQty: 200 },
    ]);
  });

  it("getRemainingBatches treats a positive adjustment as its own batch and a negative adjustment as FIFO consumption", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: 20, unitCost: "1.90", date: new Date("2026-09-03"), sourceRef: "manual-recount" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: -30, unitCost: null, date: new Date("2026-09-06"), sourceRef: "manual-shrinkage" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([
      { batchDate: new Date("2026-09-01"), sourceRef: "PO1", unitCost: 2.0, remainingQty: 90 },
      { batchDate: new Date("2026-09-03"), sourceRef: "manual-recount", unitCost: 1.9, remainingQty: 20 },
    ]);
  });

  it("getRemainingBatches returns an empty array for a fully-depleted SKU", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -100, unitCost: null, date: new Date("2026-09-10"), sourceRef: "shopify-2026-09-10" });

    const { getRemainingBatches } = await import("./inventoryLedger");
    const result = await getRemainingBatches(sku.id, ff.id);

    expect(result).toEqual([]);
  });

  it("getRemainingBatches's remaining quantities sum to getSoh for the same SKU/warehouse", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "1.10", date: new Date("2026-09-08"), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -220, unitCost: null, date: new Date("2026-09-12"), sourceRef: "shopify-2026-09-12" });

    const { getRemainingBatches, getSoh } = await import("./inventoryLedger");
    const batches = await getRemainingBatches(sku.id, ff.id);
    const totalRemaining = batches.reduce((sum, b) => sum + b.remainingQty, 0);
    const soh = await getSoh(sku.id, ff.id);

    expect(totalRemaining).toBe(soh);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `set -a && source .env && set +a && pnpm test server/inventoryLedger.test.ts -t "getRemainingBatches"`
Expected: FAIL with "getRemainingBatches is not a function" or similar — the function doesn't exist yet.

- [ ] **Step 3: Implement `getRemainingBatches`**

In `server/inventoryLedger.ts`, add:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `set -a && source .env && set +a && pnpm test server/inventoryLedger.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: add getRemainingBatches, current FIFO batch state per SKU/warehouse"
```

---

### Task 4: Router additions

**Files:**
- Modify: `server/payments.ts` (new `listTransactions` function)
- Modify: `server/routers.ts` (`inventoryLedger.remainingBatches`, `payments.listTransactions`)
- Modify: `server/payments.test.ts` (new test for `listTransactions`)

**Interfaces:**
- Consumes: `getRemainingBatches` (Task 3), `transactions` table (existing schema, unchanged).
- Produces: tRPC procedures `inventoryLedger.remainingBatches` and `payments.listTransactions`, consumed by Task 5 and Task 6's frontend pages respectively.

- [ ] **Step 1: Write the failing test for `listTransactions`**

In `server/payments.test.ts`, find the existing `recordTransaction`/`listUnmatchedTransactions` tests for the fixture pattern already in use, and add:

```ts
  it("listTransactions returns every transaction, matched or not, newest first", async () => {
    const tx1 = await recordTransaction({ date: new Date("2026-09-01"), amount: "100.00", currency: "USD", fxRate: "1.0", counterparty: "Vendor A" });
    const tx2 = await recordTransaction({ date: new Date("2026-09-05"), amount: "200.00", currency: "USD", fxRate: "1.0", counterparty: "Vendor B" });
    const payment = await createExpectedPayment({ sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date("2026-09-01"), currency: "USD" });
    await matchTransactionToPayment(tx1.id, payment.id);

    const { listTransactions } = await import("./payments");
    const result = await listTransactions();

    expect(result.map((t) => t.id)).toEqual([tx2.id, tx1.id]);
    expect(result.find((t) => t.id === tx1.id)?.matchedPaymentId).toBe(payment.id);
    expect(result.find((t) => t.id === tx2.id)?.matchedPaymentId).toBeNull();
  });
```

(Match this file's existing import style — `recordTransaction`, `createExpectedPayment`, `matchTransactionToPayment` are presumably already imported for neighboring tests; add `listTransactions` to that same `./payments` import once it exists, or leave the dynamic `await import("./payments")` above if this file's convention favors that for newly-added functions — check the file's existing style for `listUnmatchedTransactions` and match it exactly.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `set -a && source .env && set +a && pnpm test server/payments.test.ts -t "listTransactions"`
Expected: FAIL — `listTransactions` doesn't exist yet.

- [ ] **Step 3: Implement `listTransactions`**

In `server/payments.ts`, find `listUnmatchedTransactions` and add immediately after it (check the top of the file for its existing `desc`/`eq` imports from `drizzle-orm` and extend that import line rather than duplicating it):

```ts
export async function listTransactions(): Promise<Transaction[]> {
  return db.select().from(transactions).orderBy(desc(transactions.date));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `set -a && source .env && set +a && pnpm test server/payments.test.ts`
Expected: PASS.

- [ ] **Step 5: Add both router procedures**

In `server/routers.ts`, add `getRemainingBatches` to the `./inventoryLedger` import and `listTransactions` to the `./payments` import:

```ts
import { getHomeSummary, getStockDashboard, getMoneyDashboard } from "./dashboards";
import { getRemainingBatches } from "./inventoryLedger";
```

```ts
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments, listTransactions } from "./payments";
```

Add a new top-level router key, alongside `dashboards`/`catalog`/etc.:

```ts
  inventoryLedger: router({
    remainingBatches: protectedProcedure
      .input(z.object({ skuId: z.number(), warehouseId: z.number() }))
      .query(({ input }) => getRemainingBatches(input.skuId, input.warehouseId)),
  }),
```

Add `listTransactions` to the existing `payments` router:

```ts
  payments: router({
    listForPo: protectedProcedure.input(z.number()).query(({ input }) => listPaymentsForPo(input)),
    listUnmatchedTransactions: protectedProcedure.query(() => listUnmatchedTransactions()),
    listTransactions: protectedProcedure.query(() => listTransactions()),
    listUnpaid: protectedProcedure.query(() => listUnpaidPayments()),
    // ...rest unchanged...
  }),
```

- [ ] **Step 6: Verify types and run the full suite**

Run: `set -a && source .env && set +a && pnpm check && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/payments.ts server/routers.ts server/payments.test.ts
git commit -m "feat: add inventoryLedger.remainingBatches and payments.listTransactions procedures"
```

---

### Task 5: Frontend — Stock warehouse toggle + Inventory Ledger drill-down

**Files:**
- Modify: `client/src/pages/StockPage.tsx`
- Create: `client/src/pages/InventoryLedgerPage.tsx`
- Modify: `client/src/main.tsx` (new route)

**Interfaces:**
- Consumes: `trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId })` (Task 4); `trpc.catalog.listWarehouses.useQuery()` (existing); `trpc.dashboards.stock.useQuery()` (existing, unchanged shape).
- Produces: no new interfaces consumed by later tasks — this is the last task touching Stock-related UI in this plan.

- [ ] **Step 1: Add the FF/Mutual toggle and Batches link to `StockPage.tsx`**

In `client/src/pages/StockPage.tsx`, inside `export function StockPage()`, add state and a filter, and a link column. The full updated function (only `StockPage` changes — `SalesPlanSection`, `defaultSalesPlanForm`, `STATUS_BADGE_CLASS` stay exactly as they are):

```tsx
export function StockPage() {
  const stockQuery = trpc.dashboards.stock.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [warehouseFilter, setWarehouseFilter] = useState<number | "all">("all");

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
      <div>
        <button onClick={() => setWarehouseFilter("all")} disabled={warehouseFilter === "all"}>All warehouses</button>
        {(warehousesQuery.data ?? []).map((w) => (
          <button key={w.id} onClick={() => setWarehouseFilter(w.id)} disabled={warehouseFilter === w.id}>
            {w.code}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Warehouse</th>
            <th>SOH</th>
            <th>Avg daily sales</th>
            <th>Days of cover</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((row) =>
            row.byWarehouse
              .filter((w) => warehouseFilter === "all" || w.warehouseId === warehouseFilter)
              .map((w) => (
                <tr key={`${row.skuId}-${w.warehouseId}`}>
                  <td>{row.sku}</td>
                  <td>{warehouseLabels.get(w.warehouseId) ?? `#${w.warehouseId}`}</td>
                  <td>{w.soh}</td>
                  <td>{w.avgDailySales.toFixed(2)}</td>
                  <td>{w.daysOfCover === null ? "—" : w.daysOfCover.toFixed(1)}</td>
                  <td><span className={STATUS_BADGE_CLASS[w.status]}>{w.status}</span></td>
                  <td><Link to={`/inventory-ledger/${row.skuId}/${w.warehouseId}`}>Batches</Link></td>
                </tr>
              )),
          )}
        </tbody>
      </table>
      <SalesPlanSection warehouseFilter={warehouseFilter} />
    </div>
  );
}
```

Add `Link` to the `react-router-dom` import at the top of the file (there is currently no import from `react-router-dom` in this file — add a new import line: `import { Link } from "react-router-dom";`).

Update `SalesPlanSection` to accept and use the toggle as its warehouse `<select>`'s default, without removing the ability to change it independently. Change its signature and the warehouse select's default value:

```tsx
function SalesPlanSection({ warehouseFilter }: { warehouseFilter: number | "all" }) {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [form, setForm] = useState<SalesPlanFormState>(() => ({
    ...defaultSalesPlanForm(),
    warehouseId: warehouseFilter === "all" ? "" : String(warehouseFilter),
  }));
```

(The rest of `SalesPlanSection`'s body is unchanged — only the function signature and the `useState` initializer above change. The `<select>` for warehouse already reads `value={form.warehouseId}` and lets the user change it via `onChange`, so this only affects the initial/default selection, matching spec section 7's "pre-selects the toggled warehouse... but stays independently changeable.")

- [ ] **Step 2: Create `InventoryLedgerPage.tsx`**

```tsx
// client/src/pages/InventoryLedgerPage.tsx
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

- [ ] **Step 3: Add the route**

In `client/src/main.tsx`, add the import:

```tsx
import { InventoryLedgerPage } from "./pages/InventoryLedgerPage";
```

Add a route component next to `ChangeLogRoute` (same file, same pattern):

```tsx
function InventoryLedgerRoute() {
  const { skuId, warehouseId } = useParams<{ skuId: string; warehouseId: string }>();
  const parsedSkuId = Number(skuId);
  const parsedWarehouseId = Number(warehouseId);
  if (!skuId || !warehouseId || Number.isNaN(parsedSkuId) || Number.isNaN(parsedWarehouseId)) {
    return <div>Invalid SKU or warehouse id</div>;
  }
  return <InventoryLedgerPage skuId={parsedSkuId} warehouseId={parsedWarehouseId} />;
}
```

Add the route inside the `<Route element={<RequireAuth />}>` block, next to the existing `change-log` route:

```tsx
              <Route path="/change-log/:entityType/:entityId" element={<ChangeLogRoute />} />
              <Route path="/inventory-ledger/:skuId/:warehouseId" element={<InventoryLedgerRoute />} />
```

- [ ] **Step 4: Type-check and manually verify**

Run: `set -a && source .env && set +a && pnpm check`
Expected: PASS.

Run: `pnpm build`
Expected: succeeds (this task is client-only; the build step is the fastest way to catch a JSX/import mistake without starting the dev server).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/StockPage.tsx client/src/pages/InventoryLedgerPage.tsx client/src/main.tsx
git commit -m "feat: Stock FF/Mutual toggle and Inventory Ledger batch drill-down"
```

---

### Task 6: Frontend — Transactions page, Money page cleanup

**Files:**
- Create: `client/src/pages/TransactionsPage.tsx`
- Modify: `client/src/pages/MoneyPage.tsx`
- Modify: `client/src/main.tsx` (new route)
- Modify: `client/src/components/nav/AppNav.tsx` (add Transactions link, relabel Money)

**Interfaces:**
- Consumes: `trpc.payments.listTransactions.useQuery()`, `trpc.payments.listUnpaid.useQuery()`, `trpc.payments.matchTransaction.useMutation()` (all existing or Task 4).
- Produces: no new interfaces consumed by later tasks.

- [ ] **Step 1: Create `TransactionsPage.tsx`**

Move `MatchTransactionRow` out of `MoneyPage.tsx` into this new file, and build a full list (not just unmatched):

```tsx
// client/src/pages/TransactionsPage.tsx
import { useState } from "react";
import { trpc } from "../lib/trpc";

function MatchTransactionRow({ transaction, unpaidPayments, onMatched }: { transaction: { id: number; amount: string; currency: string; date: Date; counterparty?: string | null }; unpaidPayments: Array<{ id: number; sequenceNo: number; expectedAmount: string; currency: string; poNumber: string | null }>; onMatched: () => void }) {
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("");
  const matchTransaction = trpc.payments.matchTransaction.useMutation({ onSuccess: onMatched });

  return (
    <>
      <select value={selectedPaymentId} onChange={(e) => setSelectedPaymentId(e.target.value)}>
        <option value="">Match to payment…</option>
        {unpaidPayments.map((p) => (
          <option key={p.id} value={p.id}>{p.poNumber ?? "no PO"} — #{p.sequenceNo} — {p.expectedAmount} {p.currency}</option>
        ))}
      </select>
      <button
        disabled={!selectedPaymentId || matchTransaction.isPending}
        onClick={() => matchTransaction.mutate({ transactionId: transaction.id, paymentId: Number(selectedPaymentId) })}
      >
        Match
      </button>
      {matchTransaction.error && <div>Failed to match: {matchTransaction.error.message}</div>}
    </>
  );
}

export function TransactionsPage() {
  const utils = trpc.useUtils();
  const transactionsQuery = trpc.payments.listTransactions.useQuery();
  const unpaidQuery = trpc.payments.listUnpaid.useQuery();

  const error = transactionsQuery.error ?? unpaidQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = transactionsQuery.isLoading || unpaidQuery.isLoading;
  if (isLoading || !transactionsQuery.data) return <div>Loading…</div>;

  const onMatched = () => {
    utils.payments.listTransactions.invalidate();
    utils.payments.listUnpaid.invalidate();
    utils.dashboards.money.invalidate();
  };

  return (
    <div>
      <h1>Transactions</h1>
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Counterparty</th><th>Status</th></tr></thead>
        <tbody>
          {transactionsQuery.data.map((tx) => (
            <tr key={tx.id}>
              <td>{new Date(tx.date).toISOString().slice(0, 10)}</td>
              <td>{tx.amount} {tx.currency}</td>
              <td>{tx.counterparty ?? "—"}</td>
              <td>
                {tx.matchedPaymentId != null ? (
                  "Matched"
                ) : (
                  <MatchTransactionRow transaction={tx} unpaidPayments={unpaidQuery.data ?? []} onMatched={onMatched} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Remove the matching UI from `MoneyPage.tsx`**

In `client/src/pages/MoneyPage.tsx`, delete the `MatchTransactionRow` function (lines 4-30) entirely, remove the `unpaidQuery` fetch and its inclusion in the `error`/`isLoading` computations, remove the `onMatched` function, and remove the "Unmatched transactions" block from the `tab === "cashflow"` branch. The resulting file:

```tsx
import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

export function MoneyPage() {
  const [tab, setTab] = useState<"cashflow" | "landed_cost" | "daily_cogs">("cashflow");

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

  return (
    <div>
      <h1>Cost & Cashflow</h1>
      <div>
        <button onClick={() => setTab("cashflow")}>Cashflow</button>
        <button onClick={() => setTab("landed_cost")}>Landed Cost</button>
        <button onClick={() => setTab("daily_cogs")}>Daily COGS/Sales</button>
      </div>
      {tab === "cashflow" && (
        <table>
          <thead><tr><th>Date</th><th>Planned</th><th>Actual</th></tr></thead>
          <tbody>
            {data.cashflow.map((d) => (
              <tr key={d.date}><td>{d.date}</td><td>{d.plannedOutflow.toFixed(2)}</td><td>{d.actualOutflow.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
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
        data.landedCostError ? (
          <div>Failed to compute landed cost: {data.landedCostError}</div>
        ) : (
          <table>
            <thead><tr><th>SKU</th><th>Landed unit cost</th></tr></thead>
            <tbody>
              {data.landedCost.map((row) => (
                <tr key={row.skuId}><td>{row.skuId}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}
```

(Note `data.unmatchedTransactions` is no longer read here — it's still returned by `dashboards.money` unchanged, simply unused by this page now. No backend change needed.)

- [ ] **Step 3: Add the route and nav link**

In `client/src/main.tsx`, add the import and route:

```tsx
import { TransactionsPage } from "./pages/TransactionsPage";
```

```tsx
              <Route path="/money" element={<MoneyPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
```

In `client/src/components/nav/AppNav.tsx`, update `NAV_ITEMS`:

```tsx
const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Cost & Cashflow" },
  { to: "/transactions", label: "Transactions" },
];
```

(Catalog is added to this same array in Task 7 — don't add it here to avoid a merge-order assumption between tasks; Task 7 edits this array again.)

- [ ] **Step 4: Type-check and build**

Run: `set -a && source .env && set +a && pnpm check && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/TransactionsPage.tsx client/src/pages/MoneyPage.tsx client/src/main.tsx client/src/components/nav/AppNav.tsx
git commit -m "feat: split Transactions into its own page, relabel Money to Cost & Cashflow"
```

---

### Task 7: Frontend — Catalog page, nav finalized

**Files:**
- Create: `client/src/pages/CatalogPage.tsx`
- Modify: `client/src/main.tsx` (new route)
- Modify: `client/src/components/nav/AppNav.tsx` (add Catalog link)

**Interfaces:**
- Consumes: `trpc.catalog.listSkus/createSku/listVendors/createVendor/listWarehouses/createWarehouse` (all already exist, unchanged).
- Produces: nothing consumed by a later task — this is the final task in the plan.

- [ ] **Step 1: Create `CatalogPage.tsx`**

```tsx
// client/src/pages/CatalogPage.tsx
import { useState } from "react";
import { trpc } from "../lib/trpc";

function SkusSection() {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [primaryIdentifierType, setPrimaryIdentifierType] = useState("sku");
  const createSku = trpc.catalog.createSku.useMutation({
    onSuccess: () => {
      setSku("");
      setName("");
      utils.catalog.listSkus.invalidate();
    },
  });

  if (skusQuery.error) return <div>Failed to load SKUs: {skusQuery.error.message}</div>;

  return (
    <div>
      <h2>SKUs</h2>
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Identifier Type</th></tr></thead>
        <tbody>
          {(skusQuery.data ?? []).map((s) => (
            <tr key={s.id}><td>{s.sku ?? "—"}</td><td>{s.name ?? "—"}</td><td>{s.primaryIdentifierType}</td></tr>
          ))}
        </tbody>
      </table>
      <div>
        <input placeholder="SKU code" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={primaryIdentifierType} onChange={(e) => setPrimaryIdentifierType(e.target.value)}>
          <option value="sku">sku</option>
          <option value="barcode">barcode</option>
        </select>
        <button
          disabled={createSku.isPending || (!sku && !name)}
          onClick={() => createSku.mutate({ sku: sku || undefined, name: name || undefined, primaryIdentifierType })}
        >
          Add SKU
        </button>
        {createSku.error && <div>Failed to save: {createSku.error.message}</div>}
      </div>
    </div>
  );
}

function VendorsSection() {
  const utils = trpc.useUtils();
  const vendorsQuery = trpc.catalog.listVendors.useQuery();
  const [name, setName] = useState("");
  const createVendor = trpc.catalog.createVendor.useMutation({
    onSuccess: () => {
      setName("");
      utils.catalog.listVendors.invalidate();
    },
  });

  if (vendorsQuery.error) return <div>Failed to load vendors: {vendorsQuery.error.message}</div>;

  return (
    <div>
      <h2>Vendors</h2>
      <table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody>
          {(vendorsQuery.data ?? []).map((v) => (<tr key={v.id}><td>{v.name}</td></tr>))}
        </tbody>
      </table>
      <div>
        <input placeholder="vendor name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={createVendor.isPending || !name} onClick={() => createVendor.mutate({ name })}>
          Add Vendor
        </button>
        {createVendor.error && <div>Failed to save: {createVendor.error.message}</div>}
      </div>
    </div>
  );
}

function WarehousesSection() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const createWarehouse = trpc.catalog.createWarehouse.useMutation({
    onSuccess: () => {
      setCode("");
      setName("");
      utils.catalog.listWarehouses.invalidate();
    },
  });

  if (warehousesQuery.error) return <div>Failed to load warehouses: {warehousesQuery.error.message}</div>;

  return (
    <div>
      <h2>Warehouses</h2>
      <table>
        <thead><tr><th>Code</th><th>Name</th></tr></thead>
        <tbody>
          {(warehousesQuery.data ?? []).map((w) => (<tr key={w.id}><td>{w.code}</td><td>{w.name}</td></tr>))}
        </tbody>
      </table>
      <div>
        <input placeholder="code (e.g. FF-DE)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={createWarehouse.isPending || !code || !name} onClick={() => createWarehouse.mutate({ code, name })}>
          Add Warehouse
        </button>
        {createWarehouse.error && <div>Failed to save: {createWarehouse.error.message}</div>}
      </div>
    </div>
  );
}

export function CatalogPage() {
  return (
    <div>
      <h1>Catalog</h1>
      <SkusSection />
      <VendorsSection />
      <WarehousesSection />
    </div>
  );
}
```

- [ ] **Step 2: Add the route and nav link**

In `client/src/main.tsx`:

```tsx
import { CatalogPage } from "./pages/CatalogPage";
```

```tsx
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/catalog" element={<CatalogPage />} />
```

In `client/src/components/nav/AppNav.tsx`, finalize `NAV_ITEMS`:

```tsx
const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Cost & Cashflow" },
  { to: "/transactions", label: "Transactions" },
  { to: "/catalog", label: "Catalog" },
];
```

- [ ] **Step 3: Type-check and build**

Run: `set -a && source .env && set +a && pnpm check && pnpm build`
Expected: PASS.

- [ ] **Step 4: Manual verification with the real dev server**

Start the backend (`pnpm dev`, backgrounded) and the client (`pnpm exec vite`, backgrounded), per this repo's established two-process dev setup. Log in, then visit `/stock` (confirm the FF/Mutual toggle filters rows and a "Batches" link navigates to `/inventory-ledger/:skuId/:warehouseId` showing a table), `/transactions` (confirm it lists transactions with match status), `/money` (confirm the matching UI is gone, the 3 sub-tabs still work), `/catalog` (confirm SKU/Vendor/Warehouse lists and create forms work). Kill both background processes afterward.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CatalogPage.tsx client/src/main.tsx client/src/components/nav/AppNav.tsx
git commit -m "feat: add Catalog page, finalize navigation"
```
