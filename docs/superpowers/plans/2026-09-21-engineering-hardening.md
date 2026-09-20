# Engineering Hardening (Cherny lens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every bounded Engineering (Cherny-lens) finding from the three-lens architecture review: unify duplicate FIFO logic, delete dead code, make status-changing writes atomic, standardize not-found handling, add missing FKs/indexes, and migrate money columns from `varchar` to `decimal`.

**Architecture:** Seven independent-ish tasks against the existing `accommerce-inventory` codebase — no new subsystems, only refactors, a shared-schema-migration pair, and one file-extension rename. Each task is scoped to specific existing files with exact before/after code.

**Tech Stack:** Node/Express + tRPC v11 + Drizzle ORM (MySQL/TiDB) + Vitest, same as the rest of the repo.

**Spec:** `docs/2026-09-21-engineering-hardening-design.md`

## Global Constraints

- Working directly on `main`, no worktree — same convention as every prior stream in this repo.
- Load env before any DB-touching command: `set -a && source .env && set +a`.
- `pnpm check` (`tsc --noEmit`) and `pnpm test` (`vitest run`) must both stay green after every task.
- No behavior change except where a task explicitly says so (atomicity, not-found guards). The FIFO unification and dead-code removal must be byte-identical-output refactors, proven by every existing test passing unchanged.
- Every schema change ships as a real migration (`pnpm exec drizzle-kit generate`), applied to the local dev DB (`pnpm exec drizzle-kit migrate`) and verified there, not just generated.
- Commit after each task, following this repo's commit message convention (`type: summary`, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer).

---

### Task 1: Unify the FIFO replay logic

**Files:**
- Modify: `server/inventoryLedger.ts` (add `FifoBatch`, `replayLedgerEventsFifo`; rewrite `getRemainingBatches` to use it)
- Modify: `server/salesPlan.ts` (rewrite `getDailyCogsForRange` to use `replayLedgerEventsFifo`)
- Test: `server/inventoryLedger.test.ts`, `server/salesPlan.test.ts` (existing tests must pass unchanged — no new tests required for this task, since it's a pure refactor and the existing suites already cover both functions' behavior)

**Interfaces:**
- Produces: `export interface FifoBatch { qty: number; unitCost: number; date: Date; sourceRef: string | null }` and `export function replayLedgerEventsFifo(events: LedgerEvent[], onSaleConsumed?: (event: LedgerEvent, consumedCost: number) => void): FifoBatch[]` from `server/inventoryLedger.ts`. `LedgerEvent` is already exported from `../drizzle/schema` and already imported in both files.

- [ ] **Step 1: Add the shared primitive to `server/inventoryLedger.ts`**

Change the top-of-file import from:
```ts
import { inventoryLedger, type InsertLedgerEvent } from "../drizzle/schema";
```
to:
```ts
import { inventoryLedger, type InsertLedgerEvent, type LedgerEvent } from "../drizzle/schema";
```

Insert this above `getRemainingBatches` (keep the existing "Known, accepted ordering asymmetry" comment attached to `getRemainingBatches` itself, not to the new function, since it describes that function's own query ordering choice):

```ts
export interface FifoBatch {
  qty: number;
  unitCost: number;
  date: Date;
  sourceRef: string | null;
}

// Shared FIFO replay primitive used by getRemainingBatches (below) and by
// getDailyCogsForRange (server/salesPlan.ts) — previously two separate,
// drifting implementations of the exact same consume() loop. onSaleConsumed
// fires only for "sale" events, not adjustments: an adjustment consumes FIFO
// stock like a sale (a write-off/correction) but must never be counted as
// Daily COGS, since it isn't a sale.
export function replayLedgerEventsFifo(
  events: LedgerEvent[],
  onSaleConsumed?: (event: LedgerEvent, consumedCost: number) => void,
): FifoBatch[] {
  const batches: FifoBatch[] = [];

  const consume = (qtyToConsume: number, asOfDate: Date, context: string): number => {
    let remaining = qtyToConsume;
    let consumedCost = 0;
    while (remaining > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= asOfDate);
      if (!batch) throw new Error(`replayLedgerEventsFifo: insufficient stock to consume ${remaining} units for ${context}`);
      const consumed = Math.min(batch.qty, remaining);
      consumedCost += consumed * batch.unitCost;
      batch.qty -= consumed;
      remaining -= consumed;
    }
    return consumedCost;
  };

  for (const event of events) {
    if (event.eventType === "receipt") {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    } else if (event.eventType === "sale") {
      const consumedCost = consume(Math.abs(event.qty), event.date, `sale event ${event.id}`);
      onSaleConsumed?.(event, consumedCost);
    } else if (event.qty < 0) {
      consume(Math.abs(event.qty), event.date, `adjustment event ${event.id}`);
    } else if (event.qty > 0) {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    }
  }

  return batches;
}
```

- [ ] **Step 2: Rewrite `getRemainingBatches` to call the new primitive**

Replace the function body (keep its existing query, its "Known, accepted ordering asymmetry" comment, and its exact return shape/sort):

```ts
export async function getRemainingBatches(skuId: number, warehouseId: number): Promise<RemainingBatch[]> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date, inventoryLedger.id);

  const batches = replayLedgerEventsFifo(events);

  return batches
    .filter((b) => b.qty > 0)
    .map((b) => ({ batchDate: b.date, sourceRef: b.sourceRef, unitCost: b.unitCost, remainingQty: b.qty }))
    .sort((a, b) => a.batchDate.getTime() - b.batchDate.getTime());
}
```

- [ ] **Step 3: Run `server/inventoryLedger.test.ts` and confirm every test still passes unchanged**

Run: `set -a && source .env && set +a && pnpm test inventoryLedger`
Expected: all existing tests PASS, same count as before this task.

- [ ] **Step 4: Rewrite `getDailyCogsForRange` in `server/salesPlan.ts` to call the new primitive**

Replace the function body (keep the existing query, the JSDoc comment above it, and the exact return shape):

```ts
export async function getDailyCogsForRange(skuId: number, warehouseId: number, dateKeys: string[]): Promise<{ date: string; cogs: number }[]> {
  if (dateKeys.length === 0) return [];

  const windowEnd = new Date(`${dateKeys[dateKeys.length - 1]}T23:59:59.999Z`);
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId), lte(inventoryLedger.date, windowEnd)))
    .orderBy(inventoryLedger.date, inventoryLedger.id);

  const dailyCogs = new Map<string, number>(dateKeys.map((d) => [d, 0]));

  replayLedgerEventsFifo(events, (event, consumedCost) => {
    const dateKey = event.date.toISOString().slice(0, 10);
    if (dailyCogs.has(dateKey)) {
      dailyCogs.set(dateKey, dailyCogs.get(dateKey)! + consumedCost);
    }
  });

  return dateKeys.map((date) => ({ date, cogs: dailyCogs.get(date)! }));
}
```

Update this file's imports: add `replayLedgerEventsFifo` to the existing `import { ... } from "./inventoryLedger"` line, and remove the now-unused `import type { LandedBatch } from "./landedCost"` line entirely (check with a repo-wide grep that nothing else in this file still references `LandedBatch` before removing the import — Step 5 below deletes the type's only other usage anyway, but this file's import must go regardless of task order since it will otherwise be a compile error the moment Task 2 deletes the type).

- [ ] **Step 5: Run the full test suite**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all tests PASS (same total count as before this task), `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add server/inventoryLedger.ts server/salesPlan.ts
git commit -m "refactor: unify the two live FIFO implementations behind one shared function

getRemainingBatches and getDailyCogsForRange each independently implemented
the exact same FIFO consume() loop over ledger events, which had already
drifted once (adjustment handling) before being caught and fixed. Extracts
replayLedgerEventsFifo as the one shared primitive both now call.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Delete dead code (`computeFifoCogs`, `updateSku`)

**Files:**
- Modify: `server/landedCost.ts` (delete `computeFifoCogs`, `LandedBatch`, `SaleEvent`, `FifoCogsResult`)
- Modify: `server/landedCost.test.ts` (delete the `describe("computeFifoCogs", ...)` block)
- Modify: `server/db.ts` (delete `updateSku`)

**Interfaces:**
- Consumes: Task 1 must be complete first — `server/salesPlan.ts` must no longer import `LandedBatch` from `./landedCost` before this task deletes that type (verified as part of Task 1 Step 4 above).

- [ ] **Step 1: Confirm no remaining references before deleting**

Run: `grep -rn "computeFifoCogs\|updateSku\b" server/ client/ --include="*.ts" --include="*.tsx" | grep -v ".test.ts"`
Expected: only the definitions themselves (`server/landedCost.ts`, `server/db.ts`) — no call sites. If any call site appears, stop and report it (do not delete a function something still calls).

Run: `grep -rn "LandedBatch\|SaleEvent\b\|FifoCogsResult" server/ --include="*.ts" | grep -v ".test.ts"`
Expected: only `server/landedCost.ts`'s own definitions — `server/salesPlan.ts` must NOT appear (Task 1 already removed its import).

- [ ] **Step 2: Delete `computeFifoCogs` and its now-fully-dead types from `server/landedCost.ts`**

Delete the `LandedBatch`, `SaleEvent`, `FifoCogsResult` interfaces and the `computeFifoCogs` function (currently lines 13-52, per the design doc's line references — re-locate by content, not line number, since earlier tasks may have shifted lines). Leave the JSDoc comment block that currently sits above `LandedBatch` (the one about "unitCost must already be expressed in the instance's single reporting currency") — check whether it still makes sense floating above whatever remains after deletion (likely `getShipmentLandedUnitCost`'s own section); if it clearly belongs to the deleted code and nothing else, delete the comment too.

- [ ] **Step 3: Delete the dead test block from `server/landedCost.test.ts`**

Delete the entire `describe("computeFifoCogs", () => { ... })` block (3 `it(...)` cases) and its `computeFifoCogs` import from the `import { computeFifoCogs, getShipmentLandedUnitCost } from "./landedCost";` line (leave `getShipmentLandedUnitCost` imported).

- [ ] **Step 4: Delete `updateSku` from `server/db.ts`**

Delete the function:
```ts
export async function updateSku(id: number, data: Partial<InsertSku>) {
  await db.update(skus).set(data).where(eq(skus.id, id));
  const [row] = await db.select().from(skus).where(eq(skus.id, id));
  return row;
}
```
Leave `InsertSku` imported/exported if anything else in the file still uses it (it does — `createSku`'s parameter type).

- [ ] **Step 5: Run the full suite**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all tests PASS with the deleted tests gone (total count drops by exactly 3), `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add server/landedCost.ts server/landedCost.test.ts server/db.ts
git commit -m "refactor: delete dead code (computeFifoCogs, updateSku)

Both were confirmed zero-caller dead code by repo-wide grep. computeFifoCogs
was superseded by the FIFO unification in the previous commit, which left
its LandedBatch/SaleEvent/FifoCogsResult types with no remaining use either.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Atomicity for `purchaseOrders.ts` writes

**Files:**
- Modify: `server/purchaseOrders.ts` (`updatePurchaseOrderStatus`, `updatePurchaseOrderPlannedReadyDate`)
- Test: `server/purchaseOrders.test.ts` (add coverage per step 3 below)

**Interfaces:**
- No signature changes to either function — same parameters, same return type (`Promise<void>` for both, unchanged).

- [ ] **Step 1: Wrap `updatePurchaseOrderStatus` in a transaction**

Replace:
```ts
export async function updatePurchaseOrderStatus(
  id: number,
  newStatus: (typeof PO_STATUSES)[number],
  opts: { reasonCategory?: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  if (!VALID_TRANSITIONS[po.status].includes(newStatus)) {
    throw new Error(`invalid transition from ${po.status} to ${newStatus}`);
  }
  await db.update(purchaseOrders).set({ status: newStatus }).where(eq(purchaseOrders.id, id));
  await logChange({
    entityType: "purchase_order",
    entityId: id,
    field: "status",
    oldValue: po.status,
    newValue: newStatus,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```
with:
```ts
export async function updatePurchaseOrderStatus(
  id: number,
  newStatus: (typeof PO_STATUSES)[number],
  opts: { reasonCategory?: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  await db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) {
      throw new Error(`updatePurchaseOrderStatus: no purchase order found with id ${id}`);
    }
    if (!VALID_TRANSITIONS[po.status].includes(newStatus)) {
      throw new Error(`invalid transition from ${po.status} to ${newStatus}`);
    }
    await tx.update(purchaseOrders).set({ status: newStatus }).where(eq(purchaseOrders.id, id));
    await logChange({
      entityType: "purchase_order",
      entityId: id,
      field: "status",
      oldValue: po.status,
      newValue: newStatus,
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}
```
(This also adds the not-found guard `updatePurchaseOrderStatus` was previously missing — confirmed by reading the current code, which used `po.status` unguarded.)

- [ ] **Step 2: Wrap `updatePurchaseOrderPlannedReadyDate` in a transaction**

Replace:
```ts
export async function updatePurchaseOrderPlannedReadyDate(
  id: number,
  newDate: string,
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  await db.update(purchaseOrders).set({ plannedReadyDate: newDate }).where(eq(purchaseOrders.id, id));
  await logChange({
    entityType: "purchase_order",
    entityId: id,
    field: "plannedReadyDate",
    oldValue: po.plannedReadyDate ?? null,
    newValue: newDate,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```
with:
```ts
export async function updatePurchaseOrderPlannedReadyDate(
  id: number,
  newDate: string,
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  await db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) {
      throw new Error(`updatePurchaseOrderPlannedReadyDate: no purchase order found with id ${id}`);
    }
    await tx.update(purchaseOrders).set({ plannedReadyDate: newDate }).where(eq(purchaseOrders.id, id));
    await logChange({
      entityType: "purchase_order",
      entityId: id,
      field: "plannedReadyDate",
      oldValue: po.plannedReadyDate ?? null,
      newValue: newDate,
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}
```

- [ ] **Step 3: Add a not-found test for each function**

Add to `server/purchaseOrders.test.ts`:
```ts
it("rejects updating the status of a nonexistent purchase order with a clear error", async () => {
  await expect(
    updatePurchaseOrderStatus(999999, "confirmed", { changedBy: 1 }),
  ).rejects.toThrow(/no purchase order found/);
});

it("rejects updating the planned ready date of a nonexistent purchase order with a clear error", async () => {
  await expect(
    updatePurchaseOrderPlannedReadyDate(999999, "2026-10-01", { reasonCategory: "logistics_delay", changedBy: 1 }),
  ).rejects.toThrow(/no purchase order found/);
});
```
Import `updatePurchaseOrderPlannedReadyDate` alongside the existing `updatePurchaseOrderStatus` import if it isn't already imported in this test file.

- [ ] **Step 4: Run the suite**

Run: `set -a && source .env && set +a && pnpm test purchaseOrders && pnpm check`
Expected: all pass, including the 2 new tests.

- [ ] **Step 5: Commit**

```bash
git add server/purchaseOrders.ts server/purchaseOrders.test.ts
git commit -m "fix: make purchase-order status/date updates atomic with their audit log

Both functions updated the row and called logChange as separate, unguarded
statements -- a crash between them would leave the change unaudited. Wraps
each in one transaction, matching the core/wrapper pattern already
established for payments in the prior Operational-cleanup session, and adds
the not-found guard both were missing (previously an unguarded crash).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Atomicity and not-found guards for `shipments.ts` writes

**Files:**
- Modify: `server/shipments.ts` (`updateShipmentPlannedDepartDate`, `updateShipmentStatus`, `markShipmentDeparted`, `recordShipmentCosts`, `setShipmentCustomsStatus`, `correctShipmentActualDepartDate`)
- Test: `server/shipments.test.ts` (add coverage per step 6 below)

**Interfaces:**
- `setShipmentCustomsStatus` and `correctShipmentActualDepartDate` currently accept an optional `dbClient: DbClient = db` parameter. Drop it from both signatures — verified by grep (see design doc section 3) that neither is ever called from inside an existing transaction, so "always open one transaction inside the function" is strictly simpler and equally correct. Update both router call sites in `server/routers.ts` if they pass a `dbClient` argument explicitly (they don't — confirm with `grep -n "setShipmentCustomsStatus\|correctShipmentActualDepartDate" server/routers.ts` before editing, and only touch `routers.ts` if a call site actually needs updating).

- [ ] **Step 1: `updateShipmentPlannedDepartDate` — add guard, wrap in transaction**

Replace:
```ts
export async function updateShipmentPlannedDepartDate(
  id: number,
  newDate: Date,
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  await db.update(shipments).set({ plannedDepartDate: newDate }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "plannedDepartDate",
    oldValue: shipment.plannedDepartDate?.toISOString().slice(0, 10) ?? null,
    newValue: newDate.toISOString().slice(0, 10),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
```
with:
```ts
export async function updateShipmentPlannedDepartDate(
  id: number,
  newDate: Date,
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`updateShipmentPlannedDepartDate: no shipment found with id ${id}`);
    }
    await tx.update(shipments).set({ plannedDepartDate: newDate }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "plannedDepartDate",
      oldValue: shipment.plannedDepartDate?.toISOString().slice(0, 10) ?? null,
      newValue: newDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}
```
Keep the existing calendar-day comment attached to the `oldValue`/`newValue` lines exactly as it is today — this step only adds the guard and transaction wrapper around it.

- [ ] **Step 2: `updateShipmentStatus` and `markShipmentDeparted` — wrap in transaction (guards already present)**

Both already have the `if (!shipment) throw ...` guard. Wrap each body in `db.transaction(async (tx) => {...})`, changing every `db.select`/`db.update` inside to `tx.select`/`tx.update` and passing `tx` as the second argument to `logChange`. No other logic changes — the two early-throw checks in `updateShipmentStatus` for `newStatus === "departed"` / `"delivered"` stay outside the transaction (they don't touch the DB, no need to open one just to check the input).

- [ ] **Step 3: `recordShipmentCosts` — add guard, wrap in transaction**

Replace:
```ts
export async function recordShipmentCosts(
  id: number,
  costs: { freightCost: string; dutyCost: string; costCurrency: string },
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
): Promise<Shipment> {
  const [before] = await db.select().from(shipments).where(eq(shipments.id, id));
  await db.update(shipments).set(costs).where(eq(shipments.id, id));

  await logChange({
    entityType: "shipment", entityId: id, field: "freightCost",
    oldValue: before.freightCost, newValue: costs.freightCost,
    reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
  });
  await logChange({
    entityType: "shipment", entityId: id, field: "dutyCost",
    oldValue: before.dutyCost, newValue: costs.dutyCost,
    reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
  });

  const [row] = await db.select().from(shipments).where(eq(shipments.id, id));
  return row;
}
```
with:
```ts
export async function recordShipmentCosts(
  id: number,
  costs: { freightCost: string; dutyCost: string; costCurrency: string },
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
): Promise<Shipment> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!before) {
      throw new Error(`recordShipmentCosts: no shipment found with id ${id}`);
    }
    await tx.update(shipments).set(costs).where(eq(shipments.id, id));

    await logChange({
      entityType: "shipment", entityId: id, field: "freightCost",
      oldValue: before.freightCost, newValue: costs.freightCost,
      reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
    }, tx);
    await logChange({
      entityType: "shipment", entityId: id, field: "dutyCost",
      oldValue: before.dutyCost, newValue: costs.dutyCost,
      reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
    }, tx);

    const [row] = await tx.select().from(shipments).where(eq(shipments.id, id));
    return row;
  });
}
```

- [ ] **Step 4: `setShipmentCustomsStatus` — drop the `dbClient` parameter, add guard, wrap in transaction**

Replace:
```ts
export async function setShipmentCustomsStatus(
  id: number,
  newStatus: (typeof CUSTOMS_STATUSES)[number],
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  await dbClient.update(shipments).set({ customsStatus: newStatus }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment", entityId: id, field: "customsStatus",
    oldValue: shipment.customsStatus, newValue: newStatus,
    reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
  });
}
```
with:
```ts
export async function setShipmentCustomsStatus(
  id: number,
  newStatus: (typeof CUSTOMS_STATUSES)[number],
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`setShipmentCustomsStatus: no shipment found with id ${id}`);
    }
    await tx.update(shipments).set({ customsStatus: newStatus }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment", entityId: id, field: "customsStatus",
      oldValue: shipment.customsStatus, newValue: newStatus,
      reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
    }, tx);
  });
}
```

- [ ] **Step 5: `correctShipmentActualDepartDate` — drop the `dbClient` parameter, add guard, wrap in transaction**

Replace:
```ts
export async function correctShipmentActualDepartDate(
  id: number,
  newDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
  dbClient: DbClient = db,
): Promise<void> {
  const [shipment] = await dbClient.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment.actualDepartDate) {
    throw new Error(
      "correctShipmentActualDepartDate: no actual depart date is set yet on this shipment — " +
      "use the normal departure flow to set it for the first time, this function only corrects an existing value",
    );
  }
  await dbClient.update(shipments).set({ actualDepartDate: newDate }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment", entityId: id, field: "actualDepartDate",
    oldValue: shipment.actualDepartDate.toISOString().slice(0, 10),
    newValue: newDate.toISOString().slice(0, 10),
    reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
  });
}
```
with:
```ts
export async function correctShipmentActualDepartDate(
  id: number,
  newDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`correctShipmentActualDepartDate: no shipment found with id ${id}`);
    }
    if (!shipment.actualDepartDate) {
      throw new Error(
        "correctShipmentActualDepartDate: no actual depart date is set yet on this shipment — " +
        "use the normal departure flow to set it for the first time, this function only corrects an existing value",
      );
    }
    await tx.update(shipments).set({ actualDepartDate: newDate }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment", entityId: id, field: "actualDepartDate",
      oldValue: shipment.actualDepartDate.toISOString().slice(0, 10),
      newValue: newDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory, reasonNote: opts.reasonNote, changedBy: opts.changedBy,
    }, tx);
  });
}
```

- [ ] **Step 6: Update call sites and add not-found tests**

Run `grep -n "setShipmentCustomsStatus\|correctShipmentActualDepartDate" server/routers.ts` — if either call site passes a 4th `dbClient` argument, remove it (per this task's own verification in the design doc, neither currently does).

Add to `server/shipments.test.ts` (matching whatever local helper this file already uses to create a test shipment — read the file's existing tests first for the exact fixture pattern, then use the same one):
```ts
it("rejects updating the planned depart date of a nonexistent shipment with a clear error", async () => {
  await expect(
    updateShipmentPlannedDepartDate(999999, new Date(), { reasonCategory: "logistics_delay", changedBy: 1 }),
  ).rejects.toThrow(/no shipment found/);
});

it("rejects recording costs for a nonexistent shipment with a clear error", async () => {
  await expect(
    recordShipmentCosts(999999, { freightCost: "100.00", dutyCost: "50.00", costCurrency: "EUR" }, { reasonCategory: "logistics_delay", changedBy: 1 }),
  ).rejects.toThrow(/no shipment found/);
});

it("rejects setting customs status for a nonexistent shipment with a clear error", async () => {
  await expect(
    setShipmentCustomsStatus(999999, "cleared", { reasonCategory: "customs_hold", changedBy: 1 }),
  ).rejects.toThrow(/no shipment found/);
});

it("rejects correcting the actual depart date for a nonexistent shipment with a clear error", async () => {
  await expect(
    correctShipmentActualDepartDate(999999, new Date(), { reasonCategory: "logistics_delay", changedBy: 1 }),
  ).rejects.toThrow(/no shipment found/);
});
```
(`"cleared"` is confirmed a real value of `CUSTOMS_STATUSES` — `["not_declared", "declared", "held", "cleared"]`, `drizzle/schema.ts:136`.)

- [ ] **Step 7: Run the suite**

Run: `set -a && source .env && set +a && pnpm test shipments && pnpm check`
Expected: all pass including the 4 new tests.

- [ ] **Step 8: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts server/routers.ts
git commit -m "fix: atomicity and consistent not-found guards across shipments.ts writes

6 of 9 mutation functions in this file updated a row and called logChange
as separate, unguarded statements, and 4 of those 6 used the selected row
unguarded (crashing with a raw TypeError instead of a clear domain error on
a nonexistent id) while 3 sibling functions in the same file already had
the correct guard. Standardizes every function to the same
select-guard-update-transaction shape, and drops the now-unused dbClient
parameter from the 2 functions that had it (verified neither is ever called
from inside an existing transaction).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Missing foreign keys and indexes

**Files:**
- Modify: `drizzle/schema.ts`
- Create: a new migration under `drizzle/` (via `drizzle-kit generate`)
- Test: `server/changeLog.test.ts`, `server/dashboards.test.ts` or a new small test file — verify the migration applies cleanly (see step 4)

- [ ] **Step 1: Add the missing `.references()` calls**

In `drizzle/schema.ts`, change these column definitions (find each by its current exact text first with grep, since line numbers shift as this plan's earlier tasks are not schema changes but earlier commits in this same stream might not affect this file at all — schema.ts is untouched by Tasks 1-4):

```ts
// changeLog table: changedBy
changedBy: int("changedBy").notNull().references(() => users.id),

// purchaseOrders table: vendorId, createdBy
vendorId: int("vendorId").notNull().references(() => vendors.id),
...
createdBy: int("createdBy").notNull().references(() => users.id),

// shipments table: createdBy
createdBy: int("createdBy").notNull().references(() => users.id),

// salesPlan table: skuId, warehouseId
skuId: int("skuId").notNull().references(() => skus.id),
warehouseId: int("warehouseId").notNull().references(() => warehouses.id),

// salesActuals table: skuId, warehouseId
skuId: int("skuId").notNull().references(() => skus.id),
warehouseId: int("warehouseId").notNull().references(() => warehouses.id),

// salesPlanWeeklyRecipeLines table: weeklyInputId
weeklyInputId: int("weeklyInputId").notNull().references(() => salesPlanWeeklyInputs.id),
```

`salesPlanWeeklyInputs` is defined earlier in the file than `salesPlanWeeklyRecipeLines` (confirm with `grep -n "export const salesPlanWeeklyInputs\|export const salesPlanWeeklyRecipeLines" drizzle/schema.ts`), so the forward reference is fine — Drizzle resolves `.references(() => table.column)` lazily via the arrow function, not at declaration time.

- [ ] **Step 2: Add the two new indexes**

In `changeLog`'s table config (it currently has no third `(table) => ({...})` argument — check by reading the table definition; if it's a plain 2-argument `mysqlTable(name, columns)` call, convert it to the 3-argument form):
```ts
export const changeLog = mysqlTable(
  "change_log",
  {
    // ...existing columns unchanged...
  },
  (table) => ({
    entityTypeIdIdx: index("change_log_entity_type_id_idx").on(table.entityType, table.entityId),
  }),
);
```

In `payments`'s table config (same check — convert to 3-argument form if it's currently 2-argument):
```ts
export const payments = mysqlTable(
  "payments",
  {
    // ...existing columns unchanged...
  },
  (table) => ({
    paidExpectedDateIdx: index("payments_paid_expected_date_idx").on(table.paid, table.expectedDate),
  }),
);
```

Before adding an index on `transactions.matchedPaymentId`, run against the real dev DB: `set -a && source .env && set +a && mysql -h 127.0.0.1 -u root -pdevpassword accommerce_dev -e "SHOW INDEX FROM transactions;"` (adjust connection details to match this repo's actual dev DB credentials from `.env` if they differ) and check whether an index already exists on that column (MySQL auto-creates one for most FK constraint definitions, but verify rather than assume). Add `matchedPaymentIdIdx: index("transactions_matched_payment_id_idx").on(table.matchedPaymentId)` to `transactions`'s table config only if the query shows none already exists.

- [ ] **Step 3: Generate the migration**

Run: `set -a && source .env && set +a && pnpm exec drizzle-kit generate`
Expected: a new migration file appears under `drizzle/`. Read its generated SQL before applying it — confirm it contains only `ADD CONSTRAINT ... FOREIGN KEY` and `CREATE INDEX` statements, nothing unexpected (a genuinely additive schema diff should never generate a `DROP` or a data-touching statement).

- [ ] **Step 4: Apply the migration to the dev DB and verify**

Run: `set -a && source .env && set +a && pnpm exec drizzle-kit migrate`
Expected: succeeds with no error. If it fails with a foreign key constraint error (meaning some existing row has a value with no matching parent row — e.g. a `changedBy` that isn't a real `users.id`), STOP and report the exact error rather than working around it; this would mean either a test fixture needs fixing or (less likely) real orphaned dev data needs cleaning up first — do not weaken the constraint to make the migration pass.

- [ ] **Step 5: Run the full suite**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass — adding FKs/indexes to already-consistent data and already-typed columns should not change any test's behavior.

- [ ] **Step 6: Commit**

```bash
git add drizzle/schema.ts drizzle/
git commit -m "fix: add missing foreign keys and query-pattern indexes

changeLog.changedBy, purchaseOrders.vendorId/createdBy, shipments.createdBy,
salesPlan/salesActuals's skuId+warehouseId, and
salesPlanWeeklyRecipeLines.weeklyInputId had no FK despite every one being a
real ownership edge. Adds a composite index on change_log(entityType,
entityId) (listChangeLog's only query shape) and on
payments(paid, expectedDate) (getCashflowForecast's filter, run on every
dashboard load) -- previously inventory_ledger was the only indexed table
in the whole schema.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `varchar` → `decimal` migration for money/share columns

**Files:**
- Modify: `drizzle/schema.ts` (import `decimal`; change column types per the table below)
- Create: a new migration under `drizzle/`
- Test: a new test proving round-trip precision (see step 4)

**Interfaces:**
- No application code changes — every reader already does `parseFloat(row.column)` and every writer already passes a plain string; `decimal(..., { mode: "string" })` keeps the TypeScript type as `string` on both sides.

- [ ] **Step 1: Add `decimal` to the schema.ts import**

Change:
```ts
import { date, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, index, unique, foreignKey } from "drizzle-orm/mysql-core";
```
to:
```ts
import { date, decimal, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, index, unique, foreignKey } from "drizzle-orm/mysql-core";
```

- [ ] **Step 2: Change each column's type**

Apply exactly this table (column name, current type, new type — find each by its current `varchar("<name>", ...)` text and replace only the type call, keeping `.notNull()`/nullability exactly as it already is):

| Table.column | New definition |
|---|---|
| `poLineItems.unitPrice` | `decimal("unitPrice", { precision: 18, scale: 4, mode: "string" }).notNull()` |
| `shipments.freightCost` | `decimal("freightCost", { precision: 18, scale: 4, mode: "string" })` |
| `shipments.dutyCost` | `decimal("dutyCost", { precision: 18, scale: 4, mode: "string" })` |
| `shipmentLineItems.weightShare` | `decimal("weightShare", { precision: 9, scale: 6, mode: "string" }).notNull()` |
| `shipmentLineItems.valueShare` | `decimal("valueShare", { precision: 9, scale: 6, mode: "string" }).notNull()` |
| `payments.expectedAmount` | `decimal("expectedAmount", { precision: 18, scale: 4, mode: "string" }).notNull()` |
| `payments.paidAmount` | `decimal("paidAmount", { precision: 18, scale: 4, mode: "string" })` |
| `payments.fxRate` | `decimal("fxRate", { precision: 12, scale: 6, mode: "string" })` |
| `payments.baseCurrencyAmount` | `decimal("baseCurrencyAmount", { precision: 18, scale: 4, mode: "string" })` |
| `transactions.amount` | `decimal("amount", { precision: 18, scale: 4, mode: "string" }).notNull()` |
| `transactions.fxRate` | `decimal("fxRate", { precision: 12, scale: 6, mode: "string" }).notNull()` |
| `inventoryLedger.unitCost` | `decimal("unitCost", { precision: 18, scale: 6, mode: "string" })` |
| `salesPlanWeeklyInputs.plannedRevenue` | `decimal("plannedRevenue", { precision: 18, scale: 4, mode: "string" }).notNull()` |
| `salesPlanWeeklyInputs.primaryPercent` | `decimal("primaryPercent", { precision: 7, scale: 4, mode: "string" }).notNull()` |
| `salesPlanWeeklyRecipeLines.unitsPer1000` | `decimal("unitsPer1000", { precision: 12, scale: 4, mode: "string" }).notNull()` |

Do NOT change `currency`/`costCurrency` columns (3-letter codes, correctly `varchar`) or any non-numeric `varchar` column.

- [ ] **Step 3: Check the dev DB for any non-numeric existing value before generating the migration**

Run against the dev DB for every table in the table above (adjust the query per table/column — this is illustrative for one column, repeat the shape for each):
```sql
SELECT id, unitPrice FROM po_line_items WHERE unitPrice IS NOT NULL AND unitPrice NOT REGEXP '^-?[0-9]+(\\.[0-9]+)?$';
```
Expected: zero rows for every column. If any column returns a row, STOP and report it — do not generate/apply the migration until every existing value is a clean decimal string (this codebase's data at this stage is dev/test fixtures only, per `README.md`'s "not yet run against real Jello data" status, so a hit here means a test fixture needs fixing, not real production data needing cleanup).

- [ ] **Step 4: Write the round-trip precision test**

Add a new test file `server/decimalMigration.test.ts`:
```ts
// server/decimalMigration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { skus, warehouses, poLineItems, purchaseOrders, vendors, shipments, shipmentLineItems, payments, transactions, inventoryLedger } from "../drizzle/schema";
import { createSku, createVendor, createWarehouse } from "./db";
import { createPurchaseOrder } from "./purchaseOrders";
import { createShipment } from "./shipments";
import { createExpectedPayment, markPaymentPaid, recordTransaction } from "./payments";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(transactions);
      await tx.delete(payments);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(inventoryLedger);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(vendors);
      await tx.delete(skus);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("decimal column migration round-trips every value at its real precision", () => {
  it("unitCost survives a 6-decimal write exactly", async () => {
    const sku = await createSku({ sku: "JELLO-DECIMAL-TEST", primaryIdentifierType: "sku" });
    const wh = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: wh.id, eventType: "receipt", qty: 100, unitCost: "0.123456", date: new Date(), sourceRef: "TEST" });
    const [row] = await db.select().from(inventoryLedger).where(sql`${inventoryLedger.skuId} = ${sku.id}`);
    expect(row.unitCost).toBe("0.123456");
  });

  it("payment fxRate/paidAmount/baseCurrencyAmount survive a real markPaymentPaid write exactly", async () => {
    const vendor = await createVendor({ name: "Test Vendor" });
    const po = await createPurchaseOrder({ poNumber: "PO-DECIMAL-TEST", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "1234.56", expectedDate: new Date(), currency: "USD" });
    const paid = await markPaymentPaid(payment.id, { amount: "1234.56", fxRate: "0.860000", paidDate: new Date(), reasonCategory: "payment_timing", changedBy: 1 });
    expect(paid.paidAmount).toBe("1234.56");
    expect(paid.fxRate).toBe("0.860000");
    expect(paid.baseCurrencyAmount).toBe("1061.72");
  });

  it("shipment weightShare/valueShare survive a real createShipment write exactly", async () => {
    const vendor = await createVendor({ name: "Test Vendor" });
    const po = await createPurchaseOrder({ poNumber: "PO-DECIMAL-TEST-2", vendorId: vendor.id, lineItems: [], createdBy: 1 });
    const sku = await createSku({ sku: "JELLO-DECIMAL-TEST-2", primaryIdentifierType: "sku" });
    const wh = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const [poLine] = await db.insert(poLineItems).values({ poId: po.id, skuId: sku.id, qty: 100, unitPrice: "1.234567", currency: "USD" });
    const shipment = await createShipment({
      shipmentRef: "SHIP-DECIMAL-TEST", warehouseId: wh.id, createdBy: 1,
      lineItems: [{ poLineItemId: poLine.insertId, skuId: sku.id, qty: 100, weightShare: "0.333333", valueShare: "0.666667" }],
    });
    const [line] = await db.select().from(shipmentLineItems).where(sql`${shipmentLineItems.shipmentId} = ${shipment.id}`);
    expect(line.weightShare).toBe("0.333333");
    expect(line.valueShare).toBe("0.666667");
  });
});
```
(Verify `createPurchaseOrder`'s and `createShipment`'s exact real signatures before finalizing this test — this file's own earlier tests in `purchaseOrders.test.ts`/`shipments.test.ts` are the source of truth for the exact shape, since the design doc did not spell every field out.)

- [ ] **Step 5: Run this new test against the CURRENT (pre-migration) schema — it must already pass**

Run: `set -a && source .env && set +a && pnpm test decimalMigration`
Expected: PASS. This confirms the test itself is correct before it becomes the proof that the migration didn't change behavior.

- [ ] **Step 6: Generate and apply the migration**

Run: `set -a && source .env && set +a && pnpm exec drizzle-kit generate`
Read the generated SQL — confirm every statement is `MODIFY COLUMN ... DECIMAL(...)`, nothing else.

Run: `pnpm exec drizzle-kit migrate`
Expected: succeeds. If it fails, STOP and report the exact error (per Step 3, this should not happen if the pre-check found zero non-numeric rows).

- [ ] **Step 7: Run the full suite again, including the new test**

Run: `set -a && source .env && set +a && pnpm test && pnpm check`
Expected: all pass, same total count as before this task plus the 3 new tests, `tsc --noEmit` clean. The 3 new tests passing after the migration (having already been proven to pass before it, in Step 5) is the actual round-trip proof this task requires.

- [ ] **Step 8: Commit**

```bash
git add drizzle/schema.ts drizzle/ server/decimalMigration.test.ts
git commit -m "fix: migrate money/share columns from varchar to decimal

Every monetary or fractional-share column in the schema was varchar, so
MySQL could store \"NaN\", an empty string, or any non-numeric garbage, and
couldn't SUM/AVG them natively. The application already treats every one of
these as a string end-to-end, so this is a column-type change with no
application code change -- proven by a new round-trip test showing every
changed column's real write precision survives the migration exactly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Rename `.mjs` CLI scripts to `.ts`

**Files:**
- Rename: `scripts/reset-password.mjs` → `scripts/reset-password.ts`
- Rename: `scripts/run-daily-shopify-pull.mjs` → `scripts/run-daily-shopify-pull.ts`
- Rename: `scripts/run-migration.mjs` → `scripts/run-migration.ts`
- Rename: `scripts/run-nightly-export.mjs` → `scripts/run-nightly-export.ts`
- Rename: `scripts/run-parallel-check.mjs` → `scripts/run-parallel-check.ts`
- Modify: `RAILWAY.md` (update every `.mjs` reference to `.ts`, 5 occurrences)

- [ ] **Step 1: Rename each file**

```bash
git mv scripts/reset-password.mjs scripts/reset-password.ts
git mv scripts/run-daily-shopify-pull.mjs scripts/run-daily-shopify-pull.ts
git mv scripts/run-migration.mjs scripts/run-migration.ts
git mv scripts/run-nightly-export.mjs scripts/run-nightly-export.ts
git mv scripts/run-parallel-check.mjs scripts/run-parallel-check.ts
```
No content changes to any of these 5 files — the rename alone is the fix (they already import their real logic from typed `.ts` modules and are already run via `tsx`, which executes `.ts` identically to how it executed `.mjs`).

- [ ] **Step 2: Update `RAILWAY.md`'s 5 references**

Run `grep -n "\.mjs" RAILWAY.md` and change each `scripts/<name>.mjs` to `scripts/<name>.ts` in place (the surrounding command text — `pnpm exec tsx scripts/<name>.ts <args>` — is otherwise unchanged).

- [ ] **Step 3: Confirm `pnpm check` now actually sees these 5 files**

Run: `set -a && source .env && set +a && pnpm check`
Expected: clean (no errors). This alone doesn't prove the files are being checked — additionally run: `pnpm exec tsc --noEmit --listFiles 2>/dev/null | grep -c "scripts/run-nightly-export.ts\|scripts/reset-password.ts\|scripts/run-daily-shopify-pull.ts\|scripts/run-migration.ts\|scripts/run-parallel-check.ts"` and confirm the count is 5 (proving `tsc` now includes all 5 files in its compilation, where it previously included none of them as `.mjs`).

- [ ] **Step 4: Run the full test suite**

Run: `set -a && source .env && set +a && pnpm test`
Expected: all pass, including `scripts/reset-password.test.ts` (which imports from `./reset-password-core` — unaffected by this rename, since it never imported the `.mjs` file itself).

- [ ] **Step 5: Manually smoke-test one renamed script still runs correctly under `tsx`**

Run: `set -a && source .env && set +a && echo '[]' > /tmp/empty-shopify-export.json && pnpm exec tsx scripts/run-daily-shopify-pull.ts /tmp/empty-shopify-export.json`
Expected: exits 0, same output shape as before the rename (an empty-array input is always a safe no-op run per this script's existing behavior).

- [ ] **Step 6: Commit**

```bash
git add scripts/ RAILWAY.md
git commit -m "fix: rename .mjs CLI scripts to .ts so tsc actually checks them

tsconfig.json's include has no allowJs, so the 5 scripts/*.mjs files were
invisible to tsc entirely -- confirmed zero errors and zero mentions of them
on a clean pnpm check. All 5 are already thin tsx-executed wrappers around
typed .ts core modules with no logic change needed; the rename alone closes
the compile-time blind spot Cherny's review found.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Review

After all 7 tasks: dispatch the final whole-branch code reviewer (most capable available model) against the full diff from this stream's first commit to its last, per this project's established subagent-driven-development process. Pay special attention to: (1) the FIFO unification's byte-identical-behavior claim — re-verify by hand-tracing at least one adjustment-handling scenario through both the old and new code paths; (2) the decimal migration's precision table against every real `.toFixed(...)` call site in the current codebase, not just the ones cited in the design doc; (3) whether dropping the `dbClient` parameter from `setShipmentCustomsStatus`/`correctShipmentActualDepartDate` is still safe after every other task's changes (re-run the call-site grep fresh, don't trust Task 4's own verification as still current). Update `docs/BACKLOG.md` (mark Engineering/Cherny items done) and `docs/BUILD-HISTORY.md` (new Stream J narrative section) and `README.md`'s Current Status, matching every prior stream's close-out convention, then push per the established `gh auth switch` dance.
