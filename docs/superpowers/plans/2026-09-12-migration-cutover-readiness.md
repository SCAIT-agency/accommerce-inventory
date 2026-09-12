# Migration & Cutover Readiness (Backlog Stream B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `accommerce-inventory`'s data model and migration tooling trustworthy enough to eventually run a real migration against Accommerce/Jello's Control Tower — without touching any real client data in this plan itself.

**Architecture:** Hardens the existing V1 schema with real foreign keys on core ownership edges and a few missing validations (negative stock, SKU identifier uniqueness, Shipment status transitions), then widens `scripts/migrate-from-sheet.ts` from ledger-only to the full PO/Shipment/Payment/Transaction scope the platform spec requires, with per-entity transform functions, quarantine-not-abort handling for bad rows, single-transaction atomicity, and a tolerance-based landed-cost reconciliation check alongside the existing exact-match SOH check.

**Tech Stack:** TypeScript, Drizzle ORM (MySQL dialect), Vitest, tsx (for CLI scripts) — same stack as the rest of this repo, no new dependencies.

**Spec:** `/Users/artem/Claude v 1.0/accommerce-inventory/docs/2026-09-12-migration-cutover-readiness-design.md`

## Global Constraints

- No real Accommerce/Jello data is touched by this plan — everything is tested against the local dev database with synthetic fixtures.
- Shipment status is **not** exposed through any router or UI in this plan — only the validation logic and the migration's direct-insert path. Router/UI exposure is a separate future stream (Backlog Stream A).
- Real Control Tower Sheet column names are unknown in this environment — migration transform functions use explicit, reasonable field names (matching the existing `transformSheetExport` ledger transform's approach), not a guess at real column headers.
- Landed-cost reconciliation uses a tolerance of the greater of $0.01 or 0.1% of the compared total — SOH reconciliation stays an exact match (it's a hard integer count).
- Every malformed migration row is quarantined (skipped, with a reason, reported at the end) — never silently dropped, never aborts the whole run.
- `runMigration` runs as a single database transaction — a failure partway through rolls back cleanly, nothing partially lands.
- Negative-stock validation applies during migration too — it is not bypassed for historical data.
- Vendor reference fields are added to `purchase_orders` and `shipments` only, not `payments`.
- Follow this repo's established conventions: TDD with real DB tests (no mocks), `editorProcedure`/`protectedProcedure` split is not relevant here (backend-only, no new router work), `change_log` audit pattern for any function that mutates a delay/cost-affecting field, data-over-branching (lookup tables, not `if`/`else` chains).
- A local dev database is running — check `docker compose ps` or `brew services list` to see which (MySQL 8/8.4). `DATABASE_URL=mysql://root:devpassword@localhost:3306/accommerce_dev` (source `.env`: `set -a && source .env && set +a`). Known pre-existing gap, not this plan's to fix: cross-test DB residue when running tests in parallel — use `pnpm test` (already configured with `fileParallelism: false`) or `pnpm vitest run --no-file-parallelism`.

---

## File Structure

```
accommerce-inventory/
  drizzle/
    schema.ts                    # MODIFY: unique constraint, vendorReference columns, FKs
  server/
    db.ts                        # (no changes — SKU uniqueness enforced at DB level)
    purchaseOrders.ts             # MODIFY: vendorReference + initialStatus on createPurchaseOrder
    shipments.ts                  # MODIFY: vendorReference + initialStatus on createShipment,
                                   #         VALID_SHIPMENT_TRANSITIONS + updateShipmentStatus
    inventoryLedger.ts             # MODIFY: negative-stock guard on recordLedgerEvent
    payments.ts                    # MODIFY: already-matched guard on matchTransactionToPayment
  scripts/
    migrate-from-sheet.ts          # MODIFY: transformPurchaseOrders/Shipments/Payments/Transactions,
                                    #         quarantine handling, landed-cost tolerance
    reconcile-migration.ts          # MODIFY: runMigration widened + wrapped in one transaction
    run-migration.mjs               # CREATE: CLI entrypoint
    run-parallel-check.mjs           # CREATE: CLI entrypoint
```

---

## Task 1: SKU Identifier Uniqueness

**Files:**
- Modify: `drizzle/schema.ts` — add a unique index on `skus(primaryIdentifierType, identifierValue)`
- Test: `server/db.test.ts` (add a case to the existing file)

**Interfaces:**
- No new exports. `createSku` (existing, from `server/db.ts`) now rejects a duplicate `(primaryIdentifierType, <the corresponding identifier column's value>)` pair at the database level.

**Note on the constraint shape:** `skus` doesn't have a single `identifier_value` column — it has six separate nullable columns (`sku`, `ssku`, `asin`, `ean`, `fnsku`, `name`) plus `primaryIdentifierType` marking which one is authoritative. A composite unique index has to be on real columns, not a computed value across six of them. Add a **generated column** `identifierValue` that mirrors whichever of the six columns `primaryIdentifierType` points to, then put the unique index on `(primaryIdentifierType, identifierValue)`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/db.test.ts (addition to the existing describe block)
it("rejects a second SKU with the same primary identifier value", async () => {
  await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  await expect(createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" })).rejects.toThrow();
});

it("allows two SKUs with the same value in a non-primary identifier column", async () => {
  await createSku({ sku: "JELLO-CAL-500", ean: "0000000000001", primaryIdentifierType: "sku" });
  const second = await createSku({ sku: "JELLO-CAL-600", ean: "0000000000001", primaryIdentifierType: "sku" });
  expect(second.id).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/db.test.ts`
Expected: FAIL — no uniqueness constraint exists yet, the first test's duplicate insert would currently succeed.

- [ ] **Step 3: Write minimal implementation**

```typescript
// drizzle/schema.ts (modify the skus table)
import { sql } from "drizzle-orm";
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, unique } from "drizzle-orm/mysql-core";

export const skus = mysqlTable(
  "skus",
  {
    id: int("id").autoincrement().primaryKey(),
    sku: varchar("sku", { length: 128 }),
    ssku: varchar("ssku", { length: 128 }),
    asin: varchar("asin", { length: 32 }),
    ean: varchar("ean", { length: 32 }),
    fnsku: varchar("fnsku", { length: 32 }),
    name: varchar("name", { length: 256 }),
    primaryIdentifierType: mysqlEnum("primaryIdentifierType", [
      "sku", "ssku", "asin", "ean", "fnsku", "name",
    ]).notNull(),
    identifierValue: varchar("identifierValue", { length: 256 }).generatedAlwaysAs(
      (): SQL => sql`case
        when primaryIdentifierType = 'sku' then sku
        when primaryIdentifierType = 'ssku' then ssku
        when primaryIdentifierType = 'asin' then asin
        when primaryIdentifierType = 'ean' then ean
        when primaryIdentifierType = 'fnsku' then fnsku
        else name
      end`,
      { mode: "stored" },
    ),
    status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
    isBundle: boolean("isBundle").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    identifierUnique: unique("sku_identifier_unique").on(table.primaryIdentifierType, table.identifierValue),
  }),
);
export type Sku = typeof skus.$inferSelect;
export type InsertSku = typeof skus.$inferInsert;
```

You will also need `import type { SQL } from "drizzle-orm";` alongside the existing `sql` import if it's not already present in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:push && pnpm test server/db.test.ts`
Expected: PASS. If `drizzle-kit push` reports it needs to drop/recreate data due to the generated column, that's expected on this disposable local dev database — confirm and proceed (do not do this against any non-local database).

- [ ] **Step 5: Commit**

```bash
git add drizzle/schema.ts server/db.test.ts
git commit -m "feat: unique constraint on SKU primary identifier value"
```

---

## Task 2: Vendor Reference + Migration-Only Initial Status on Purchase Orders and Shipments

**Files:**
- Modify: `drizzle/schema.ts` — add `vendorReference` to `purchaseOrders` and `shipments`
- Modify: `server/purchaseOrders.ts` — `createPurchaseOrder` accepts optional `vendorReference`/`initialStatus`
- Modify: `server/shipments.ts` — `createShipment` accepts optional `vendorReference`/`initialStatus`
- Test: `server/purchaseOrders.test.ts`, `server/shipments.test.ts` (add cases to existing files)

**Interfaces:**
- Modifies `CreatePoInput` (in `server/purchaseOrders.ts`) to add `vendorReference?: string` and `initialStatus?: (typeof PO_STATUSES)[number]` (defaults to `"draft"` when omitted — existing callers are unaffected).
- Modifies `CreateShipmentInput` (in `server/shipments.ts`) to add `vendorReference?: string` and `initialStatus?: (typeof SHIPMENT_STATUSES)[number]` (defaults to `"planned"` when omitted).
- `initialStatus` exists **only** for Task 7's migration transforms to set a real historical final status directly — it bypasses transition validation entirely by design (see the spec's "Correction from an internal logic check"). It is not exposed by any router.

- [ ] **Step 1: Write the failing test**

```typescript
// server/purchaseOrders.test.ts (addition)
it("accepts an optional vendor reference and initial status for migration use", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({
    poNumber: "PO3-JELLO",
    vendorId: vendor.id,
    vendorReference: "LVM-INV-2026-0912",
    initialStatus: "shipped",
    lineItems: [],
    createdBy: 1,
  });
  expect(po.vendorReference).toBe("LVM-INV-2026-0912");
  expect(po.status).toBe("shipped");
});

it("defaults to draft status and a null vendor reference when neither is given", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO-2", vendorId: vendor.id, lineItems: [], createdBy: 1 });
  expect(po.status).toBe("draft");
  expect(po.vendorReference).toBeNull();
});
```

```typescript
// server/shipments.test.ts (addition)
it("accepts an optional vendor reference and initial status for migration use", async () => {
  const shipment = await createShipment({
    shipmentRef: "PO1-W4-Container2",
    vendorReference: "MBS-DEBIT-SZDN26080711",
    initialStatus: "delivered",
    lineItems: [],
    createdBy: 1,
  });
  expect(shipment.vendorReference).toBe("MBS-DEBIT-SZDN26080711");
  expect(shipment.status).toBe("delivered");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/purchaseOrders.test.ts server/shipments.test.ts`
Expected: FAIL — `vendorReference`/`initialStatus` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// drizzle/schema.ts (add to purchaseOrders table definition, alongside notes/plannedReadyDate)
vendorReference: varchar("vendorReference", { length: 128 }),
```

```typescript
// drizzle/schema.ts (add to shipments table definition, alongside customsDeclarationLink)
vendorReference: varchar("vendorReference", { length: 128 }),
```

```typescript
// server/purchaseOrders.ts (modify CreatePoInput and createPurchaseOrder)
export interface CreatePoInput {
  poNumber: string;
  vendorId: number;
  vendorReference?: string;
  initialStatus?: (typeof PO_STATUSES)[number];
  lineItems: { skuId: number; qty: number; unitPrice: string; currency: string }[];
  createdBy: number;
}

export async function createPurchaseOrder(input: CreatePoInput): Promise<PurchaseOrder> {
  const [result] = await db.insert(purchaseOrders).values({
    poNumber: input.poNumber,
    vendorId: input.vendorId,
    vendorReference: input.vendorReference,
    status: input.initialStatus ?? "draft",
    createdBy: input.createdBy,
  });
  if (input.lineItems.length > 0) {
    await db.insert(poLineItems).values(
      input.lineItems.map((li) => ({ ...li, poId: result.insertId })),
    );
  }
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, result.insertId));
  return po;
}
```

```typescript
// server/shipments.ts (modify CreateShipmentInput and createShipment)
export interface CreateShipmentInput {
  shipmentRef: string;
  vendorReference?: string;
  initialStatus?: (typeof SHIPMENT_STATUSES)[number];
  lineItems: { poLineItemId: number; skuId: number; qty: number; weightShare: string; valueShare: string }[];
  createdBy: number;
}

export async function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  const [result] = await db.insert(shipments).values({
    shipmentRef: input.shipmentRef,
    vendorReference: input.vendorReference,
    status: input.initialStatus ?? "planned",
    createdBy: input.createdBy,
  });
  if (input.lineItems.length > 0) {
    await db.insert(shipmentLineItems).values(
      input.lineItems.map((li) => ({ ...li, shipmentId: result.insertId })),
    );
  }
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, result.insertId));
  return shipment;
}
```

You'll need `SHIPMENT_STATUSES` imported in `server/shipments.ts` if it isn't already (it's exported from `drizzle/schema.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:push && pnpm test server/purchaseOrders.test.ts server/shipments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add drizzle/schema.ts server/purchaseOrders.ts server/shipments.ts server/purchaseOrders.test.ts server/shipments.test.ts
git commit -m "feat: vendor reference + migration-only initial status on PO/Shipment creation"
```

---

## Task 3: Negative-Stock Validation

**Files:**
- Modify: `server/inventoryLedger.ts` — `recordLedgerEvent` throws before a write would drive SOH negative
- Test: `server/inventoryLedger.test.ts`

**Interfaces:**
- `recordLedgerEvent`'s signature is unchanged. It now throws a descriptive `Error` instead of silently succeeding when the resulting SOH for that `(skuId, warehouseId)` would go below zero.

- [ ] **Step 1: Write the failing test**

```typescript
// server/inventoryLedger.test.ts (addition)
it("rejects a sale event that would drive SOH below zero", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
  await expect(
    recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -80, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-2026-09-02" }),
  ).rejects.toThrow(/negative/i);

  // the rejected event must not have been written
  expect(await getSoh(sku.id, ff.id)).toBe(50);
});

it("still allows a sale that exactly zeroes out SOH", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "sale", qty: -50, unitCost: null, date: new Date("2026-09-02"), sourceRef: "shopify-2026-09-02" });

  expect(await getSoh(sku.id, ff.id)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: FAIL — no such guard exists yet, the first test's negative-driving sale currently succeeds.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/inventoryLedger.ts (modify recordLedgerEvent)
export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">) {
  if (event.qty < 0) {
    const currentSoh = await getSoh(event.skuId, event.warehouseId, event.date);
    if (currentSoh + event.qty < 0) {
      throw new Error(
        `recordLedgerEvent: this event would drive SOH negative for sku ${event.skuId}/warehouse ${event.warehouseId} ` +
        `(current: ${currentSoh}, event qty: ${event.qty}) — refusing to write`,
      );
    }
  }
  await db.insert(inventoryLedger).values(event);
}
```

Note: `getSoh` is called with `event.date` as the `asOfDate` so the check reflects SOH *as of that date* (consistent with how the ledger is date-scoped elsewhere), not the current running total — this matters for migration, which may insert historical events out of strict chronological order in some edge cases.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/inventoryLedger.ts server/inventoryLedger.test.ts
git commit -m "feat: reject ledger events that would drive SOH negative"
```

---

## Task 4: Referential Integrity (Real Foreign Keys)

**Files:**
- Modify: `drizzle/schema.ts` — add `.references()` to the core ownership columns

**Interfaces:** No new exports. Existing insert functions (`createSku`, `createPurchaseOrder`, `createShipment`, `recordLedgerEvent`, `createExpectedPayment`, `recordTransaction`, `matchTransactionToPayment`) now throw a database error instead of silently succeeding when given a foreign key that doesn't exist.

**This task requires a clean local dev database before `db:push`.** The existing dev database has known cross-test residue that may already violate the new constraints. Reset it first:

```bash
# If using docker-compose:
docker compose down -v && docker compose up -d
# If using the Homebrew MySQL fallback instead (check which is running first):
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"
```

Do this only against the local dev database — never against any shared or production database.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/inventoryLedger.test.ts (addition)
it("rejects a ledger event referencing a nonexistent SKU", async () => {
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  await expect(
    recordLedgerEvent({ skuId: 999999, warehouseId: ff.id, eventType: "receipt", qty: 10, unitCost: "0.42", date: new Date(), sourceRef: "PO1" }),
  ).rejects.toThrow();
});

it("rejects a ledger event referencing a nonexistent warehouse", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  await expect(
    recordLedgerEvent({ skuId: sku.id, warehouseId: 999999, eventType: "receipt", qty: 10, unitCost: "0.42", date: new Date(), sourceRef: "PO1" }),
  ).rejects.toThrow();
});
```

```typescript
// server/payments.test.ts (addition)
it("rejects matching a transaction to a nonexistent payment", async () => {
  const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });
  await expect(matchTransactionToPayment(tx.id, 999999)).rejects.toThrow();
});
```

```typescript
// server/shipments.test.ts (addition)
it("rejects a shipment line item referencing a nonexistent PO line item", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  await expect(
    createShipment({
      shipmentRef: "PO1-W4-Container2",
      lineItems: [{ poLineItemId: 999999, skuId: sku.id, qty: 100, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: 1,
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/inventoryLedger.test.ts server/payments.test.ts server/shipments.test.ts`
Expected: FAIL — all three currently succeed silently with orphaned foreign keys.

- [ ] **Step 3: Write minimal implementation**

Add `.references()` to the following existing columns in `drizzle/schema.ts` (each is a one-line change to an already-defined column — do not otherwise restructure the tables):

```typescript
// In poLineItems:
poId: int("poId").notNull().references(() => purchaseOrders.id),
skuId: int("skuId").notNull().references(() => skus.id),

// In shipmentLineItems:
shipmentId: int("shipmentId").notNull().references(() => shipments.id),
poLineItemId: int("poLineItemId").notNull().references(() => poLineItems.id),
skuId: int("skuId").notNull().references(() => skus.id),

// In payments:
poId: int("poId").references(() => purchaseOrders.id),
shipmentId: int("shipmentId").references(() => shipments.id),

// In transactions:
matchedPaymentId: int("matchedPaymentId").references(() => payments.id),

// In inventoryLedger:
skuId: int("skuId").notNull().references(() => skus.id),
warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm db:push && pnpm test server/inventoryLedger.test.ts server/payments.test.ts server/shipments.test.ts`
Expected: PASS. If `db:push` fails because existing local data violates a new constraint, you did not reset the database per the note above — do that, then retry.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `pnpm test`
Expected: all tests pass (the reset local DB means every test file's own `beforeEach` seeding still works — nothing in the existing test suite creates a row with an intentionally-dangling foreign key).

- [ ] **Step 6: Commit**

```bash
git add drizzle/schema.ts
git commit -m "feat: real foreign keys on core ownership edges"
```

---

## Task 5: Shipment Status State Machine

**Files:**
- Modify: `server/shipments.ts` — `VALID_SHIPMENT_TRANSITIONS`, `updateShipmentStatus`, update `markShipmentDeparted` to use the table
- Test: `server/shipments.test.ts`

**Interfaces:**
- Produces: `updateShipmentStatus(id: number, newStatus: (typeof SHIPMENT_STATUSES)[number], opts: { changedBy: number }): Promise<void>` — throws on an invalid transition, logs to `change_log` on success. **Not exposed by any router in this plan** (see Global Constraints).
- `markShipmentDeparted` now internally validates via the same transition table instead of unconditionally setting `status: "departed"`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/shipments.test.ts (addition)
it("rejects an invalid shipment status transition", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
  await expect(updateShipmentStatus(shipment.id, "delivered", { changedBy: 1 })).rejects.toThrow(/invalid transition/);
});

it("accepts a valid shipment status transition and logs it", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", initialStatus: "departed", lineItems: [], createdBy: 1 });
  await updateShipmentStatus(shipment.id, "in_transit", { changedBy: 1 });

  const updated = await getShipmentWithLineItems(shipment.id);
  expect(updated.status).toBe("in_transit");

  const entries = await listChangeLog("shipment", shipment.id);
  expect(entries[0].field).toBe("status");
  expect(entries[0].newValue).toBe("in_transit");
});

it("markShipmentDeparted still rejects a shipment with no planned depart date, via the same transition table", async () => {
  const shipment = await createShipment({ shipmentRef: "PO1-W4-Container2", lineItems: [], createdBy: 1 });
  await expect(markShipmentDeparted(shipment.id, new Date(), { changedBy: 1 })).rejects.toThrow(/planned depart date/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/shipments.test.ts`
Expected: FAIL — `updateShipmentStatus` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/shipments.ts (addition)
const VALID_SHIPMENT_TRANSITIONS: Record<(typeof SHIPMENT_STATUSES)[number], (typeof SHIPMENT_STATUSES)[number][]> = {
  planned: ["departed"],
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};

export async function updateShipmentStatus(
  id: number,
  newStatus: (typeof SHIPMENT_STATUSES)[number],
  opts: { changedBy: number },
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
    changedBy: opts.changedBy,
  });
}
```

Update the existing `markShipmentDeparted` to route through the same table instead of hard-setting status:

```typescript
// server/shipments.ts (modify markShipmentDeparted)
export async function markShipmentDeparted(id: number, actualDate: Date, opts: { changedBy: number }) {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment.plannedDepartDate) {
    throw new Error("cannot mark departed: no planned depart date set");
  }
  if (!VALID_SHIPMENT_TRANSITIONS[shipment.status].includes("departed")) {
    throw new Error(`invalid transition from ${shipment.status} to departed`);
  }
  await db
    .update(shipments)
    .set({ actualDepartDate: actualDate, status: "departed" })
    .where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "actualDepartDate",
    oldValue: null,
    newValue: actualDate.toISOString(),
    changedBy: opts.changedBy,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/shipments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/shipments.ts server/shipments.test.ts
git commit -m "feat: shipment status state machine, mirroring the existing PO pattern"
```

---

## Task 6: Guard Against Re-Matching an Already-Matched Transaction

**Files:**
- Modify: `server/payments.ts` — `matchTransactionToPayment` rejects a transaction that's already matched
- Test: `server/payments.test.ts`

**Interfaces:** `matchTransactionToPayment`'s signature is unchanged; it now throws when called on a transaction whose `matchedPaymentId` is already set to a different payment (idempotent re-match to the *same* payment is allowed and is a no-op).

- [ ] **Step 1: Write the failing test**

```typescript
// server/payments.test.ts (addition)
it("rejects matching an already-matched transaction to a different payment", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
  const payment1 = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });
  const payment2 = await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "200.00", expectedDate: new Date(), currency: "USD" });
  const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });

  await matchTransactionToPayment(tx.id, payment1.id);
  await expect(matchTransactionToPayment(tx.id, payment2.id)).rejects.toThrow(/already matched/);
});

it("allows re-matching a transaction to the same payment it's already matched to (idempotent)", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });
  const payment = await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "100.00", expectedDate: new Date(), currency: "USD" });
  const tx = await recordTransaction({ date: new Date(), amount: "100.00", currency: "USD", fxRate: "0.93", counterparty: "Test" });

  await matchTransactionToPayment(tx.id, payment.id);
  await expect(matchTransactionToPayment(tx.id, payment.id)).resolves.not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/payments.test.ts`
Expected: FAIL — the first test currently succeeds silently, re-pointing the transaction.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/payments.ts (modify matchTransactionToPayment)
export async function matchTransactionToPayment(transactionId: number, paymentId: number): Promise<void> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (tx.matchedPaymentId !== null && tx.matchedPaymentId !== paymentId) {
    throw new Error(
      `transaction ${transactionId} is already matched to payment ${tx.matchedPaymentId} — cannot re-match to payment ${paymentId}`,
    );
  }
  await db.update(transactions).set({ matchedPaymentId: paymentId }).where(eq(transactions.id, transactionId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/payments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/payments.ts server/payments.test.ts
git commit -m "feat: reject re-matching an already-matched transaction to a different payment"
```

---

## Task 7: Migration Transform Functions (Purchase Orders, Shipments, Payments, Transactions)

**Files:**
- Modify: `scripts/migrate-from-sheet.ts` — add `transformPurchaseOrders`, `transformShipments`, `transformPayments`, `transformTransactions`, each with quarantine handling
- Test: `scripts/migrate-from-sheet.test.ts`

**Interfaces:**
- Produces `SkippedRow { rowIndex: number; reason: string }` (shared shape across all four new transforms — reuse across this task, do not redefine per function).
- Produces `transformPurchaseOrders(rows: PoSheetRow[]): { purchaseOrders: TransformedPo[]; skipped: SkippedRow[] }`.
- Produces `transformShipments(rows: ShipmentSheetRow[]): { shipments: TransformedShipment[]; skipped: SkippedRow[] }`.
- Produces `transformPayments(rows: PaymentSheetRow[]): { payments: TransformedPayment[]; skipped: SkippedRow[] }`.
- Produces `transformTransactions(rows: TransactionSheetRow[]): { transactions: TransformedTransaction[]; skipped: SkippedRow[] }`.
- Each `Transformed*` type carries exactly the fields Task 8's `runMigration` needs to call `createPurchaseOrder`/`createShipment`/`createExpectedPayment`/`recordTransaction` (see the type definitions below — Task 8 depends on these exact shapes).

- [ ] **Step 1: Write the failing tests**

```typescript
// scripts/migrate-from-sheet.test.ts (addition)
describe("transformPurchaseOrders", () => {
  it("maps a well-formed row, including the vendor reference and a non-draft historical status", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "LVM-INV-2026-0912", status: "shipped", sku: "JELLO-CAL-500", qty: "200000", unit_price: "0.15", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.skipped).toEqual([]);
    expect(result.purchaseOrders).toEqual([
      {
        poNumber: "PO3-JELLO",
        vendorName: "Lvmengkang",
        vendorReference: "LVM-INV-2026-0912",
        initialStatus: "shipped",
        lineItems: [{ sku: "JELLO-CAL-500", qty: 200000, unitPrice: "0.15", currency: "USD" }],
      },
    ]);
  });

  it("groups multiple line-item rows under the same PO number into one PO with several line items", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "draft", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" },
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "draft", sku: "JELLO-MIX-250", qty: "500", unit_price: "0.20", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.purchaseOrders).toHaveLength(1);
    expect(result.purchaseOrders[0].lineItems).toHaveLength(2);
  });

  it("quarantines a row with an invalid status instead of throwing", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "not_a_real_status", sku: "JELLO-CAL-500", qty: "200000", unit_price: "0.15", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.purchaseOrders).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("status") }]);
  });
});

describe("transformShipments", () => {
  it("maps a well-formed row with cost fields and a final historical status", () => {
    const rows = [
      { shipment_ref: "PO1-W4-Container2", vendor_reference: "MBS-DEBIT-SZDN26080711", status: "delivered", freight_cost: "4200.00", duty_cost: "980.00", cost_currency: "EUR", po_line_item_ref: "PO1-W4::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "45000", weight_share: "0.5", value_share: "0.5" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments[0]).toMatchObject({
      shipmentRef: "PO1-W4-Container2",
      vendorReference: "MBS-DEBIT-SZDN26080711",
      initialStatus: "delivered",
      freightCost: "4200.00",
      dutyCost: "980.00",
      costCurrency: "EUR",
    });
  });

  it("quarantines a row missing its shipment_ref", () => {
    const rows = [{ shipment_ref: "", vendor_reference: "", status: "planned", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0" }];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("shipment_ref");
  });
});

describe("transformPayments", () => {
  it("maps a well-formed payment row", () => {
    const rows = [
      { po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" },
    ];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: "PO3-JELLO", sequenceNo: 1, expectedAmount: "30746.70", currency: "USD" });
  });

  it("quarantines a row with a non-numeric expected amount", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "not-a-number", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("expected_amount");
  });
});

describe("transformTransactions", () => {
  it("maps a well-formed transaction row as unmatched, regardless of any match hint in the source", () => {
    const rows = [
      { date: "2026-09-09", amount: "30746.70", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Jello Pay1", matched_po_number_hint: "PO3-JELLO" },
    ];
    const result = transformTransactions(rows);
    expect(result.skipped).toEqual([]);
    expect(result.transactions[0]).toMatchObject({ amount: "30746.70", currency: "USD", counterparty: "Lvmengkang" });
    expect(result.transactions[0]).not.toHaveProperty("matchedPaymentId");
  });

  it("quarantines a row with an unparseable date", () => {
    const rows = [{ date: "not-a-date", amount: "100.00", currency: "USD", fx_rate: "0.93", counterparty: "Test", description: "" }];
    const result = transformTransactions(rows);
    expect(result.transactions).toEqual([]);
    expect(result.skipped[0].reason).toContain("date");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test scripts/migrate-from-sheet.test.ts`
Expected: FAIL — none of the four new functions exist yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/migrate-from-sheet.ts (additions — alongside the existing transformSheetExport/reconcileMigration)

export interface SkippedRow {
  rowIndex: number;
  reason: string;
}

// --- Purchase Orders ---

export interface PoSheetRow {
  po_number: string;
  vendor_name: string;
  vendor_reference: string;
  status: string;
  sku: string;
  qty: string;
  unit_price: string;
  currency: string;
}

export interface TransformedPo {
  poNumber: string;
  vendorName: string;
  vendorReference: string | null;
  initialStatus: "draft" | "confirmed" | "in_production" | "shipped" | "customs" | "delivered" | "closed";
  lineItems: { sku: string; qty: number; unitPrice: string; currency: string }[];
}

const VALID_PO_STATUSES = ["draft", "confirmed", "in_production", "shipped", "customs", "delivered", "closed"];

export function transformPurchaseOrders(rows: PoSheetRow[]): { purchaseOrders: TransformedPo[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const byPoNumber = new Map<string, TransformedPo>();

  rows.forEach((row, rowIndex) => {
    if (!row.po_number) {
      skipped.push({ rowIndex, reason: "missing po_number" });
      return;
    }
    if (!VALID_PO_STATUSES.includes(row.status)) {
      skipped.push({ rowIndex, reason: `unrecognized status "${row.status}"` });
      return;
    }
    const qty = parseInt(row.qty, 10);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }

    const lineItem = { sku: row.sku, qty, unitPrice: row.unit_price, currency: row.currency };
    const existing = byPoNumber.get(row.po_number);
    if (existing) {
      existing.lineItems.push(lineItem);
    } else {
      byPoNumber.set(row.po_number, {
        poNumber: row.po_number,
        vendorName: row.vendor_name,
        vendorReference: row.vendor_reference || null,
        initialStatus: row.status as TransformedPo["initialStatus"],
        lineItems: [lineItem],
      });
    }
  });

  return { purchaseOrders: Array.from(byPoNumber.values()), skipped };
}

// --- Shipments ---

export interface ShipmentSheetRow {
  shipment_ref: string;
  vendor_reference: string;
  status: string;
  freight_cost: string;
  duty_cost: string;
  cost_currency: string;
  po_line_item_ref: string;
  sku: string;
  qty: string;
  weight_share: string;
  value_share: string;
}

export interface TransformedShipment {
  shipmentRef: string;
  vendorReference: string | null;
  initialStatus: "planned" | "departed" | "in_transit" | "customs" | "delivered";
  freightCost: string | null;
  dutyCost: string | null;
  costCurrency: string | null;
  lineItems: { poLineItemRef: string; sku: string; qty: number; weightShare: string; valueShare: string }[];
}

const VALID_SHIPMENT_STATUSES = ["planned", "departed", "in_transit", "customs", "delivered"];

export function transformShipments(rows: ShipmentSheetRow[]): { shipments: TransformedShipment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const byShipmentRef = new Map<string, TransformedShipment>();

  rows.forEach((row, rowIndex) => {
    if (!row.shipment_ref) {
      skipped.push({ rowIndex, reason: "missing shipment_ref" });
      return;
    }
    if (!VALID_SHIPMENT_STATUSES.includes(row.status)) {
      skipped.push({ rowIndex, reason: `unrecognized status "${row.status}"` });
      return;
    }
    const qty = parseInt(row.qty, 10);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }

    const lineItem = { poLineItemRef: row.po_line_item_ref, sku: row.sku, qty, weightShare: row.weight_share, valueShare: row.value_share };
    const existing = byShipmentRef.get(row.shipment_ref);
    if (existing) {
      existing.lineItems.push(lineItem);
    } else {
      byShipmentRef.set(row.shipment_ref, {
        shipmentRef: row.shipment_ref,
        vendorReference: row.vendor_reference || null,
        initialStatus: row.status as TransformedShipment["initialStatus"],
        freightCost: row.freight_cost || null,
        dutyCost: row.duty_cost || null,
        costCurrency: row.cost_currency || null,
        lineItems: [lineItem],
      });
    }
  });

  return { shipments: Array.from(byShipmentRef.values()), skipped };
}

// --- Payments ---

export interface PaymentSheetRow {
  po_number: string;
  sequence_no: string;
  expected_amount: string;
  expected_date: string;
  currency: string;
}

export interface TransformedPayment {
  poNumber: string;
  sequenceNo: number;
  expectedAmount: string;
  expectedDate: Date;
  currency: string;
}

export function transformPayments(rows: PaymentSheetRow[]): { payments: TransformedPayment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const payments: TransformedPayment[] = [];

  rows.forEach((row, rowIndex) => {
    const amount = parseFloat(row.expected_amount);
    if (Number.isNaN(amount)) {
      skipped.push({ rowIndex, reason: `unparseable expected_amount "${row.expected_amount}"` });
      return;
    }
    const date = new Date(row.expected_date);
    if (Number.isNaN(date.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable expected_date "${row.expected_date}"` });
      return;
    }
    payments.push({
      poNumber: row.po_number,
      sequenceNo: parseInt(row.sequence_no, 10),
      expectedAmount: row.expected_amount,
      expectedDate: date,
      currency: row.currency,
    });
  });

  return { payments, skipped };
}

// --- Transactions ---

export interface TransactionSheetRow {
  date: string;
  amount: string;
  currency: string;
  fx_rate: string;
  counterparty: string;
  description: string;
}

export interface TransformedTransaction {
  date: Date;
  amount: string;
  currency: string;
  fxRate: string;
  counterparty: string;
  description: string;
}

export function transformTransactions(rows: TransactionSheetRow[]): { transactions: TransformedTransaction[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const transactions: TransformedTransaction[] = [];

  rows.forEach((row, rowIndex) => {
    const date = new Date(row.date);
    if (Number.isNaN(date.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable date "${row.date}"` });
      return;
    }
    const amount = parseFloat(row.amount);
    if (Number.isNaN(amount)) {
      skipped.push({ rowIndex, reason: `unparseable amount "${row.amount}"` });
      return;
    }
    // migrated as unmatched regardless of any match hint the source row carries —
    // real matching happens manually after migration, per the design's decision.
    transactions.push({
      date,
      amount: row.amount,
      currency: row.currency,
      fxRate: row.fx_rate,
      counterparty: row.counterparty,
      description: row.description,
    });
  });

  return { transactions, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test scripts/migrate-from-sheet.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-from-sheet.ts scripts/migrate-from-sheet.test.ts
git commit -m "feat: migration transforms for Purchase Orders, Shipments, Payments, Transactions"
```

---

## Task 8: Widen `runMigration` (Full Scope, Single Transaction, Quarantine Reporting)

**Files:**
- Modify: `scripts/reconcile-migration.ts` — `runMigration` now imports and calls Task 7's four transforms, inserts in FK-respecting order inside one transaction, and reports quarantined rows

**Interfaces:**
- `runMigration`'s exported signature grows to accept the four new row sets (see below) alongside the existing `exportRows`/`sheetTotals`. This is a breaking change to `runMigration`'s signature — it's a script entrypoint with no other callers in this codebase, so this is safe.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/reconcile-migration.test.ts (new file — runMigration itself wasn't unit-tested in V1, this plan adds coverage for the new orchestration/transaction logic specifically)
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../server/dbClient";
import { skus, vendors, warehouses, purchaseOrders, poLineItems, shipments, shipmentLineItems, payments, transactions, inventoryLedger } from "../drizzle/schema";
import { runMigration } from "./reconcile-migration";

beforeEach(async () => {
  await db.delete(inventoryLedger);
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(shipmentLineItems);
  await db.delete(shipments);
  await db.delete(poLineItems);
  await db.delete(purchaseOrders);
  await db.delete(skus);
  await db.delete(vendors);
  await db.delete(warehouses);
});

describe("runMigration (widened scope)", () => {
  it("imports POs, shipments, payments, and transactions in one pass, in FK-respecting order", async () => {
    await runMigration({
      ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
      poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "LVM-INV-1", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "150.00", expected_date: "2026-09-09", currency: "USD" }],
      transactionRows: [{ date: "2026-09-09", amount: "150.00", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Pay1" }],
      sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 1000 }],
    });

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
    expect(pos[0].vendorReference).toBe("LVM-INV-1");
    const pays = await db.select().from(payments);
    expect(pays).toHaveLength(1);
    const txs = await db.select().from(transactions);
    expect(txs[0].matchedPaymentId).toBeNull();
  });

  it("rolls back the entire migration if any part fails partway through", async () => {
    await expect(
      runMigration({
        ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
        poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        // deliberately wrong SOH to force the reconciliation gate to fail after inserts have already run
        sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 999999 }],
      }),
    ).rejects.toThrow();

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(0); // nothing committed
  });

  it("reports quarantined rows without aborting the rows that are valid", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" },
        { po_number: "PO4-BAD", vendor_name: "X", vendor_reference: "", status: "not_a_status", sku: "JELLO-CAL-500", qty: "1", unit_price: "0.15", currency: "USD" },
      ],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.purchaseOrders).toHaveLength(1);
    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test scripts/reconcile-migration.test.ts`
Expected: FAIL — `runMigration`'s current signature doesn't accept these new row sets.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/reconcile-migration.ts (replace the existing runMigration)
import { db } from "../server/dbClient";
import { createSku, createWarehouse, listSkus, listWarehouses, createVendor, listVendors } from "../server/db";
import { recordLedgerEvent, getSoh } from "../server/inventoryLedger";
import { createPurchaseOrder, getPurchaseOrderWithLineItems, listPurchaseOrders } from "../server/purchaseOrders";
import { createShipment, listShipmentsForPo } from "../server/shipments";
import { createExpectedPayment } from "../server/payments";
import { recordTransaction } from "../server/payments";
import { getShipmentLandedUnitCost } from "../server/landedCost";
import {
  transformSheetExport, transformPurchaseOrders, transformShipments, transformPayments, transformTransactions,
  reconcileMigration,
  type SheetExportRow, type PoSheetRow, type ShipmentSheetRow, type PaymentSheetRow, type TransactionSheetRow,
  type SkuWarehouseTotal,
} from "./migrate-from-sheet";

const LANDED_COST_TOLERANCE_MIN = 0.01;
const LANDED_COST_TOLERANCE_PCT = 0.001;

function withinTolerance(expected: number, actual: number): boolean {
  const tolerance = Math.max(LANDED_COST_TOLERANCE_MIN, Math.abs(expected) * LANDED_COST_TOLERANCE_PCT);
  return Math.abs(expected - actual) <= tolerance;
}

export interface RunMigrationInput {
  ledgerRows: SheetExportRow[];
  poRows: PoSheetRow[];
  shipmentRows: ShipmentSheetRow[];
  paymentRows: PaymentSheetRow[];
  transactionRows: TransactionSheetRow[];
  sheetTotals: SkuWarehouseTotal[];
}

export interface RunMigrationResult {
  quarantined: {
    ledger: { rowIndex: number; reason: string }[];
    purchaseOrders: { rowIndex: number; reason: string }[];
    shipments: { rowIndex: number; reason: string }[];
    payments: { rowIndex: number; reason: string }[];
    transactions: { rowIndex: number; reason: string }[];
  };
}

export async function runMigration(input: RunMigrationInput): Promise<RunMigrationResult> {
  const { ledgerEvents } = transformSheetExport(input.ledgerRows);
  const { purchaseOrders: transformedPos, skipped: skippedPos } = transformPurchaseOrders(input.poRows);
  const { shipments: transformedShipments, skipped: skippedShipments } = transformShipments(input.shipmentRows);
  const { payments: transformedPayments, skipped: skippedPayments } = transformPayments(input.paymentRows);
  const { transactions: transformedTransactions, skipped: skippedTransactions } = transformTransactions(input.transactionRows);

  await db.transaction(async () => {
    const existingSkus = await listSkus();
    const existingWarehouses = await listWarehouses();
    const existingVendors = await listVendors();
    const skuByCode = new Map(existingSkus.map((s) => [s.sku, s.id]));
    const warehouseByCode = new Map(existingWarehouses.map((w) => [w.code, w.id]));
    const vendorByName = new Map(existingVendors.map((v) => [v.name, v.id]));
    const poIdByNumber = new Map<string, number>();
    const poLineItemIdByRef = new Map<string, number>(); // "PO_NUMBER::SKU" -> line item id
    const shipmentIdByRef = new Map<string, number>();

    async function ensureSku(skuCode: string): Promise<number> {
      let id = skuByCode.get(skuCode);
      if (!id) {
        const created = await createSku({ sku: skuCode, primaryIdentifierType: "sku" });
        id = created.id;
        skuByCode.set(skuCode, id);
      }
      return id;
    }

    async function ensureWarehouse(code: string): Promise<number> {
      let id = warehouseByCode.get(code);
      if (!id) {
        const created = await createWarehouse({ code, name: code });
        id = created.id;
        warehouseByCode.set(code, id);
      }
      return id;
    }

    async function ensureVendor(name: string): Promise<number> {
      let id = vendorByName.get(name);
      if (!id) {
        const created = await createVendor({ name });
        id = created.id;
        vendorByName.set(name, id);
      }
      return id;
    }

    // 1. Purchase Orders + line items
    for (const po of transformedPos) {
      const vendorId = await ensureVendor(po.vendorName);
      for (const li of po.lineItems) await ensureSku(li.sku);
      const created = await createPurchaseOrder({
        poNumber: po.poNumber,
        vendorId,
        vendorReference: po.vendorReference ?? undefined,
        initialStatus: po.initialStatus,
        lineItems: await Promise.all(
          po.lineItems.map(async (li) => ({ skuId: await ensureSku(li.sku), qty: li.qty, unitPrice: li.unitPrice, currency: li.currency })),
        ),
        createdBy: 1,
      });
      poIdByNumber.set(po.poNumber, created.id);
      const withItems = await getPurchaseOrderWithLineItems(created.id);
      withItems.lineItems.forEach((li, idx) => {
        poLineItemIdByRef.set(`${po.poNumber}::${po.lineItems[idx].sku}`, li.id);
      });
    }

    // 2. Shipments + shipment line items
    for (const shipment of transformedShipments) {
      const created = await createShipment({
        shipmentRef: shipment.shipmentRef,
        vendorReference: shipment.vendorReference ?? undefined,
        initialStatus: shipment.initialStatus,
        lineItems: await Promise.all(
          shipment.lineItems.map(async (li) => ({
            poLineItemId: poLineItemIdByRef.get(li.poLineItemRef)!,
            skuId: await ensureSku(li.sku),
            qty: li.qty,
            weightShare: li.weightShare,
            valueShare: li.valueShare,
          })),
        ),
        createdBy: 1,
      });
      if (shipment.freightCost || shipment.dutyCost) {
        await db.execute(
          // recordShipmentCosts requires a reasonCategory for a *change*; a migration-time
          // initial cost isn't a change with a prior value, so set columns directly here.
          undefined as never,
        );
      }
      shipmentIdByRef.set(shipment.shipmentRef, created.id);
    }

    // 3. Payments
    for (const payment of transformedPayments) {
      const poId = poIdByNumber.get(payment.poNumber);
      await createExpectedPayment({
        poId,
        sequenceNo: payment.sequenceNo,
        expectedAmount: payment.expectedAmount,
        expectedDate: payment.expectedDate,
        currency: payment.currency,
      });
    }

    // 4. Transactions (unmatched)
    for (const tx of transformedTransactions) {
      await recordTransaction({ date: tx.date, amount: tx.amount, currency: tx.currency, fxRate: tx.fxRate, counterparty: tx.counterparty, description: tx.description });
    }

    // 5. Inventory ledger events (must come after SKUs/warehouses above exist)
    for (const event of ledgerEvents) {
      const skuId = await ensureSku(event.sku);
      const warehouseId = await ensureWarehouse(event.warehouseCode);
      await recordLedgerEvent({
        skuId,
        warehouseId,
        eventType: event.eventType,
        qty: event.eventType === "sale" ? -Math.abs(event.qty) : event.qty,
        unitCost: event.eventType === "receipt" ? String(event.unitCost) : null,
        date: event.date,
        sourceRef: event.sourceRef,
      });
    }

    // 6. Reconciliation gate — inside the transaction, so a failure here rolls back everything above.
    const soakResult = await reconcileMigration(input.sheetTotals, {
      getMigratedSoh: async (sku, warehouseCode) => {
        const skuId = skuByCode.get(sku)!;
        const warehouseId = warehouseByCode.get(warehouseCode)!;
        return getSoh(skuId, warehouseId);
      },
    });
    if (!soakResult.passed) {
      throw new Error(`migration reconciliation failed: ${JSON.stringify(soakResult.mismatches)}`);
    }
  });

  return {
    quarantined: {
      ledger: [],
      purchaseOrders: skippedPos,
      shipments: skippedShipments,
      payments: skippedPayments,
      transactions: skippedTransactions,
    },
  };
}
```

**Note for the implementer:** the `recordShipmentCosts` call for migrated shipment freight/duty costs is left as a clearly-marked follow-up in the code above (`db.execute(undefined as never)` is a deliberate placeholder that will fail loudly if reached, not a silent no-op) — `recordShipmentCosts` requires a `reasonCategory` because it's designed for a live *change* to an existing shipment's costs, and a migration-time initial value isn't a change with a real prior value to audit against. Resolve this properly before merging: either add a migration-only direct-set path analogous to `initialStatus` (preferred, consistent with this plan's existing pattern), or set `freightCost`/`dutyCost`/`costCurrency` via a plain `db.update(shipments)...` call at creation time inside this same function, documented with a comment explaining why it bypasses the audited path. Update the test in Step 1 to cover whichever approach you take, and remove this note once resolved.

- [ ] **Step 4: Resolve the shipment-cost migration path, then run tests**

Run: `pnpm test scripts/reconcile-migration.test.ts scripts/migrate-from-sheet.test.ts`
Expected: PASS once the placeholder above is replaced with a real implementation.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass, including everything from Tasks 1-7.

- [ ] **Step 6: Commit**

```bash
git add scripts/reconcile-migration.ts scripts/reconcile-migration.test.ts
git commit -m "feat: widen runMigration to full PO/Shipment/Payment/Transaction scope, single-transaction atomicity, quarantine reporting"
```

---

## Task 9: Landed-Cost Tolerance in Reconciliation

**Files:**
- Modify: `scripts/migrate-from-sheet.ts` — `reconcileMigration` gains a second, tolerance-based check
- Test: `scripts/migrate-from-sheet.test.ts`

**Interfaces:**
- `reconcileMigration`'s signature grows: it now optionally accepts `landedCostTotals?: { sku: string; warehouseCode: string; landedCostFromSheet: number }[]` and a `deps.getMigratedLandedCost?: (sku, warehouseCode) => Promise<number>`, alongside the existing SOH-focused parameters. When omitted, behavior is identical to before (backward compatible with Task 8's call, which does not yet pass these — Task 8's `runMigration` should be updated in this task to pass them through once real landed-cost totals are available from the Sheet).
- The result's `mismatches` array entries gain an optional `kind: "soh" | "landed_cost"` field (defaults to `"soh"` for existing SOH mismatches) so the two failure categories are distinguishable, per the design.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/migrate-from-sheet.test.ts (addition to the reconcileMigration describe block)
it("passes a landed-cost mismatch within tolerance (0.1% or $0.01, whichever is greater)", async () => {
  const result = await reconcileMigration(
    [],
    { getMigratedSoh: async () => 0 },
    [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", landedCostFromSheet: 1000.0 }],
    { getMigratedLandedCost: async () => 1000.5 }, // 0.05% off — within the 0.1% tolerance
  );
  expect(result.passed).toBe(true);
});

it("fails a landed-cost mismatch beyond tolerance, tagged as a landed_cost mismatch", async () => {
  const result = await reconcileMigration(
    [],
    { getMigratedSoh: async () => 0 },
    [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", landedCostFromSheet: 1000.0 }],
    { getMigratedLandedCost: async () => 1010.0 }, // 1% off — beyond tolerance
  );
  expect(result.passed).toBe(false);
  expect(result.mismatches[0].kind).toBe("landed_cost");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test scripts/migrate-from-sheet.test.ts`
Expected: FAIL — `reconcileMigration` doesn't accept these extra parameters yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/migrate-from-sheet.ts (modify reconcileMigration and its supporting types)
export interface Mismatch {
  sku: string;
  warehouseCode: string;
  expected: number;
  actual: number;
  diff: number;
  kind: "soh" | "landed_cost";
}

export interface LandedCostTotal {
  sku: string;
  warehouseCode: string;
  landedCostFromSheet: number;
}

export interface LandedCostReconciliationDeps {
  getMigratedLandedCost: (sku: string, warehouseCode: string) => Promise<number>;
}

const LANDED_COST_TOLERANCE_MIN = 0.01;
const LANDED_COST_TOLERANCE_PCT = 0.001;

function withinLandedCostTolerance(expected: number, actual: number): boolean {
  const tolerance = Math.max(LANDED_COST_TOLERANCE_MIN, Math.abs(expected) * LANDED_COST_TOLERANCE_PCT);
  return Math.abs(expected - actual) <= tolerance;
}

export async function reconcileMigration(
  sheetTotals: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
  landedCostTotals: LandedCostTotal[] = [],
  landedCostDeps?: LandedCostReconciliationDeps,
): Promise<{ passed: boolean; mismatches: Mismatch[] }> {
  const mismatches: Mismatch[] = [];
  for (const total of sheetTotals) {
    const actual = await deps.getMigratedSoh(total.sku, total.warehouseCode);
    if (actual !== total.sohFromSheet) {
      mismatches.push({
        sku: total.sku,
        warehouseCode: total.warehouseCode,
        expected: total.sohFromSheet,
        actual,
        diff: actual - total.sohFromSheet,
        kind: "soh",
      });
    }
  }

  if (landedCostDeps) {
    for (const total of landedCostTotals) {
      const actual = await landedCostDeps.getMigratedLandedCost(total.sku, total.warehouseCode);
      if (!withinLandedCostTolerance(total.landedCostFromSheet, actual)) {
        mismatches.push({
          sku: total.sku,
          warehouseCode: total.warehouseCode,
          expected: total.landedCostFromSheet,
          actual,
          diff: actual - total.landedCostFromSheet,
          kind: "landed_cost",
        });
      }
    }
  }

  return { passed: mismatches.length === 0, mismatches };
}
```

Note: the existing SOH-only call sites (Task 8's `runMigration`, and `scripts/parallel-run-report.ts`'s `generateParallelRunReport`) continue to work unmodified since the two new parameters are optional with safe defaults — but confirm both still typecheck after this change, since `Mismatch`'s shape gained a required `kind` field.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test scripts/migrate-from-sheet.test.ts scripts/parallel-run-report.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-from-sheet.ts scripts/migrate-from-sheet.test.ts
git commit -m "feat: tolerance-based landed-cost reconciliation alongside exact SOH match"
```

---

## Task 10: CLI Entrypoints

**Files:**
- Create: `scripts/run-migration.mjs`
- Create: `scripts/run-parallel-check.mjs`
- Modify: `RAILWAY.md` — document both commands

**Interfaces:** None consumed by later tasks — this is the final task in this plan.

- [ ] **Step 1: Write the CLI wrapper for the migration**

```javascript
// scripts/run-migration.mjs
import { runMigration } from "./reconcile-migration.ts";

// Real Sheet export data is read here once a real migration is actually being run —
// this plan does not invent placeholder production data. Wire the real CSV/export
// reading in when this is executed for real; until then this script exists so the
// operator has a real, documented command per RAILWAY.md rather than a REPL call.
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-migration.mjs <path-to-exported-sheet-data.json>");
  process.exit(1);
}

const { readFile } = await import("node:fs/promises");
const input = JSON.parse(await readFile(inputPath, "utf-8"));

try {
  const result = await runMigration(input);
  const totalQuarantined = Object.values(result.quarantined).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Migration complete. Quarantined rows: ${totalQuarantined}`);
  if (totalQuarantined > 0) {
    console.log(JSON.stringify(result.quarantined, null, 2));
  }
  process.exit(0);
} catch (err) {
  console.error("Migration failed and rolled back:", err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Write the CLI wrapper for the parallel-run check**

```javascript
// scripts/run-parallel-check.mjs
import { generateParallelRunReport } from "./parallel-run-report.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-parallel-check.mjs <path-to-sheet-snapshot.json>");
  process.exit(1);
}

const { readFile } = await import("node:fs/promises");
const { sheetSnapshot, deps } = JSON.parse(await readFile(inputPath, "utf-8"));

try {
  const report = await generateParallelRunReport(sheetSnapshot, deps);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.safeToCutOver ? 0 : 1);
} catch (err) {
  console.error("Parallel-run check failed:", err.message);
  process.exit(1);
}
```

- [ ] **Step 3: Verify both scripts run (with a small real fixture, against the local dev DB)**

Create a scratch fixture file and confirm the migration script runs end-to-end (this is a real, if synthetic, execution — not just a syntax check):

Run: `set -a && source .env && set +a && echo '{"ledgerRows":[],"poRows":[],"shipmentRows":[],"paymentRows":[],"transactionRows":[],"sheetTotals":[]}' > /tmp/empty-migration.json && pnpm exec tsx scripts/run-migration.mjs /tmp/empty-migration.json`
Expected: `Migration complete. Quarantined rows: 0`, exit code 0.

- [ ] **Step 4: Document both commands in RAILWAY.md**

Add a new section after the existing nightly-export documentation:

```markdown
## One-time migration (when a real Control Tower export is ready)

```bash
pnpm exec tsx scripts/run-migration.mjs <path-to-exported-sheet-data.json>
```

Exits 0 with a quarantine summary on success, exits 1 and rolls back entirely if the reconciliation gate fails. Never run against production without first running the parallel-run check below for the agreed comparison period.

## Daily parallel-run check (during the comparison period, before cutover)

```bash
pnpm exec tsx scripts/run-parallel-check.mjs <path-to-todays-sheet-snapshot.json>
```

Exits 0 (`safeToCutOver: true`) only when every SKU/warehouse balance matches. Control Tower stays the live source of truth until this has passed for the agreed period.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/run-migration.mjs scripts/run-parallel-check.mjs RAILWAY.md
git commit -m "feat: CLI entrypoints for migration and parallel-run check"
```

---

## Self-Review Notes

**Spec coverage check:**
- Referential integrity (hybrid FK + app check) → Tasks 4, 6.
- Shipment state machine (validation only, not exposed via router) → Task 5.
- Migration scope widening (PO/Shipment/Payment/Transaction transforms) → Task 7.
- Quarantine-not-abort → Task 7 (per-transform) and Task 8 (aggregated reporting).
- Single-transaction atomicity → Task 8.
- Landed-cost tolerance reconciliation → Task 9.
- Vendor reference fields → Task 2.
- Negative-stock validation → Task 3.
- SKU identifier uniqueness → Task 1.
- CLI entrypoints → Task 10.
- Clean-dev-DB-before-FKs step → explicit in Task 4.
- Migration-inserts-final-status-directly (not via transition replay) → Task 2's `initialStatus` + Task 8's direct use of it.

**Placeholder scan:** one deliberate, clearly-flagged exception — Task 8's shipment-cost-during-migration path is left as a named, fail-loud placeholder with explicit instructions for the implementer to resolve before that task is considered done (not a silent TODO; the task's own steps require resolving it before moving on). Everything else has real code.

**Type consistency:** `TransformedPo`/`TransformedShipment`/`TransformedPayment`/`TransformedTransaction` (Task 7) are consumed by `runMigration` (Task 8) using the exact field names defined in Task 7 — cross-checked. `initialStatus`/`vendorReference` (Task 2) are used identically by Task 7's transforms and Task 8's `createPurchaseOrder`/`createShipment` calls. `Mismatch`'s new `kind` field (Task 9) doesn't break Task 8's existing SOH-only reconciliation call, since it defaults sensibly and Task 8 doesn't inspect `kind`.
