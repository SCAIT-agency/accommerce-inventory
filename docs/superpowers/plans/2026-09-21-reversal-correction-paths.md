# Reversal / Correction Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, tested, forward-only correction mechanism for a wrong receipt quantity, a wrong landed cost, or a wrong paid-payment amount — none of which can currently be fixed except by raw SQL against an append-only ledger.

**Architecture:** One core primitive (`correctLedgerReceipt`) appends an offsetting `adjustment` event plus a replacement `receipt` event for a wrong ledger receipt, never rewriting history. Shipment- and payment-level wrapper functions resolve a human-meaningful identifier (shipment + line item, or payment id) down to the right ledger event(s) and add their own `change_log` audit trail on top. Three new tRPC procedures and two new UI controls expose this on the existing Shipments and Purchase Orders pages.

**Tech Stack:** Node/Express + tRPC v11 + React + TiDB(MySQL) via Drizzle ORM + Vitest.

**Spec:** `docs/2026-09-21-reversal-correction-paths-design.md`

## Global Constraints

- `markShipmentArrived` must populate the new `lineItemId` column on every `receipt` event it writes going forward — not optional, the correction wrappers depend on it.
- Forward-only: no correction may rewrite or delete an existing `inventory_ledger` row, and no correction may alter previously-computed Daily COGS for a past day.
- Every correction writes through `recordLedgerEvent` (never a raw insert bypassing its negative-stock guard) except where `allowNegativeSoh` is explicitly passed for that one call.
- `reasonCategory` for every correction is always `"data_correction"`, set internally — never a user-supplied choice among the other 9 categories.
- `reasonNote` is required (not optional) on every correction entry point, unlike most existing `reasonNote` fields in this codebase which are optional-except-when-category-is-`"other"`.
- No changes to `LEDGER_EVENT_TYPES` or to `replayLedgerEventsFifo`'s core `receipt`/`sale`/`adjustment` branches — only an additive extension to what its internal `consume()` closure reports.
- `correctShipmentLandedCost` is all-or-nothing across every line item it touches — one failing line rolls back the whole correction.
- No `reasonCategory` dropdown on any correction UI form — every correction is `"data_correction"` by construction.
- This codebase has no toast/notification library (confirmed: `grep -rn "toast" client/src/` returns nothing) — the `consumedFromOtherBatches` warning must use the same inline `<div>` pattern every other mutation error/message in this codebase already uses, not a toast.

---

### Task 1: Schema — `inventory_ledger` correction columns, `data_correction` reason category, migration

**Files:**
- Modify: `drizzle/schema.ts:211-236` (the `LEDGER_EVENT_TYPES`/`inventoryLedger` block), `drizzle/schema.ts:164-172` (`shipmentLineItems`, referenced by the new FK — no change needed there, just confirming the reference target exists)
- Modify: `shared/constants.ts`
- Create: a new Drizzle migration under `drizzle/migrations/` (generated, not hand-written)
- Test: `server/inventoryLedger.test.ts` (add one schema-shape assertion)

**Interfaces:**
- Produces: `inventoryLedger.correctsEventId`, `inventoryLedger.changedBy`, `inventoryLedger.reasonCategory`, `inventoryLedger.reasonNote`, `inventoryLedger.lineItemId` — all nullable columns on the `InsertLedgerEvent`/`LedgerEvent` Drizzle types every later task imports. `REASON_CATEGORIES` gains `"data_correction"` as its 10th value.

- [ ] **Step 1: Add `"data_correction"` to `shared/constants.ts`**

Current file:
```ts
export const REASON_CATEGORIES = [
  "production_delay",
  "artwork_delay",
  "customs_hold",
  "logistics_delay",
  "payment_timing",
  "vendor_price_change",
  "freight_rate_change",
  "holiday_capacity",
  "other",
] as const;
```

Change to:
```ts
export const REASON_CATEGORIES = [
  "production_delay",
  "artwork_delay",
  "customs_hold",
  "logistics_delay",
  "payment_timing",
  "vendor_price_change",
  "freight_rate_change",
  "holiday_capacity",
  "data_correction",
  "other",
] as const;
```

- [ ] **Step 2: Add the four new columns to `inventory_ledger` in `drizzle/schema.ts`**

The current block (lines 211-236):
```ts
export const LEDGER_EVENT_TYPES = ["receipt", "sale", "adjustment"] as const;

export const inventoryLedger = mysqlTable(
  "inventory_ledger",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull().references(() => skus.id),
    warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
    eventType: mysqlEnum("eventType", LEDGER_EVENT_TYPES).notNull(),
    qty: int("qty").notNull(),
    unitCost: decimal("unitCost", { precision: 18, scale: 8, mode: "string" }),
    // fsp: 3 (millisecond precision) matches what JS Date actually carries.
    // Default second-level precision rounds (not truncates) on insert, which
    // can flip the ordering of two events timestamped milliseconds apart
    // within the same wall-clock second relative to an unrounded query
    // parameter in getSoh's lte() comparison — silently miscomputing SOH.
    date: timestamp("date", { fsp: 3 }).notNull(),
    sourceRef: varchar("sourceRef", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateIdx: index("sku_warehouse_date_idx").on(table.skuId, table.warehouseId, table.date),
  }),
);
export type LedgerEvent = typeof inventoryLedger.$inferSelect;
export type InsertLedgerEvent = typeof inventoryLedger.$inferInsert;
```

Replace with:
```ts
export const LEDGER_EVENT_TYPES = ["receipt", "sale", "adjustment"] as const;

export const inventoryLedger = mysqlTable(
  "inventory_ledger",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull().references(() => skus.id),
    warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
    eventType: mysqlEnum("eventType", LEDGER_EVENT_TYPES).notNull(),
    qty: int("qty").notNull(),
    unitCost: decimal("unitCost", { precision: 18, scale: 8, mode: "string" }),
    // fsp: 3 (millisecond precision) matches what JS Date actually carries.
    // Default second-level precision rounds (not truncates) on insert, which
    // can flip the ordering of two events timestamped milliseconds apart
    // within the same wall-clock second relative to an unrounded query
    // parameter in getSoh's lte() comparison — silently miscomputing SOH.
    date: timestamp("date", { fsp: 3 }).notNull(),
    sourceRef: varchar("sourceRef", { length: 128 }),
    // Which shipment line item this receipt came from — only populated going
    // forward by markShipmentArrived (Task 4). Historical rows keep this
    // null; a shipment can legitimately have two line items sharing one SKU
    // (Stream G, 2026-09-20), so skuId alone can't disambiguate which
    // receipt belongs to which line item once a correction needs to target
    // one specifically. See docs/2026-09-21-reversal-correction-paths-design.md §3.
    lineItemId: int("lineItemId").references(() => shipmentLineItems.id),
    // The four columns below are populated ONLY by a correction write
    // (server/inventoryLedger.ts's correctLedgerReceipt, Task 3) — an
    // ordinary receipt/sale event leaves them null. correctsEventId links a
    // correction's reversal row and its replacement receipt row back to the
    // id of the original, wrong event it corrects.
    correctsEventId: int("correctsEventId").references((): AnyMySqlColumn => inventoryLedger.id),
    changedBy: int("changedBy").references(() => users.id),
    reasonCategory: mysqlEnum("reasonCategory", REASON_CATEGORIES),
    reasonNote: text("reasonNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateIdx: index("sku_warehouse_date_idx").on(table.skuId, table.warehouseId, table.date),
  }),
);
export type LedgerEvent = typeof inventoryLedger.$inferSelect;
export type InsertLedgerEvent = typeof inventoryLedger.$inferInsert;
```

Two things to get right here:
1. `AnyMySqlColumn` must be imported for the self-referencing FK's return type annotation — Drizzle's `mysql-core` self-reference pattern requires this exact annotation on the callback or TypeScript cannot resolve the circular type (`inventoryLedger` referencing itself inside its own definition). Add `AnyMySqlColumn` to the existing import line at the top of the file (currently `import { date, decimal, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, index, unique, foreignKey } from "drizzle-orm/mysql-core";` — add `AnyMySqlColumn` to that list).
2. `inventory_ledger`'s column definitions must come *before* `shipmentLineItems` in the file today (check: `shipmentLineItems` is defined at line 164, `inventoryLedger` at line 213 — `shipmentLineItems` already comes first, so referencing `shipmentLineItems.id` from `inventoryLedger`'s `lineItemId` column needs no reordering).

- [ ] **Step 2b: Run `pnpm check` to confirm the schema change type-checks**

Run: `pnpm check`
Expected: clean, no errors. If `AnyMySqlColumn`'s self-reference syntax produces a type error, check the exact working syntax by searching `node_modules/drizzle-orm/mysql-core`'s own type definitions for `AnyMySqlColumn` usage examples, or fall back to declaring `correctsEventId` as a plain `int("correctsEventId")` with no `.references()` call and add an `index("inventory_ledger_corrects_event_id_idx").on(table.correctsEventId)` in the second config argument instead — the invariant is enforced in application code either way (see spec §3's note), so a missing DB-level FK on just this one column is an acceptable fallback if the self-reference syntax proves genuinely broken, not a silent scope cut.

- [ ] **Step 3: Generate and apply the migration**

Run:
```bash
pnpm exec drizzle-kit generate
```

This produces a new file under `drizzle/migrations/` (the next sequential number after `0012_graceful_hairball.sql` — check `ls drizzle/migrations/*.sql | tail -1` first to confirm the actual latest number before assuming `0013`). Read the generated SQL file to confirm it contains exactly 5 `ALTER TABLE inventory_ledger ADD COLUMN` statements (or 4 `ADD COLUMN` + 1 `ADD CONSTRAINT` if the FK needs a separate statement) and nothing else.

Apply it:
```bash
pnpm db:migrate
```

- [ ] **Step 4: Confirm the new columns exist via `DESCRIBE`**

Run: `mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "DESCRIBE inventory_ledger;"`
Expected: `lineItemId`, `correctsEventId`, `changedBy`, `reasonCategory`, `reasonNote` all present, all nullable (`YES` in the `Null` column).

- [ ] **Step 5: Add one schema-shape regression test**

Add to `server/inventoryLedger.test.ts`, inside the existing `describe("inventory ledger", ...)` block:

```ts
  it("accepts an ordinary receipt event with all new correction columns left null", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    const [row] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    expect(row.lineItemId).toBeNull();
    expect(row.correctsEventId).toBeNull();
    expect(row.changedBy).toBeNull();
    expect(row.reasonCategory).toBeNull();
    expect(row.reasonNote).toBeNull();
  });
```

This test file already imports `db`, `eq`, `inventoryLedger`, `recordLedgerEvent`, `createSku`, `createWarehouse` — no new imports needed.

- [ ] **Step 6: Run tests**

Run: `pnpm test inventoryLedger`
Expected: all pass, including the new test.

- [ ] **Step 7: Commit**

```bash
git add drizzle/schema.ts shared/constants.ts drizzle/migrations/ server/inventoryLedger.test.ts
git commit -m "feat: add correction columns to inventory_ledger and a data_correction reason category

Schema-only change: lineItemId, correctsEventId, changedBy,
reasonCategory, reasonNote all nullable, all unused by any write path
yet — Task 3 (correctLedgerReceipt) is the first consumer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `replayLedgerEventsFifo` — additive `onAdjustmentConsumed` extension

**Files:**
- Modify: `server/inventoryLedger.ts:101-135` (the `replayLedgerEventsFifo` function and its internal `consume()` closure)
- Test: `server/inventoryLedger.test.ts` (new tests for the extension; existing tests must pass unchanged)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `replayLedgerEventsFifo`'s new third parameter `onAdjustmentConsumed?: (event: LedgerEvent, consumedCost: number, touchedSourceRefs: Set<string | null>) => void` — Task 3's `correctLedgerReceipt` is the only consumer.

- [ ] **Step 1: Write the failing test**

Add to `server/inventoryLedger.test.ts`, inside `describe("inventory ledger", ...)`:

```ts
  it("replayLedgerEventsFifo reports which batch sourceRefs a negative adjustment actually consumed", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "batch-A" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "2.00", date: new Date("2026-09-02"), sourceRef: "batch-B" });
    // Consumes all of batch-A (50) plus 20 units of batch-B — a case
    // engineered to span two batches, so the reported sourceRefs must
    // include both, not just the first one touched.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "adjustment", qty: -70, unitCost: null, date: new Date("2026-09-03"), sourceRef: "write-off" });

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id)).orderBy(inventoryLedger.date, inventoryLedger.id);
    const touched: Set<string | null>[] = [];
    replayLedgerEventsFifo(events, undefined, (_event, _cost, touchedSourceRefs) => {
      touched.push(touchedSourceRefs);
    });

    expect(touched).toHaveLength(1);
    expect(touched[0]).toEqual(new Set(["batch-A", "batch-B"]));
  });

  it("replayLedgerEventsFifo's onSaleConsumed callback still fires with just cost, unaffected by the new third parameter", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.50", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -40, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id)).orderBy(inventoryLedger.date, inventoryLedger.id);
    let reportedCost = -1;
    replayLedgerEventsFifo(events, (_event, consumedCost) => { reportedCost = consumedCost; });

    expect(reportedCost).toBeCloseTo(40 * 0.5, 6);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test inventoryLedger`
Expected: FAIL — `replayLedgerEventsFifo` doesn't yet accept a third argument, and the first new test's callback never fires (adjustments don't invoke any callback today).

- [ ] **Step 3: Implement the extension**

In `server/inventoryLedger.ts`, replace the whole `replayLedgerEventsFifo` function (currently lines 101-135):

```ts
export function replayLedgerEventsFifo(
  events: LedgerEvent[],
  onSaleConsumed?: (event: LedgerEvent, consumedCost: number) => void,
  onAdjustmentConsumed?: (event: LedgerEvent, consumedCost: number, touchedSourceRefs: Set<string | null>) => void,
): FifoBatch[] {
  const batches: FifoBatch[] = [];

  const consume = (qtyToConsume: number, asOfDate: Date, context: string): { consumedCost: number; touchedSourceRefs: Set<string | null> } => {
    let remaining = qtyToConsume;
    let consumedCost = 0;
    const touchedSourceRefs = new Set<string | null>();
    while (remaining > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= asOfDate);
      if (!batch) throw new Error(`replayLedgerEventsFifo: insufficient stock to consume ${remaining} units for ${context}`);
      const consumed = Math.min(batch.qty, remaining);
      consumedCost += consumed * batch.unitCost;
      touchedSourceRefs.add(batch.sourceRef);
      batch.qty -= consumed;
      remaining -= consumed;
    }
    return { consumedCost, touchedSourceRefs };
  };

  for (const event of events) {
    if (event.eventType === "receipt") {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    } else if (event.eventType === "sale") {
      const { consumedCost } = consume(Math.abs(event.qty), event.date, `sale event ${event.id}`);
      onSaleConsumed?.(event, consumedCost);
    } else if (event.qty < 0) {
      const { consumedCost, touchedSourceRefs } = consume(Math.abs(event.qty), event.date, `adjustment event ${event.id}`);
      onAdjustmentConsumed?.(event, consumedCost, touchedSourceRefs);
    } else if (event.qty > 0) {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    }
  }

  return batches;
}
```

This is the entire diff for this task — no other line in `server/inventoryLedger.ts` changes. `getRemainingBatches` (same file) and `getDailyCogsForRange` (`server/salesPlan.ts`) both call `replayLedgerEventsFifo` with at most two arguments today; neither passes a third, so `onAdjustmentConsumed` is `undefined` for both and the new branch's `onAdjustmentConsumed?.(...)` never fires for them — their behavior is provably unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test inventoryLedger`
Expected: PASS — both new tests, and every existing test in this file (the negative-adjustment tests, the SOH tests, the FIFO batch tests) unchanged.

- [ ] **Step 5: Run the full regression suite**

Run: `pnpm test salesPlan shipments`
Expected: PASS — `getDailyCogsForRange`'s own test suite (in `server/salesPlan.test.ts`) and `getRemainingBatches`'s callers must show zero behavior change from this purely additive edit.

- [ ] **Step 6: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: replayLedgerEventsFifo reports which batch(es) a negative adjustment consumed

Additive third callback parameter (onAdjustmentConsumed) -- existing
callers (getRemainingBatches, getDailyCogsForRange) pass at most two
arguments today and are unaffected. This is what correctLedgerReceipt
(next task) uses to detect and surface cross-batch consumption.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `correctLedgerReceipt` core primitive

**Files:**
- Modify: `server/inventoryLedger.ts` (add the new function after `getRemainingBatches`)
- Test: `server/inventoryLedger.test.ts`

**Interfaces:**
- Consumes: `recordLedgerEvent` (existing), `replayLedgerEventsFifo` with its new third parameter (Task 2), `LedgerEvent`/`InsertLedgerEvent` types with the new columns (Task 1).
- Produces: `LedgerCorrectionResult` type and `correctLedgerReceipt(eventId, corrections, opts, dbClient?)` — Tasks 4, 5 call this directly.

- [ ] **Step 1: Write the failing tests**

Add to `server/inventoryLedger.test.ts`, inside `describe("inventory ledger", ...)`:

```ts
  it("correctLedgerReceipt appends a reversal and a replacement receipt, leaving the original row untouched", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    const result = await correctLedgerReceipt(
      original.id,
      { qty: 90 },
      { changedBy: user.id, reasonNote: "recount found 10 units short" },
    );

    expect(result.consumedFromOtherBatches).toBe(false);

    const [unchangedOriginal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, original.id));
    expect(unchangedOriginal.qty).toBe(100);
    expect(unchangedOriginal.eventType).toBe("receipt");

    const [reversal] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.reversalId));
    expect(reversal.eventType).toBe("adjustment");
    expect(reversal.qty).toBe(-100);
    expect(parseFloat(reversal.unitCost ?? "0")).toBeCloseTo(1.0, 6);
    expect(reversal.correctsEventId).toBe(original.id);
    expect(reversal.reasonCategory).toBe("data_correction");
    expect(reversal.reasonNote).toBe("recount found 10 units short");
    expect(reversal.changedBy).toBe(user.id);

    const [corrected] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.correctedId));
    expect(corrected.eventType).toBe("receipt");
    expect(corrected.qty).toBe(90);
    expect(parseFloat(corrected.unitCost ?? "0")).toBeCloseTo(1.0, 6);
    expect(corrected.correctsEventId).toBe(original.id);

    expect(await getSoh(sku.id, ff.id)).toBe(90);
  });

  it("correctLedgerReceipt can correct unitCost only, leaving qty unchanged", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    const result = await correctLedgerReceipt(
      original.id,
      { unitCost: "1.50" },
      { changedBy: user.id, reasonNote: "freight invoice restated" },
    );

    const [corrected] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.id, result.correctedId));
    expect(corrected.qty).toBe(100);
    expect(parseFloat(corrected.unitCost ?? "0")).toBeCloseTo(1.5, 6);
    expect(await getSoh(sku.id, ff.id)).toBe(100);
  });

  it("correctLedgerReceipt reports consumedFromOtherBatches when the original batch was already sold through", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "batch-A" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "2.00", date: new Date("2026-09-02"), sourceRef: "batch-B" });
    // Sells all 50 of batch-A before the correction runs.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-03"), sourceRef: "shopify" });

    const [batchAEvent] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.sourceRef, "batch-A"));

    // Correcting batch-A's qty now: its reversal (-50) must draw from
    // batch-B, since batch-A itself has 0 remaining.
    const result = await correctLedgerReceipt(
      batchAEvent.id,
      { qty: 40 },
      { changedBy: user.id, reasonNote: "recount" },
    );

    expect(result.consumedFromOtherBatches).toBe(true);
  });

  it("correctLedgerReceipt rejects correcting a non-receipt event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -10, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });
    const [saleEvent] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "sale"));

    await expect(
      correctLedgerReceipt(saleEvent.id, { qty: 5 }, { changedBy: user.id, reasonNote: "test" }),
    ).rejects.toThrow(/is not a receipt/);
  });

  it("correctLedgerReceipt rejects correcting an event that no longer exists", async () => {
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });
    await expect(
      correctLedgerReceipt(999999, { qty: 5 }, { changedBy: user.id, reasonNote: "test" }),
    ).rejects.toThrow(/no ledger event found/);
  });

  it("correctLedgerReceipt rejects correcting an already-corrected event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
    await correctLedgerReceipt(original.id, { qty: 90 }, { changedBy: user.id, reasonNote: "first correction" });

    await expect(
      correctLedgerReceipt(original.id, { qty: 80 }, { changedBy: user.id, reasonNote: "second attempt on the original" }),
    ).rejects.toThrow(/already been corrected/);
  });

  it("correctLedgerReceipt rejects a no-op correction", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));

    await expect(
      correctLedgerReceipt(original.id, { qty: 100 }, { changedBy: user.id, reasonNote: "no real change" }),
    ).rejects.toThrow(/changes nothing/);
  });

  it("correctLedgerReceipt rejects a correction that would drive SOH negative, unless allowNegativeSoh is set", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const user = await createUser({ email: "corrector@accommerce.example", role: "editor" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "1.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    // Sells 95 of the wrongly-large 100 -- correcting down to 10 would need
    // to reverse all 100 units, but only 5 remain unsold.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -95, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify" });
    const [original] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "receipt"));

    await expect(
      correctLedgerReceipt(original.id, { qty: 10 }, { changedBy: user.id, reasonNote: "actual receipt was only 10" }),
    ).rejects.toThrow(/negative/i);

    const result = await correctLedgerReceipt(
      original.id,
      { qty: 10 },
      { changedBy: user.id, reasonNote: "actual receipt was only 10", allowNegativeSoh: true },
    );
    expect(await getSoh(sku.id, ff.id)).toBe(10 - 95);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test inventoryLedger`
Expected: FAIL — `correctLedgerReceipt` is not defined.

- [ ] **Step 3: Add the required imports to the test file**

`server/inventoryLedger.test.ts`'s current imports (from Task 1/earlier):
```ts
import { recordLedgerEvent, getSoh, getSohForSkus, ALLOW_BACKORDERS_SETTING } from "./inventoryLedger";
import { createSku, createWarehouse, setAppSetting } from "./db";
```

Change to:
```ts
import { recordLedgerEvent, getSoh, getSohForSkus, ALLOW_BACKORDERS_SETTING, replayLedgerEventsFifo, correctLedgerReceipt } from "./inventoryLedger";
import { createSku, createWarehouse, setAppSetting, createUser } from "./db";
```

- [ ] **Step 4: Implement `correctLedgerReceipt`**

Add to `server/inventoryLedger.ts`, after `getRemainingBatches` (end of file):

```ts
export interface LedgerCorrectionResult {
  reversalId: number;
  correctedId: number;
  // true iff the reversal's FIFO consumption touched stock from a batch
  // OTHER than the one being corrected, because the original batch no
  // longer had enough remaining quantity to fully absorb its own reversal
  // (i.e. it had already been partly or fully sold through). Forward-only
  // by design (see docs/2026-09-21-reversal-correction-paths-design.md §4):
  // past Daily COGS is never recalculated, even when this is true.
  consumedFromOtherBatches: boolean;
}

export async function correctLedgerReceipt(
  eventId: number,
  corrections: { qty?: number; unitCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
  dbClient: DbClient = db,
): Promise<LedgerCorrectionResult> {
  const write = async (tx: DbClient): Promise<LedgerCorrectionResult> => {
    const [original] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.id, eventId));
    if (!original) {
      throw new Error(`correctLedgerReceipt: no ledger event found with id ${eventId}`);
    }
    if (original.eventType !== "receipt") {
      throw new Error(`correctLedgerReceipt: event ${eventId} is not a receipt — only receipt events can be corrected`);
    }
    const [alreadyCorrected] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.correctsEventId, eventId));
    if (alreadyCorrected) {
      throw new Error(`correctLedgerReceipt: event ${eventId} has already been corrected`);
    }

    const finalQty = corrections.qty ?? original.qty;
    const finalUnitCost = corrections.unitCost ?? original.unitCost;
    if (finalQty === original.qty && finalUnitCost === original.unitCost) {
      throw new Error(`correctLedgerReceipt: correction changes nothing — refusing to write a no-op correction pair`);
    }

    const now = new Date();
    await recordLedgerEvent(
      {
        skuId: original.skuId,
        warehouseId: original.warehouseId,
        eventType: "adjustment",
        qty: -original.qty,
        unitCost: original.unitCost,
        date: now,
        sourceRef: original.sourceRef,
        lineItemId: original.lineItemId,
        correctsEventId: eventId,
        changedBy: opts.changedBy,
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
      },
      tx,
      opts.allowNegativeSoh,
    );
    const [reversal] = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.correctsEventId, eventId), eq(inventoryLedger.eventType, "adjustment")));

    await recordLedgerEvent(
      {
        skuId: original.skuId,
        warehouseId: original.warehouseId,
        eventType: "receipt",
        qty: finalQty,
        unitCost: finalUnitCost,
        date: now,
        sourceRef: original.sourceRef,
        lineItemId: original.lineItemId,
        correctsEventId: eventId,
        changedBy: opts.changedBy,
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
      },
      tx,
    );
    const [corrected] = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.correctsEventId, eventId), eq(inventoryLedger.eventType, "receipt")));

    const allEvents = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.skuId, original.skuId), eq(inventoryLedger.warehouseId, original.warehouseId)))
      .orderBy(inventoryLedger.date, inventoryLedger.id);
    let consumedFromOtherBatches = false;
    replayLedgerEventsFifo(allEvents, undefined, (event, _cost, touchedSourceRefs) => {
      if (event.id === reversal.id) {
        consumedFromOtherBatches = [...touchedSourceRefs].some((ref) => ref !== original.sourceRef);
      }
    });

    return { reversalId: reversal.id, correctedId: corrected.id, consumedFromOtherBatches };
  };

  if (dbClient === db) {
    return db.transaction(write);
  }
  return write(dbClient);
}
```

**Important — this requires a small, additive signature change to `recordLedgerEvent`** (same file, above `correctLedgerReceipt`): it must accept the new `lineItemId`/`correctsEventId`/`changedBy`/`reasonCategory`/`reasonNote` fields on its `event` parameter (already true — `event: Omit<InsertLedgerEvent, "id">` automatically includes every column Task 1 added, since `InsertLedgerEvent` is inferred from the schema), and it must accept an optional fourth parameter to bypass its own negative-stock guard:

Current `recordLedgerEvent` signature and guard (near the top of `server/inventoryLedger.ts`):
```ts
export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">, dbClient: DbClient = db) {
  ...
  if (event.qty < 0) {
    ...
    if (currentSoh + event.qty < 0 && (await getAppSetting(ALLOW_BACKORDERS_SETTING)) !== "true") {
      throw new Error(...);
    }
  }
  await dbClient.insert(inventoryLedger).values(event);
}
```

Change the signature and guard condition to:
```ts
export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">, dbClient: DbClient = db, allowNegativeSoh = false) {
  ...
  if (event.qty < 0) {
    ...
    if (currentSoh + event.qty < 0 && !allowNegativeSoh && (await getAppSetting(ALLOW_BACKORDERS_SETTING)) !== "true") {
      throw new Error(...);
    }
  }
  await dbClient.insert(inventoryLedger).values(event);
}
```

This is a purely additive third parameter (defaults to `false`, matching today's behavior exactly) — grep `recordLedgerEvent(` across the whole codebase first to confirm every existing call site passes at most two arguments (it does: `server/shipments.ts`'s `markShipmentArrived` and every test file only ever pass `event` and sometimes `dbClient`), so no existing call site needs to change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test inventoryLedger`
Expected: PASS, all 8 new tests plus every pre-existing test in this file.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm check`
Expected: fully green except the one pre-existing, unrelated `dryrun.test.ts` DB-name-guard failure.

- [ ] **Step 7: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: correctLedgerReceipt -- forward-only correction of a wrong receipt qty/cost

Appends an offsetting adjustment plus a replacement receipt, both
linked to the original via correctsEventId. Never rewrites ledger
history. recordLedgerEvent gains an additive allowNegativeSoh
parameter for the documented escape-hatch case.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `markShipmentArrived` populates `lineItemId`; `correctShipmentReceiptQty` wrapper

**Files:**
- Modify: `server/shipments.ts` (update `markShipmentArrived`'s `recordLedgerEvent` call; add `correctShipmentReceiptQty`)
- Test: `server/shipments.test.ts`

**Interfaces:**
- Consumes: `correctLedgerReceipt` (Task 3), `LedgerCorrectionResult` type (Task 3).
- Produces: `correctShipmentReceiptQty(shipmentId, lineItemId, newQty, opts)` — Task 7 (routers.ts) and Task 8 (frontend) call this directly.

- [ ] **Step 1: Write the failing tests**

Add to `server/shipments.test.ts`, inside `describe("shipments", ...)`:

```ts
  it("markShipmentArrived records lineItemId on every receipt event it writes", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container9",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(shipment.id, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
    await markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" });

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const [receipt] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    expect(receipt.lineItemId).toBe(lineItems[0].id);
  });

  it("correctShipmentReceiptQty corrects a wrong receipt quantity via the shipment + line item", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container10",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(shipment.id, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
    await markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" });

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const result = await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 89000, { changedBy: userId, reasonNote: "recount found 1000 short" });

    expect(result.consumedFromOtherBatches).toBe(false);
    expect(await getSoh(skuId, ffWarehouseId)).toBe(89000);
  });

  it("correctShipmentReceiptQty disambiguates two line items sharing one SKU on the same shipment", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po1 = await createPurchaseOrder({ poNumber: "PO1", vendorId: vendor.id, lineItems: [{ skuId: sku.id, qty: 50000, unitPrice: "0.15", currency: "USD" }], createdBy: userId });
    const po2 = await createPurchaseOrder({ poNumber: "PO2", vendorId: vendor.id, lineItems: [{ skuId: sku.id, qty: 40000, unitPrice: "0.16", currency: "USD" }], createdBy: userId });
    const po1WithItems = await getPurchaseOrderWithLineItemsHelper(po1.id);
    const po2WithItems = await getPurchaseOrderWithLineItemsHelper(po2.id);

    const shipment = await createShipment({
      shipmentRef: "Pooled-Container1",
      warehouseId: ffWarehouseId,
      lineItems: [
        { poLineItemId: po1WithItems.lineItems[0].id, skuId: sku.id, qty: 50000, weightShare: "0.55555556", valueShare: "0.55172414" },
        { poLineItemId: po2WithItems.lineItems[0].id, skuId: sku.id, qty: 40000, weightShare: "0.44444444", valueShare: "0.44827586" },
      ],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(shipment.id, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
    await markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" });

    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    const firstLine = lineItems.find((li) => li.qty === 50000)!;
    const secondLine = lineItems.find((li) => li.qty === 40000)!;

    // Correcting only the first line item must leave the second untouched --
    // proving lineItemId, not skuId, disambiguated which receipt to correct.
    await correctShipmentReceiptQty(shipment.id, firstLine.id, 49000, { changedBy: userId, reasonNote: "recount" });

    expect(await getSoh(sku.id, ffWarehouseId)).toBe(49000 + 40000);
  });

  it("correctShipmentReceiptQty rejects a nonexistent shipment/line item combination", async () => {
    await expect(
      correctShipmentReceiptQty(999999, 999999, 10, { changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/no uncorrected receipt found/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test shipments`
Expected: FAIL — `correctShipmentReceiptQty` is not defined; the `lineItemId` assertion in the first new test fails since `markShipmentArrived` doesn't populate it yet.

- [ ] **Step 3: Add the required imports to the test file**

`server/shipments.test.ts`'s current import line 5:
```ts
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate } from "./shipments";
```

Change to:
```ts
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, correctShipmentReceiptQty } from "./shipments";
```

- [ ] **Step 4: Update `markShipmentArrived` to populate `lineItemId`**

In `server/shipments.ts`, inside `markShipmentArrived`'s `recordLedgerEvent` call (currently):
```ts
      await recordLedgerEvent({
        skuId: line.skuId,
        warehouseId: shipment.warehouseId,
        eventType: "receipt",
        qty: line.qty,
        unitCost: landedUnitCost.toFixed(8),
        date: actualArrivalDate,
        sourceRef: shipment.shipmentRef,
      }, tx);
```

Add `lineItemId: line.id,`:
```ts
      await recordLedgerEvent({
        skuId: line.skuId,
        warehouseId: shipment.warehouseId,
        eventType: "receipt",
        qty: line.qty,
        unitCost: landedUnitCost.toFixed(8),
        date: actualArrivalDate,
        sourceRef: shipment.shipmentRef,
        lineItemId: line.id,
      }, tx);
```

- [ ] **Step 5: Implement `correctShipmentReceiptQty`**

Add to `server/shipments.ts`, at the end of the file (after `correctShipmentActualDepartDate`). First add the new import at the top of the file (currently `import { recordLedgerEvent } from "./inventoryLedger";`):

```ts
import { recordLedgerEvent, correctLedgerReceipt, type LedgerCorrectionResult } from "./inventoryLedger";
```

Then add:

```ts
async function findUncorrectedReceipt(
  tx: DbClient,
  shipmentRef: string,
  lineItemId: number,
  fallbackSkuId: number,
): Promise<{ id: number }> {
  const byLineItem = await tx
    .select({ id: inventoryLedger.id })
    .from(inventoryLedger)
    .where(and(
      eq(inventoryLedger.eventType, "receipt"),
      eq(inventoryLedger.sourceRef, shipmentRef),
      eq(inventoryLedger.lineItemId, lineItemId),
      isNull(inventoryLedger.correctsEventId),
    ));
  const uncorrectedByLineItem = [];
  for (const candidate of byLineItem) {
    const [alreadyCorrected] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.correctsEventId, candidate.id));
    if (!alreadyCorrected) uncorrectedByLineItem.push(candidate);
  }
  if (uncorrectedByLineItem.length === 1) return uncorrectedByLineItem[0];
  if (uncorrectedByLineItem.length > 1) {
    throw new Error(`ambiguous: ${uncorrectedByLineItem.length} uncorrected receipts found for lineItemId ${lineItemId} on shipment ref ${shipmentRef}`);
  }

  // Fall back to skuId for receipts written before lineItemId existed on
  // inventory_ledger.
  const bySku = await tx
    .select({ id: inventoryLedger.id })
    .from(inventoryLedger)
    .where(and(
      eq(inventoryLedger.eventType, "receipt"),
      eq(inventoryLedger.sourceRef, shipmentRef),
      eq(inventoryLedger.skuId, fallbackSkuId),
      isNull(inventoryLedger.lineItemId),
    ));
  const uncorrectedBySku = [];
  for (const candidate of bySku) {
    const [alreadyCorrected] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.correctsEventId, candidate.id));
    if (!alreadyCorrected) uncorrectedBySku.push(candidate);
  }
  if (uncorrectedBySku.length === 0) {
    throw new Error(`correctShipmentReceiptQty: no uncorrected receipt found for shipment ref ${shipmentRef} / line item ${lineItemId}`);
  }
  if (uncorrectedBySku.length > 1) {
    throw new Error(
      `ambiguous: ${uncorrectedBySku.length} uncorrected receipts found for shipment ref ${shipmentRef}, and this shipment predates per-line-item ledger tracking — cannot disambiguate which one is line item ${lineItemId}`,
    );
  }
  return uncorrectedBySku[0];
}

export async function correctShipmentReceiptQty(
  shipmentId: number,
  lineItemId: number,
  newQty: number,
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<LedgerCorrectionResult> {
  return db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
    if (!shipment) {
      throw new Error(`correctShipmentReceiptQty: no shipment found with id ${shipmentId}`);
    }
    const [line] = await tx.select().from(shipmentLineItems).where(eq(shipmentLineItems.id, lineItemId));
    if (!line || line.shipmentId !== shipmentId) {
      throw new Error(`correctShipmentReceiptQty: no line item ${lineItemId} found on shipment ${shipmentId}`);
    }
    const receipt = await findUncorrectedReceipt(tx, shipment.shipmentRef, lineItemId, line.skuId);
    return correctLedgerReceipt(receipt.id, { qty: newQty }, opts, tx);
  });
}
```

Add the two new Drizzle imports this needs to the top of `server/shipments.ts` (currently `import { eq } from "drizzle-orm";`):
```ts
import { eq, and, isNull } from "drizzle-orm";
```

And add `inventoryLedger` to the existing schema import (currently `import { shipments, shipmentLineItems, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";`):
```ts
import { shipments, shipmentLineItems, inventoryLedger, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
```

And add the `DbClient` type import (check the top of the file — it currently only imports `db` from `./dbClient`; add `type DbClient`):
```ts
import { db, type DbClient } from "./dbClient";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test shipments`
Expected: PASS, all 4 new tests plus every pre-existing test in this file (including `markShipmentArrived`'s existing tests, which must still pass with `lineItemId` now populated but not asserted against).

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm check`
Expected: fully green except the one pre-existing, unrelated failure.

- [ ] **Step 8: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts
git commit -m "feat: correctShipmentReceiptQty -- correct a wrong receipt qty by shipment + line item

markShipmentArrived now populates lineItemId on every receipt it
writes. correctShipmentReceiptQty resolves shipmentId+lineItemId to
the right ledger receipt (lineItemId-first, skuId-fallback for older
rows) and delegates to correctLedgerReceipt. Disambiguates the
same-SKU-two-line-items case Stream G's own build already found.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `correctShipmentLandedCost` wrapper

**Files:**
- Modify: `server/shipments.ts`
- Test: `server/shipments.test.ts`

**Interfaces:**
- Consumes: `correctLedgerReceipt` (Task 3), `findUncorrectedReceipt` (Task 4, same file, not exported — used internally), `getShipmentLandedUnitCost` (existing, `server/landedCost.ts`).
- Produces: `correctShipmentLandedCost(shipmentId, costs, opts)` — Task 7 and Task 8 call this directly.

- [ ] **Step 1: Write the failing tests**

Add to `server/shipments.test.ts`, inside `describe("shipments", ...)`:

```ts
  it("correctShipmentLandedCost recomputes and corrects landed cost for every line item after a freight/duty restatement", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container11",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(shipment.id, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
    await markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" });

    const result = await correctShipmentLandedCost(
      shipment.id,
      { freightCost: "1800.00" },
      { changedBy: userId, reasonNote: "real freight invoice arrived, double the estimate" },
    );

    expect(result.corrections).toHaveLength(1);
    const [updatedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(updatedShipment.freightCost).toBe("1800.0000");

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    const correctedReceipt = events.find((e) => e.id === result.corrections[0].correctedId)!;
    // (90000 * 0.15 EXW + 1800 freight * 1.0 share + 100 duty * 1.0 share) / 90000
    expect(parseFloat(correctedReceipt.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 1800 + 100) / 90000, 4);

    const history = await listChangeLog("shipment", shipment.id);
    const freightEntry = history.find((h) => h.field === "freightCost" && h.reasonCategory === "data_correction");
    expect(freightEntry).toBeDefined();
  });

  it("correctShipmentLandedCost rolls back entirely if one line item's correction fails", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({ poNumber: "PO1", vendorId: vendor.id, lineItems: [{ skuId: sku.id, qty: 50000, unitPrice: "0.15", currency: "USD" }], createdBy: userId });
    const poWithItems = await getPurchaseOrderWithLineItemsHelper(po.id);
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container12",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: poWithItems.lineItems[0].id, skuId: sku.id, qty: 50000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await updateShipmentPlannedDepartDate(shipment.id, new Date("2026-09-01"), { reasonCategory: "logistics_delay", changedBy: userId });
    await markShipmentDeparted(shipment.id, new Date("2026-09-02"), { changedBy: userId });
    await updateShipmentStatus(shipment.id, "in_transit", { changedBy: userId });
    await updateShipmentStatus(shipment.id, "customs", { changedBy: userId });
    await recordShipmentCosts(shipment.id, { freightCost: "900.00", dutyCost: "100.00", costCurrency: "USD" }, { reasonCategory: "freight_rate_change", changedBy: userId });
    await markShipmentArrived(shipment.id, new Date("2026-09-20"), { changedBy: userId, reasonCategory: "logistics_delay" });
    // Manually correct the receipt once already, so this shipment's one
    // line item is no longer correctable -- correctShipmentLandedCost must
    // then find zero candidates for it and fail the whole transaction.
    const { lineItems } = await getShipmentWithLineItems(shipment.id);
    await correctShipmentReceiptQty(shipment.id, lineItems[0].id, 49000, { changedBy: userId, reasonNote: "already corrected once" });

    await expect(
      correctShipmentLandedCost(shipment.id, { dutyCost: "200.00" }, { changedBy: userId, reasonNote: "test rollback" }),
    ).rejects.toThrow();

    // freightCost/dutyCost on the shipments row must be unchanged -- the
    // update inside the failed transaction must have rolled back too.
    const [unchangedShipment] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchangedShipment.dutyCost).toBe("100.0000");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test shipments`
Expected: FAIL — `correctShipmentLandedCost` is not defined.

- [ ] **Step 3: Add the required import to the test file**

`server/shipments.test.ts`'s import line 5, extend once more:
```ts
import { createShipment, markShipmentDeparted, updateShipmentPlannedDepartDate, getShipmentWithLineItems, recordShipmentCosts, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, correctShipmentReceiptQty, correctShipmentLandedCost } from "./shipments";
```

- [ ] **Step 4: Implement `correctShipmentLandedCost`**

Add to `server/shipments.ts`, after `correctShipmentReceiptQty`:

```ts
export async function correctShipmentLandedCost(
  shipmentId: number,
  costs: { freightCost?: string; dutyCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<{ corrections: LedgerCorrectionResult[] }> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
    if (!before) {
      throw new Error(`correctShipmentLandedCost: no shipment found with id ${shipmentId}`);
    }
    if (Object.keys(costs).length === 0) {
      throw new Error(`correctShipmentLandedCost: no cost fields provided to correct`);
    }
    await tx.update(shipments).set(costs).where(eq(shipments.id, shipmentId));
    if (costs.freightCost !== undefined) {
      await logChange({
        entityType: "shipment",
        entityId: shipmentId,
        field: "freightCost",
        oldValue: normalizeDecimalForAudit(before.freightCost),
        newValue: normalizeDecimalForAudit(costs.freightCost),
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      }, tx);
    }
    if (costs.dutyCost !== undefined) {
      await logChange({
        entityType: "shipment",
        entityId: shipmentId,
        field: "dutyCost",
        oldValue: normalizeDecimalForAudit(before.dutyCost),
        newValue: normalizeDecimalForAudit(costs.dutyCost),
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      }, tx);
    }

    const landedCosts = await getShipmentLandedUnitCost(shipmentId, tx);
    const corrections: LedgerCorrectionResult[] = [];
    for (const lc of landedCosts) {
      const receipt = await findUncorrectedReceipt(tx, before.shipmentRef, lc.lineItemId, lc.skuId);
      corrections.push(await correctLedgerReceipt(receipt.id, { unitCost: lc.landedUnitCost.toFixed(8) }, opts, tx));
    }
    return { corrections };
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test shipments`
Expected: PASS, all new tests plus every pre-existing test.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm check`
Expected: fully green except the one pre-existing, unrelated failure.

- [ ] **Step 7: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts
git commit -m "feat: correctShipmentLandedCost -- restate freight/duty and correct every line item's receipt

All-or-nothing across every line item on the shipment: recomputes
getShipmentLandedUnitCost with the new costs and corrects each line's
receipt via correctLedgerReceipt inside one transaction.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `correctPaymentAmount` wrapper

**Files:**
- Modify: `server/payments.ts`
- Test: `server/payments.test.ts`

**Interfaces:**
- Consumes: `markPaymentPaidCore` (existing).
- Produces: `correctPaymentAmount(id, opts)` — Task 7 and Task 8 call this directly.

- [ ] **Step 1: Write the failing tests**

Add to `server/payments.test.ts`, inside `describe("payments and transactions", ...)`:

```ts
  it("correctPaymentAmount corrects an already-paid payment's amount, date, and fxRate", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "1000.00", expectedDate: new Date("2026-09-01"), currency: "USD" });
    await markPaymentPaid(payment.id, { amount: "1000.00", fxRate: "0.90", paidDate: new Date("2026-09-05"), reasonCategory: "payment_timing", changedBy: userId });

    const corrected = await correctPaymentAmount(payment.id, {
      amount: "950.00",
      fxRate: "0.92",
      paidDate: new Date("2026-09-06"),
      changedBy: userId,
      reasonNote: "bank statement shows a different actual amount",
    });

    expect(corrected.paidAmount).toBe("950.0000");
    expect(parseFloat(corrected.fxRate ?? "0")).toBeCloseTo(0.92, 6);

    const history = await listChangeLog("payment", payment.id);
    const paidAmountEntry = history.find((h) => h.field === "paidAmount" && h.reasonCategory === "data_correction");
    expect(paidAmountEntry).toBeDefined();
    expect(paidAmountEntry?.oldValue).toBe("1000");
    expect(paidAmountEntry?.newValue).toBe("950");
  });

  it("correctPaymentAmount rejects correcting a payment that hasn't been paid yet", async () => {
    const vendor = await createVendor({ name: "MBS Logistics" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });
    const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "1000.00", expectedDate: new Date("2026-09-01"), currency: "USD" });

    await expect(
      correctPaymentAmount(payment.id, { amount: "950.00", fxRate: "0.92", paidDate: new Date("2026-09-06"), changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow(/is not yet paid/);
  });

  it("correctPaymentAmount rejects a nonexistent payment id", async () => {
    await expect(
      correctPaymentAmount(999999, { amount: "1.00", fxRate: "1", paidDate: new Date(), changedBy: userId, reasonNote: "test" }),
    ).rejects.toThrow();
  });
```

This matches every other test in `server/payments.test.ts` exactly — they all use `lineItems: []` (a payment is tied only to `poId`, never to a PO's line items), e.g. the existing `it("logs change_log entries with real prior values when a payment is marked paid", ...)` test at line 73 does the identical `createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId })`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test payments`
Expected: FAIL — `correctPaymentAmount` and `listChangeLog` are not defined/imported yet.

- [ ] **Step 3: Add the required imports to the test file**

`server/payments.test.ts`'s current import line 6:
```ts
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listUnpaidPayments, listTransactions } from "./payments";
```

Change to:
```ts
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listUnpaidPayments, listTransactions, correctPaymentAmount } from "./payments";
```

Add a new import line (this file does not currently import `listChangeLog` — confirmed by reading its current top-of-file imports):
```ts
import { listChangeLog } from "./changeLog";
```

- [ ] **Step 4: Implement `correctPaymentAmount`**

Add to `server/payments.ts`, after `markPaymentPaid`:

```ts
export interface CorrectPaymentAmountOpts {
  amount: string;
  fxRate: string;
  paidDate: Date;
  changedBy: number;
  reasonNote: string;
}

export async function correctPaymentAmount(id: number, opts: CorrectPaymentAmountOpts): Promise<Payment> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, id));
    if (!payment) {
      throw new Error(`correctPaymentAmount: no payment found with id ${id}`);
    }
    if (!payment.paid) {
      throw new Error(
        `correctPaymentAmount: payment ${id} is not yet paid — use markPaymentPaid to record the first payment, ` +
        `correctPaymentAmount only corrects an already-recorded one`,
      );
    }
    return markPaymentPaidCore(
      id,
      {
        amount: opts.amount,
        fxRate: opts.fxRate,
        paidDate: opts.paidDate,
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      },
      tx,
    );
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test payments`
Expected: PASS, all 3 new tests plus every pre-existing test.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm check`
Expected: fully green except the one pre-existing, unrelated failure.

- [ ] **Step 7: Commit**

```bash
git add server/payments.ts server/payments.test.ts
git commit -m "feat: correctPaymentAmount -- explicit, precondition-checked correction of an already-paid payment

Requires payment.paid === true (mirrors correctShipmentActualDepartDate's
'only corrects an existing value' convention). Delegates to the same
markPaymentPaidCore write markPaymentPaid itself uses, with an
explicit data_correction reason category.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: tRPC procedures

**Files:**
- Modify: `server/routers.ts`
- Test: none new (this is a thin wiring layer over already-tested functions; covered by Task 8/9's frontend integration and this codebase's existing convention of not writing router-level tests separate from the underlying function's own tests)

**Interfaces:**
- Consumes: `correctShipmentReceiptQty`, `correctShipmentLandedCost` (Task 4/5), `correctPaymentAmount` (Task 6).
- Produces: `shipments.correctReceiptQty`, `shipments.correctLandedCost`, `payments.correctAmount` tRPC procedures — Task 8/9's frontend calls these by name via `trpc.shipments.correctReceiptQty.useMutation()` etc.

- [ ] **Step 1: Add the new server-function imports**

`server/routers.ts`'s current import line 7:
```ts
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, getShipmentWithLineItems, listShipments, listShipmentsForPo, recordShipmentCosts } from "./shipments";
```

Change to:
```ts
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, correctShipmentReceiptQty, correctShipmentLandedCost, getShipmentWithLineItems, listShipments, listShipmentsForPo, recordShipmentCosts } from "./shipments";
```

Current import line 8:
```ts
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments, listTransactions } from "./payments";
```

Change to:
```ts
import { createExpectedPayment, markPaymentPaid, correctPaymentAmount, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments, listTransactions } from "./payments";
```

- [ ] **Step 2: Add the two shipment procedures**

In `server/routers.ts`'s `shipments: router({ ... })` block, add these two entries after `correctActualDepartDate:` (before `history:`):

```ts
    correctReceiptQty: editorProcedure
      .input(z.object({
        shipmentId: z.number(),
        lineItemId: z.number(),
        newQty: z.number().int().positive(),
        reasonNote: z.string().min(1),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentReceiptQty(input.shipmentId, input.lineItemId, input.newQty, {
          changedBy: ctx.user.id,
          reasonNote: input.reasonNote,
        }),
      ),
    correctLandedCost: editorProcedure
      .input(z.object({
        shipmentId: z.number(),
        freightCost: z.string().optional(),
        dutyCost: z.string().optional(),
        reasonNote: z.string().min(1),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentLandedCost(
          input.shipmentId,
          { freightCost: input.freightCost, dutyCost: input.dutyCost },
          { changedBy: ctx.user.id, reasonNote: input.reasonNote },
        ),
      ),
```

- [ ] **Step 3: Add the payment procedure**

In `server/routers.ts`'s `payments: router({ ... })` block, add this entry after `markPaid:` (before `recordTransaction:`):

```ts
    correctAmount: editorProcedure
      .input(z.object({
        id: z.number(),
        amount: z.string(),
        fxRate: z.string(),
        paidDate: z.date(),
        reasonNote: z.string().min(1),
      }))
      .mutation(({ input, ctx }) =>
        correctPaymentAmount(input.id, {
          amount: input.amount,
          fxRate: input.fxRate,
          paidDate: input.paidDate,
          changedBy: ctx.user.id,
          reasonNote: input.reasonNote,
        }),
      ),
```

- [ ] **Step 4: Run type check and full suite**

Run: `pnpm check && pnpm test`
Expected: clean type check; full suite green except the one pre-existing, unrelated failure.

- [ ] **Step 5: Commit**

```bash
git add server/routers.ts
git commit -m "feat: wire correctReceiptQty/correctLandedCost/correctAmount as tRPC procedures

Thin editorProcedure wrappers, reasonNote required (z.string().min(1))
at the input-validation layer too, not just inside the server functions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — `CorrectReceiptControl` on `ShipmentsPage.tsx`

**Files:**
- Modify: `client/src/pages/ShipmentsPage.tsx`

**Interfaces:**
- Consumes: `trpc.shipments.correctReceiptQty`, `trpc.shipments.correctLandedCost` (Task 7).

- [ ] **Step 1: Add the new form-state type and default, near the other form-state interfaces (after `DepartDateCorrectionFormState`/`defaultDepartDateCorrectionForm`, around line 91)**

```ts
interface ReceiptCorrectionFormState {
  lineItemId: string;
  newQty: string;
  freightCost: string;
  dutyCost: string;
  reasonNote: string;
}

function defaultReceiptCorrectionForm(shipment: ShipmentListItem): ReceiptCorrectionFormState {
  return {
    lineItemId: "",
    newQty: "",
    freightCost: shipment.freightCost ?? "",
    dutyCost: shipment.dutyCost ?? "",
    reasonNote: "",
  };
}
```

- [ ] **Step 2: Add the `CorrectReceiptControl` component, after `DepartDateCorrectionControl` (before `ShipmentRow`, around line 355)**

```ts
function CorrectReceiptControl({ shipment, lineItems, onUpdated }: { shipment: ShipmentListItem; lineItems: { id: number; skuId: number; qty: number }[]; onUpdated: () => void }) {
  const correctReceiptQty = trpc.shipments.correctReceiptQty.useMutation({ onSuccess: onUpdated });
  const correctLandedCost = trpc.shipments.correctLandedCost.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<ReceiptCorrectionFormState>(() => defaultReceiptCorrectionForm(shipment));
  const [lastResult, setLastResult] = useState<{ consumedFromOtherBatches: boolean } | null>(null);

  // Only meaningful once a receipt has actually been written to the
  // ledger — before that, there is nothing to correct.
  if (shipment.status !== "delivered") return null;

  const canCorrectQty = form.lineItemId !== "" && form.newQty.trim().length > 0 && form.reasonNote.trim().length > 0;
  const costsChanged = form.freightCost !== (shipment.freightCost ?? "") || form.dutyCost !== (shipment.dutyCost ?? "");
  const canCorrectCost = costsChanged && form.reasonNote.trim().length > 0;

  return (
    <div>
      <strong>Correct receipt</strong>
      <div>
        <select value={form.lineItemId} onChange={(e) => setForm((prev) => ({ ...prev, lineItemId: e.target.value }))}>
          <option value="">Line item…</option>
          {lineItems.map((li) => <option key={li.id} value={li.id}>SKU {li.skuId} — qty {li.qty}</option>)}
        </select>
        <input
          type="text"
          placeholder="corrected qty"
          value={form.newQty}
          onChange={(e) => setForm((prev) => ({ ...prev, newQty: e.target.value }))}
        />
        <button
          disabled={!canCorrectQty || correctReceiptQty.isPending}
          onClick={() =>
            correctReceiptQty.mutate(
              { shipmentId: shipment.id, lineItemId: Number(form.lineItemId), newQty: Number(form.newQty), reasonNote: form.reasonNote },
              { onSuccess: (result) => setLastResult(result) },
            )
          }
        >
          Correct quantity
        </button>
      </div>
      <div style={{ marginTop: "4px" }}>
        <input
          type="text"
          placeholder="freight cost"
          value={form.freightCost}
          onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="duty cost"
          value={form.dutyCost}
          onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
        />
        <button
          disabled={!canCorrectCost || correctLandedCost.isPending}
          onClick={() =>
            correctLandedCost.mutate(
              {
                shipmentId: shipment.id,
                freightCost: form.freightCost !== (shipment.freightCost ?? "") ? form.freightCost : undefined,
                dutyCost: form.dutyCost !== (shipment.dutyCost ?? "") ? form.dutyCost : undefined,
                reasonNote: form.reasonNote,
              },
              { onSuccess: (result) => setLastResult({ consumedFromOtherBatches: result.corrections.some((c) => c.consumedFromOtherBatches) }) },
            )
          }
        >
          Correct cost restated
        </button>
      </div>
      <input
        type="text"
        placeholder="what changed and why"
        value={form.reasonNote}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
      />
      {(correctReceiptQty.error ?? correctLandedCost.error) && (
        <div>Failed to correct: {(correctReceiptQty.error ?? correctLandedCost.error)!.message}</div>
      )}
      {lastResult?.consumedFromOtherBatches && (
        <div>This correction drew from a different batch than the one being corrected, because the original batch was already partly or fully sold — past Daily COGS is not recalculated.</div>
      )}
    </div>
  );
}
```

Note: no `reasonCategory` `<select>` here at all, per the design's Global Constraint — only the required `reasonNote` field. Copy stays neutral ("Correct quantity", "Correct cost restated"), not "Fix error".

- [ ] **Step 3: Render `CorrectReceiptControl` inside `ShipmentRow`**

In `ShipmentRow` (around line 391, immediately after the existing `DepartDateCorrectionControl` div):
```tsx
        <div style={{ marginTop: "8px" }}>
          <DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
```

Add:
```tsx
        <div style={{ marginTop: "8px" }}>
          <CorrectReceiptControl
            shipment={shipment}
            lineItems={data.lineItems}
            onUpdated={() => { refetch(); utils.shipments.list.invalidate(); utils.dashboards.money.invalidate(); utils.dashboards.stock.invalidate(); }}
          />
        </div>
```

`data.lineItems` is already available in `ShipmentRow`'s scope (from `trpc.shipments.getWithLineItems.useQuery(shipment.id)` at the top of the component) — no new query needed.

- [ ] **Step 4: Manual verification against the real dev server**

Run: `pnpm dev` (server on :3000, Vite client via the `/api` proxy). Log in, navigate to the Shipments page, find a `delivered` shipment, and:
1. Correct a receipt quantity — confirm the page's SOH-adjacent numbers (check the Stock page too) reflect the new quantity after the mutation succeeds.
2. Correct freight cost on the same shipment — confirm the landed-cost figure shown elsewhere (Cost & Cashflow's Landed Cost tab) updates.
3. Confirm the "Correct quantity"/"Correct cost restated" buttons stay disabled until `reasonNote` is filled in.

This is a UI change — `pnpm check`/`pnpm test` alone do not prove the form renders and submits correctly; this manual pass is required before considering this task done, per this project's own established convention for frontend changes.

- [ ] **Step 5: Run type check**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/ShipmentsPage.tsx
git commit -m "feat: CorrectReceiptControl on the Shipments page

Visible only on a delivered shipment. Two actions (correct qty,
correct cost) sharing one required reasonNote field, no reasonCategory
dropdown. Surfaces the consumedFromOtherBatches warning inline,
matching this app's existing error-display convention (no toast
library exists in this codebase).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — `CorrectPaymentControl` on `PurchaseOrdersPage.tsx`

**Files:**
- Modify: `client/src/pages/PurchaseOrdersPage.tsx`

**Interfaces:**
- Consumes: `trpc.payments.correctAmount` (Task 7).

**Note on location**: the plan this task was dispatched from originally assumed `TransactionsPage.tsx` — that page only lists bank *transactions* (`payments.listTransactions`), not `payments` rows with a `paid`/`paidAmount` field. The real per-payment `paid === true` view lives in `PurchaseOrdersPage.tsx`'s `MarkPaidRow` component (`client/src/pages/PurchaseOrdersPage.tsx:71-141`), inside its `if (payment.paid)` branch (lines 78-84). This task targets that file, not `TransactionsPage.tsx`.

- [ ] **Step 1: Add the new form-state type and default, near the top of `PurchaseOrdersPage.tsx` (after `defaultMarkPaidForm`, around line 69)**

```ts
interface PaymentCorrectionFormState {
  amount: string;
  fxRate: string;
  paidDate: string;
  reasonNote: string;
}

function defaultPaymentCorrectionForm(payment: Payment): PaymentCorrectionFormState {
  return {
    amount: payment.paidAmount ?? "",
    fxRate: payment.fxRate ?? "1",
    paidDate: payment.paidDate ? toDateInputValue(payment.paidDate) : toDateInputValue(null),
    reasonNote: "",
  };
}
```

- [ ] **Step 2: Add the `CorrectPaymentControl` component, after `PaymentHistory` (before `PoPaymentsSection`, around line 163)**

```ts
function CorrectPaymentControl({ payment, onCorrected }: { payment: Payment; onCorrected: () => void }) {
  const correctAmount = trpc.payments.correctAmount.useMutation({ onSuccess: onCorrected });
  const [form, setForm] = useState<PaymentCorrectionFormState>(() => defaultPaymentCorrectionForm(payment));
  const canSave = form.amount.trim().length > 0 && form.fxRate.trim().length > 0 && form.reasonNote.trim().length > 0;

  return (
    <span>
      {" "}
      <input
        type="text"
        placeholder="corrected amount"
        value={form.amount}
        onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
      />
      <input
        type="text"
        placeholder="fx rate"
        value={form.fxRate}
        onChange={(e) => setForm((prev) => ({ ...prev, fxRate: e.target.value }))}
      />
      <input
        type="date"
        value={form.paidDate}
        onChange={(e) => setForm((prev) => ({ ...prev, paidDate: e.target.value }))}
      />
      <input
        type="text"
        placeholder="what changed and why"
        value={form.reasonNote}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
      />
      <button
        disabled={!canSave || correctAmount.isPending}
        onClick={() =>
          correctAmount.mutate({
            id: payment.id,
            amount: form.amount,
            fxRate: form.fxRate,
            paidDate: new Date(form.paidDate),
            reasonNote: form.reasonNote,
          })
        }
      >
        Correct payment
      </button>
      {correctAmount.error && <div>Failed to correct: {correctAmount.error.message}</div>}
    </span>
  );
}
```

No `reasonCategory` dropdown, matching `CorrectReceiptControl`'s convention and the design's Global Constraint.

- [ ] **Step 3: Render `CorrectPaymentControl` inside `MarkPaidRow`'s `payment.paid` branch**

Current (lines 78-84):
```tsx
  if (payment.paid) {
    return (
      <li>
        Payment #{payment.sequenceNo}: paid {formatMoney(payment.paidAmount!, payment.currency)} on {payment.paidDate ? new Date(payment.paidDate).toISOString().slice(0, 10) : "—"}
        <PaymentHistory paymentId={payment.id} />
      </li>
    );
  }
```

Change to:
```tsx
  if (payment.paid) {
    return (
      <li>
        Payment #{payment.sequenceNo}: paid {formatMoney(payment.paidAmount!, payment.currency)} on {payment.paidDate ? new Date(payment.paidDate).toISOString().slice(0, 10) : "—"}
        <CorrectPaymentControl payment={payment} onCorrected={onPaid} />
        <PaymentHistory paymentId={payment.id} />
      </li>
    );
  }
```

`onPaid` is already `MarkPaidRow`'s existing prop (`{ payment, onPaid }: { payment: Payment; onPaid: () => void }`) — no new prop threading needed, since `PoPaymentsSection`'s `refreshAfterPaid` (passed down as `onPaid`) already invalidates `payments.listForPo` and `dashboards.money`, exactly what a correction also needs to invalidate.

- [ ] **Step 4: Manual verification against the real dev server**

Run: `pnpm dev`. Navigate to Purchase Orders, find a PO with a paid payment, and:
1. Correct the paid amount — confirm the displayed "paid {amount}" text updates after the mutation succeeds.
2. Confirm the button stays disabled until `reasonNote` is filled in.
3. Expand "History" (the existing `PaymentHistory` toggle right next to the new control) and confirm a `data_correction`-tagged `paidAmount` entry appears.

- [ ] **Step 5: Run type check**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PurchaseOrdersPage.tsx
git commit -m "feat: CorrectPaymentControl on the Purchase Orders page

Visible on every already-paid payment row (MarkPaidRow's payment.paid
branch). Amount/fxRate/paidDate + required reasonNote, no
reasonCategory dropdown, reusing MarkPaidRow's existing onPaid
invalidation callback.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Review

After all 9 tasks: dispatch the final whole-branch code reviewer on the most capable available model (opus), given this touches real ledger/payment write paths — matching this project's own established escalation precedent for financial-correctness-sensitive reviews (see `docs/BUILD-HISTORY.md`'s Backlog Stream L entry for the precedent). The review should specifically re-verify, against the final code (not just each task's own diff):

1. **Forward-only invariant held everywhere**: no code path in this whole stream ever calls `.update(inventoryLedger)` or `.delete()` against `inventoryLedger` — only `.insert()` via `recordLedgerEvent`. Grep to confirm.
2. **The `lineItemId`-first / `skuId`-fallback disambiguation** actually behaves as designed on a shipment with two line items sharing one SKU — re-trace Task 4's own test scenario by hand against the final code, not just trust the test passing.
3. **`correctShipmentLandedCost`'s all-or-nothing guarantee** — force a mid-loop failure on a shipment with 3+ line items (not just the 1-line-item case Task 5's own test used) and confirm zero partial state survives.
4. **`consumedFromOtherBatches`'s correctness** on a case with 3+ batches touched by one reversal (Task 3's own test only proves 2 batches) — a real risk that `Set` iteration order or an off-by-one in the touched-refs collection could silently miss a batch.
5. **No `reasonCategory` is ever user-suppliable** on any of the three new tRPC procedures — re-read `server/routers.ts`'s final state to confirm no procedure's Zod input schema includes `reasonCategory` for these three specific mutations (every other mutation in this router does include it; these three deliberately must not).
6. **UI copy audit**: grep the two new/modified client files for the words "error"/"mistake"/"wrong" in any user-visible string — the design's own copy convention requires neutral language throughout.

If the final whole-branch review returns findings, dispatch ONE fix subagent with the complete findings list, then one scoped re-review, per this project's established process. Then push per the established `gh auth switch` dance (`gh auth switch --user Artem-SCM-AI`, push, `gh auth switch --user ArtemTucann`), and update `docs/BACKLOG.md` (mark the "no reversal or correction path" Operational-lens item done) / `docs/BUILD-HISTORY.md` (a new dated section) / `README.md`'s Current Status and test count.
