# Systemic Correctness Hardening (Backlog Stream E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three correctness risks the V1 review flagged as "not urgent until real data flows" — a non-idempotent daily sales import, timezone-dependent calendar-day handling across four columns, and an unenforced currency assumption in landed-cost math — before any real client data reaches this system.

**Architecture:** Three calendar-day-only columns (`sales_actuals.date`, `sales_plan.periodDate`, `purchase_orders.plannedReadyDate`) move from Drizzle's `timestamp` type to `date` (string) mode, eliminating timezone-conversion drift at the type level rather than mitigating it at the connection level. `inventory_ledger.date` is deliberately excluded from this — it stays `timestamp(3)` (a Stream B fix for same-day event ordering) and instead the MySQL connection pool gets a pinned UTC session timezone, closing the same class of risk for that column without touching its precision. The daily Shopify pull becomes idempotent via a unique constraint plus quarantine-on-duplicate handling, matching this codebase's existing migration-quarantine convention. The landed-cost currency guard is a pure, independent addition.

**Tech Stack:** TypeScript, Express + tRPC v11, Drizzle ORM (MySQL dialect), React, Vitest, `mysql2` — same stack as the rest of this repo, no new dependencies.

**Spec:** `/Users/artem/Claude v 1.0/accommerce-inventory/docs/2026-09-19-systemic-correctness-hardening-design.md`

## Global Constraints

- `inventory_ledger.date` is NOT touched by this plan at all — no type change, no precision change. Only `sales_actuals.date`, `sales_plan.periodDate`, and `purchase_orders.plannedReadyDate` convert to `date` (string) mode.
- Every function whose TypeScript signature currently takes a `Date` for one of the three converted columns changes to take a `string` (format `"YYYY-MM-DD"`) instead — no function should silently truncate a `Date` internally, since that hides exactly the kind of timezone assumption this plan closes.
- Every tRPC router procedure's wire input for these three fields stays `z.date()` — the client still sends a real `Date` object from an `<input type="date">` picker — and the ROUTER HANDLER converts it to the `"YYYY-MM-DD"` string once, at the boundary, via `date.toISOString().slice(0, 10)` (the same conversion this codebase already uses pervasively when reading a stored `Date` back as a calendar day — this plan just moves the call site to the write boundary instead of the read boundary).
- Schema changes require a clean local dev DB before `pnpm db:push` and independent verification via `SHOW CREATE TABLE` afterward, not just trusting `db:push`'s exit code — this repo has a documented history (Stream B) of `db:push` silently producing a subtly wrong result.
- The daily Shopify pull's duplicate handling follows this codebase's quarantine-not-abort convention (report a skipped/duplicate row with a reason, never throw and abort the whole batch, matching Stream B's migration transforms).
- A local dev database is running (`DATABASE_URL=mysql://root:devpassword@localhost:3306/accommerce_dev`; source `.env` with `set -a && source .env && set +a` before any direct `pnpm`/`node` command). Run the suite with `pnpm test`.

---

## File Structure

```
accommerce-inventory/
  server/
    landedCost.ts               # MODIFY: currency guard in getShipmentLandedUnitCost
    landedCost.test.ts            # MODIFY: add its tests
    dbClient.ts                   # MODIFY: pin timezone: "Z" on the pool
    purchaseOrders.ts              # MODIFY: plannedReadyDate Date -> string
    purchaseOrders.test.ts          # MODIFY: update existing test's date construction
    salesPlan.ts                     # MODIFY: periodDate/date Date -> string across 3 functions
    salesPlan.test.ts                 # MODIFY: update existing tests' date construction
    dashboards.ts                      # MODIFY: getAverageDailySales's windowStart -> string
    dashboards.test.ts                  # MODIFY: confirm no regression (likely no test changes needed)
    shopifyDailyPull.ts                  # MODIFY: idempotency check in runDailyShopifyPull
    shopifyDailyPull.test.ts              # MODIFY: add idempotency test
    routers.ts                             # MODIFY: convert z.date() to string at 3 procedure boundaries
  client/src/pages/
    PurchaseOrdersPage.tsx                  # MODIFY: toDateInputValue accepts string | Date
  scripts/
    run-daily-shopify-pull.mjs                # CREATE: CLI entrypoint
```

---

## Task 1: Landed-Cost Currency Guard

**Files:**
- Modify: `server/landedCost.ts`
- Modify: `server/landedCost.test.ts`

**Interfaces:** No signature change to `getShipmentLandedUnitCost` — it now throws in a case it previously silently miscalculated.

- [ ] **Step 1: Write the failing test**

```typescript
// server/landedCost.test.ts (addition to the existing describe block — check the file's existing seed helpers and reuse them rather than duplicating; the shape below assumes a helper equivalent to seeding a PO line item with a chosen currency and a shipment with a chosen costCurrency exists or is easy to construct inline, matching this file's existing test style)
it("rejects computing landed cost when the PO line's currency doesn't match the shipment's cost currency", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const po = await createPurchaseOrder({
    poNumber: "PO1-W4",
    vendorId: vendor.id,
    lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
    createdBy: 1,
  });
  const withItems = await getPurchaseOrderWithLineItems(po.id);
  const shipment = await createShipment({
    shipmentRef: "PO1-W4-Container1",
    lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
    createdBy: 1,
  });
  await recordShipmentCosts(
    shipment.id,
    { freightCost: "100.00", dutyCost: "20.00", costCurrency: "EUR" },
    { reasonCategory: "freight_rate_change", changedBy: 1 },
  );

  await expect(getShipmentLandedUnitCost(shipment.id)).rejects.toThrow(/currency/i);
});

it("still computes landed cost correctly when currencies match (no regression)", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const po = await createPurchaseOrder({
    poNumber: "PO1-W4",
    vendorId: vendor.id,
    lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
    createdBy: 1,
  });
  const withItems = await getPurchaseOrderWithLineItems(po.id);
  const shipment = await createShipment({
    shipmentRef: "PO1-W4-Container1",
    lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
    createdBy: 1,
  });
  await recordShipmentCosts(
    shipment.id,
    { freightCost: "100.00", dutyCost: "20.00", costCurrency: "USD" },
    { reasonCategory: "freight_rate_change", changedBy: 1 },
  );

  const results = await getShipmentLandedUnitCost(shipment.id);
  expect(results[0].landedUnitCost).toBeCloseTo(0.15 + 100 * 1.0 / 1000 + 20 * 1.0 / 1000);
});
```

Check `server/landedCost.test.ts`'s existing imports — you will likely need to add `createPurchaseOrder`, `getPurchaseOrderWithLineItems`, `createShipment`, `recordShipmentCosts`, `createVendor`, `createSku` to the existing import lines if any are missing (this file may already import some of these for its existing tests — check before adding to avoid duplicate imports).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/landedCost.test.ts`
Expected: the first test FAILs (no currency check exists yet, so no throw occurs).

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/landedCost.ts — modify getShipmentLandedUnitCost's loop body
export async function getShipmentLandedUnitCost(
  shipmentId: number,
): Promise<{ skuId: number; landedUnitCost: number }[]> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
  const lines = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipmentId));

  const freightCost = parseFloat(shipment.freightCost ?? "0");
  const dutyCost = parseFloat(shipment.dutyCost ?? "0");

  const results = [];
  for (const line of lines) {
    if (line.qty <= 0) {
      throw new Error(`shipment line item ${line.id} has invalid qty ${line.qty}, cannot compute landed unit cost`);
    }
    const [poLine] = await db.select().from(poLineItems).where(eq(poLineItems.id, line.poLineItemId));
    if (poLine.currency !== shipment.costCurrency) {
      throw new Error(
        `getShipmentLandedUnitCost: currency mismatch on shipment ${shipmentId}, line item ${line.id} — ` +
        `PO line currency is "${poLine.currency}" but shipment cost currency is "${shipment.costCurrency}"; ` +
        `landed cost cannot be computed across mismatched currencies`,
      );
    }
    const exwTotal = parseFloat(poLine.unitPrice) * line.qty;
    const allocatedFreight = freightCost * parseFloat(line.weightShare);
    const allocatedDuty = dutyCost * parseFloat(line.valueShare);
    const landedUnitCost = (exwTotal + allocatedFreight + allocatedDuty) / line.qty;
    results.push({ skuId: line.skuId, landedUnitCost });
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/landedCost.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass — this guard only fires on a genuine mismatch, and no existing test constructs one.

- [ ] **Step 6: Commit**

```bash
git add server/landedCost.ts server/landedCost.test.ts
git commit -m "feat: reject landed-cost computation across mismatched PO/shipment currencies"
```

---

## Task 2: Pin UTC Timezone on the MySQL Connection Pool

**Files:**
- Modify: `server/dbClient.ts`
- Modify: `server/inventoryLedger.test.ts` (add a timezone round-trip test)

**Interfaces:** No exported signature changes — this is a connection-configuration change only.

- [ ] **Step 1: Write the failing test**

```typescript
// server/inventoryLedger.test.ts (addition to the existing describe block)
it("stores and reads back inventory_ledger timestamps in UTC regardless of the test runner's local timezone", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  const eventDate = new Date("2026-09-19T23:30:00.000Z"); // 23:30 UTC — close to a local-timezone day boundary in most timezones

  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: eventDate, sourceRef: "PO1" });

  const [row] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, sku.id));
  expect(row.date.toISOString()).toBe(eventDate.toISOString());
});
```

Check `server/inventoryLedger.test.ts`'s existing imports for `db`, `inventoryLedger`, `eq` — add any missing ones to the existing import lines.

- [ ] **Step 2: Run test to verify it fails or passes for the wrong reason**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: this specific test may already PASS if the local MySQL server's own configured timezone happens to be UTC (common on a fresh Homebrew/Docker install) — that's fine, the point of this task is to make the behavior deterministic and explicit rather than dependent on the server's configuration, not necessarily to fix an currently-observable failure in this sandbox. Proceed to Step 3 regardless of this test's initial result, and note in your report whether it initially passed or failed.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/dbClient.ts — replace the whole file with this content
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";
import * as schema from "../drizzle/schema";

// Pinned to UTC regardless of the MySQL server's own configured session
// timezone: every consumer of a TIMESTAMP column in this codebase computes
// calendar-day boundaries via `.toISOString().slice(0, 10)`, which is only
// correct if the value MySQL hands back is already UTC — an unpinned
// connection inherits whatever timezone the server happens to be configured
// with, silently shifting day-boundary calculations on any non-UTC server.
const pool = mysql.createPool({ uri: ENV.databaseUrl, timezone: "Z" });
export const db = drizzle(pool, { schema, mode: "default" });

// Lets functions accept either the pool-backed `db` or a `db.transaction(...)`
// callback's scoped client, so callers can enroll their writes in a caller's
// transaction instead of always running on a separate pool connection. Typed
// as a union (not `typeof db`) because the transaction-scoped client lacks
// `db`'s `$client: Pool` property while still supporting the same queries.
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
```

Note the change from `mysql.createPool(ENV.databaseUrl)` (a plain connection-string argument) to `mysql.createPool({ uri: ENV.databaseUrl, timezone: "Z" })` (an options object with the connection string under `uri` plus the new `timezone` option) — `mysql2`'s `createPool` accepts either a bare URI string or an options object with a `uri` key alongside other options; confirm this against the actual installed `mysql2` version's types if the change doesn't typecheck cleanly (check `node_modules/.pnpm/mysql2@*/node_modules/mysql2/promise.d.ts` or equivalent for the exact accepted shape before finalizing).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/inventoryLedger.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all tests pass — this is a connection-level change with no schema/type impact, so no other test should be affected.

- [ ] **Step 6: Commit**

```bash
git add server/dbClient.ts server/inventoryLedger.test.ts
git commit -m "feat: pin MySQL connection pool to UTC, closing timezone drift on inventory_ledger reads"
```

---

## Task 3: Purchase Order Planned Ready Date → Calendar-Day String

**Files:**
- Modify: `drizzle/schema.ts`
- Modify: `server/purchaseOrders.ts`
- Modify: `server/purchaseOrders.test.ts`
- Modify: `server/routers.ts`
- Modify: `client/src/pages/PurchaseOrdersPage.tsx`

**Interfaces:**
- Modifies: `updatePurchaseOrderPlannedReadyDate`'s `newDate` parameter from `Date` to `string` (format `"YYYY-MM-DD"`).
- Modifies: `PurchaseOrder`'s inferred `plannedReadyDate` field from `Date | null` to `string | null` (a consequence of the schema change, no code change needed to the type export itself since it's inferred).

- [ ] **Step 1: Reset the local dev DB and apply the schema change**

Given this changes an existing column's type (not just adding a new one), reset the local dev DB first per this plan's Global Constraints:

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"
```

(Adjust host/port/credentials from the actual `.env` if they differ. This is the local disposable dev database only — never run this against any other database.)

- [ ] **Step 2: Change the schema**

```typescript
// drizzle/schema.ts — find the purchaseOrders table definition and change plannedReadyDate's type.
// Current: plannedReadyDate: timestamp("plannedReadyDate"),
// New:
plannedReadyDate: date("plannedReadyDate", { mode: "string" }),
```

Add `date` to the existing `drizzle-orm/mysql-core` import line at the top of `drizzle/schema.ts` if it isn't already imported (check the current import line — this schema file likely already imports several column-type functions like `timestamp`, `varchar`, `int`, etc.; add `date` alongside them).

- [ ] **Step 3: Write the failing test (update the existing test, since the input type is changing)**

```typescript
// server/purchaseOrders.test.ts — update the existing "logs a real prior planned-ready-date value..." test
// (find it by its current content: `await updatePurchaseOrderPlannedReadyDate(po.id, new Date("2026-10-08"), {...})`)
// Change the date argument from a Date to a plain calendar-day string:
await updatePurchaseOrderPlannedReadyDate(po.id, "2026-10-08", {
  reasonCategory: "artwork_delay",
  changedBy: 1,
});
```

Also add a new test proving the round-trip preserves the exact calendar day:

```typescript
it("stores and reads back a planned ready date as an exact calendar day, no time-of-day drift", async () => {
  const vendor = await createVendor({ name: "Lvmengkang" });
  const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: 1 });

  await updatePurchaseOrderPlannedReadyDate(po.id, "2026-12-31", { reasonCategory: "artwork_delay", changedBy: 1 });

  const updated = await getPurchaseOrderWithLineItems(po.id);
  expect(updated.plannedReadyDate).toBe("2026-12-31");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test server/purchaseOrders.test.ts`
Expected: FAIL — `updatePurchaseOrderPlannedReadyDate` still expects a `Date` (TypeScript compile error) until Step 5's implementation change, and the schema hasn't been applied to the DB yet.

- [ ] **Step 5: Write minimal implementation**

```typescript
// server/purchaseOrders.ts — modify updatePurchaseOrderPlannedReadyDate
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

- [ ] **Step 6: Apply the schema change to the local dev DB**

Run: `pnpm db:push`

Then verify directly, not just trusting the exit code:

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "SHOW CREATE TABLE purchase_orders\G"
```

Confirm `plannedReadyDate` shows as `date` type, not `timestamp`.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test server/purchaseOrders.test.ts`
Expected: PASS

- [ ] **Step 8: Update the router boundary**

```typescript
// server/routers.ts — modify the purchaseOrders.updatePlannedReadyDate procedure
updatePlannedReadyDate: editorProcedure
  .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: reasonCategorySchema, reasonNote: z.string().optional() }))
  .mutation(({ input, ctx }) =>
    updatePurchaseOrderPlannedReadyDate(input.id, input.newDate.toISOString().slice(0, 10), { ...input, changedBy: ctx.user.id }),
  ),
```

The zod input schema itself is unchanged (`newDate: z.date()`) — only the call site converts the `Date` to a calendar-day string before passing it to the now-`string`-typed function.

- [ ] **Step 9: Update the client**

```typescript
// client/src/pages/PurchaseOrdersPage.tsx — modify toDateInputValue to accept the now-string plannedReadyDate
function toDateInputValue(date: string | Date | null | undefined): string {
  if (typeof date === "string") return date;
  const base = date ?? new Date();
  return base.toISOString().slice(0, 10);
}
```

`defaultRowState`'s parameter type and the call sites at `defaultRowState(po.plannedReadyDate)`/`setRow(po.id, po.plannedReadyDate, ...)` need their type annotations updated from `Date | null | undefined` to `string | Date | null | undefined` to match (search for `plannedReadyDate: Date | null | undefined` in this file and update it — there are two occurrences, in `defaultRowState`'s signature and `setRow`'s signature). No other client change is needed — `po.plannedReadyDate?.toString()` (the display line) already works correctly on a plain string (a string's own `.toString()` returns itself), and `createEntry.mutate`/`updateDate.mutate` call sites already send a `Date` via `new Date(row.newDate)`, matching the unchanged router input type.

- [ ] **Step 10: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 11: Verify live via the API**

Start the server (`set -a && source .env && set +a && pnpm exec tsx server/_core/index.ts`), log in via the existing scriptable flow (`POST /api/auth/password` with the `.env`'s `APP_PASSWORD`, `GET /api/auth/users`, `POST /api/auth/select-user`), create a PO, call `purchaseOrders.updatePlannedReadyDate` with a real date, and confirm via `purchaseOrders.list`/`getWithLineItems` that `plannedReadyDate` comes back as a plain `"YYYY-MM-DD"` string (not an ISO datetime string) with the exact date submitted. Stop the server when done.

- [ ] **Step 12: Commit**

```bash
git add drizzle/schema.ts server/purchaseOrders.ts server/purchaseOrders.test.ts server/routers.ts client/src/pages/PurchaseOrdersPage.tsx
git commit -m "feat: purchase_orders.plannedReadyDate as a calendar-day string, closing timezone drift"
```

---

## Task 4: Sales Plan / Sales Actuals Dates → Calendar-Day Strings

**Files:**
- Modify: `drizzle/schema.ts`
- Modify: `server/salesPlan.ts`
- Modify: `server/salesPlan.test.ts`
- Modify: `server/dashboards.ts`
- Modify: `server/routers.ts`

**Interfaces:**
- Modifies: `CreateSalesPlanEntryInput.periodDate` from `Date` to `string`.
- Modifies: `RecordSalesActualInput.date` from `Date` to `string`.
- Modifies: `getPlanActualDeviation`'s `from`/`to` parameters from `Date` to `string`.
- `getPlanActualDeviation`'s return shape is UNCHANGED (`{ date: string, planned: number, actual: number, deviation: number }[]`) — `dateKey` was already derived via `.toISOString().slice(0, 10)`, and after this change `plan.periodDate` already IS that string, so no client code needs to change for this function's consumers.

- [ ] **Step 1: Reset the local dev DB and change the schema**

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"
```

```typescript
// drizzle/schema.ts — sales_plan table: change periodDate
// Current: periodDate: timestamp("periodDate").notNull(),
// New:
periodDate: date("periodDate", { mode: "string" }).notNull(),
```

```typescript
// drizzle/schema.ts — sales_actuals table: change date
// Current: date: timestamp("date").notNull(),
// New:
date: date("date", { mode: "string" }).notNull(),
```

(`date` should already be imported from Task 3's schema change to this same file — if you're implementing this task independently of Task 3 having landed first, add `date` to the existing `drizzle-orm/mysql-core` import line.)

- [ ] **Step 2: Write the failing tests**

```typescript
// server/salesPlan.test.ts — update the existing test that inserts a periodDate directly
// (find: `await db.insert(salesPlan).values({ skuId: sku.id, warehouseId: ff.id, periodDate: new Date("2026-09-09"), plannedQty: 1000 });`)
// Change to:
await db.insert(salesPlan).values({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-09-09", plannedQty: 1000 });

// Update the getPlanActualDeviation call in the same test from Date args to string args:
// (find: `const deviation = await getPlanActualDeviation(sku.id, ff.id, new Date("2026-09-09"), new Date("2026-09-09"));`)
const deviation = await getPlanActualDeviation(sku.id, ff.id, "2026-09-09", "2026-09-09");
```

```typescript
// server/salesPlan.test.ts — update the existing createSalesPlanEntry test's periodDate argument
// (find: `periodDate: new Date("2026-10-01"),` inside the createSalesPlanEntry call)
// Change to:
periodDate: "2026-10-01",
```

```typescript
// server/salesPlan.test.ts — add a new round-trip test
it("stores and reads back a sales_actuals date as an exact calendar day, no time-of-day drift", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

  await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-19", qty: 10, source: "manual" });

  const [row] = await db.select().from(salesActuals).where(eq(salesActuals.skuId, sku.id));
  expect(row.date).toBe("2026-09-19");
});
```

You will need `eq` added to the existing `drizzle-orm` import line in `server/salesPlan.test.ts` if it isn't already imported (check the current import line first).

Search this test file for every other call to `recordSalesActual` and confirm the `date` field is already a plain string, not `new Date(...)` — if any existing calls use `new Date(...)`, update them to the equivalent `"YYYY-MM-DD"` string.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test server/salesPlan.test.ts`
Expected: FAIL (type errors until Step 4's implementation lands, and the schema hasn't been applied to the DB yet).

- [ ] **Step 4: Write minimal implementation**

```typescript
// server/salesPlan.ts — update the three type/function signatures
export interface CreateSalesPlanEntryInput {
  skuId: number;
  warehouseId: number;
  periodDate: string;
  plannedQty: number;
}

export interface RecordSalesActualInput {
  skuId: number;
  warehouseId: number;
  date: string;
  qty: number;
  source: "shopify_daily_pull" | "manual";
}
```

```typescript
// server/salesPlan.ts — update getPlanActualDeviation's signature and body
export async function getPlanActualDeviation(skuId: number, warehouseId: number, from: string, to: string) {
  const plans = await db
    .select()
    .from(salesPlan)
    .where(and(eq(salesPlan.skuId, skuId), eq(salesPlan.warehouseId, warehouseId), between(salesPlan.periodDate, from, to)));
  const actuals = await db
    .select()
    .from(salesActuals)
    .where(and(eq(salesActuals.skuId, skuId), eq(salesActuals.warehouseId, warehouseId), between(salesActuals.date, from, to)));

  return plans.map((plan) => {
    const dateKey = plan.periodDate;
    const actual = actuals
      .filter((a) => a.date === dateKey)
      .reduce((sum, a) => sum + a.qty, 0);
    return { date: dateKey, planned: plan.plannedQty, actual, deviation: actual - plan.plannedQty };
  });
}
```

`createSalesPlanEntry` and `recordSalesActual` themselves need no body changes — they already just pass `input` straight through to Drizzle's `insert(...).values(input)`; only their TypeScript interface declarations (above) needed to change.

`recordLedgerEvent`'s own `date` parameter inside `recordSalesActual`'s call to it is UNCHANGED — `inventoryLedger.date` stays a real `Date`/`timestamp(3)` per this plan's Global Constraints, so `recordSalesActual`'s internal call `recordLedgerEvent({ ..., date: input.date, ... }, tx)` now passes a `string` where `recordLedgerEvent` expects a `Date`. **You must fix this mismatch**: convert `input.date` (a `"YYYY-MM-DD"` string) to a `Date` before passing it to `recordLedgerEvent`, e.g. `date: new Date(input.date)` — a plain `"YYYY-MM-DD"` string parses as UTC midnight via the standard `Date` constructor, which is the correct, unambiguous interpretation for a calendar-day sales-actual being recorded as a ledger event.

```typescript
// server/salesPlan.ts — the corrected recordSalesActual (only the recordLedgerEvent call's date field changes)
export async function recordSalesActual(input: RecordSalesActualInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(salesActuals).values(input);
    await recordLedgerEvent(
      {
        skuId: input.skuId,
        warehouseId: input.warehouseId,
        eventType: "sale",
        qty: -input.qty,
        unitCost: null,
        date: new Date(input.date),
        sourceRef: `sales_actual:${input.source}`,
      },
      tx,
    );
  });
}
```

```typescript
// server/dashboards.ts — modify getAverageDailySales's windowStart construction
async function getAverageDailySales(skuId: number, warehouseId: number, windowDays = 30): Promise<number> {
  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(salesActuals)
    .where(
      and(
        eq(salesActuals.skuId, skuId),
        eq(salesActuals.warehouseId, warehouseId),
        gte(salesActuals.date, windowStart),
```

(Only the `windowStart` line and its usage in the existing `gte(...)` call change — the rest of `getAverageDailySales`'s body is unchanged; find the function's closing lines yourself and confirm no other line references `windowStart` as a `Date`.)

- [ ] **Step 5: Apply the schema change and verify**

Run: `pnpm db:push`

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "SHOW CREATE TABLE sales_plan\G SHOW CREATE TABLE sales_actuals\G"
```

Confirm both `periodDate` and `date` show as `date` type, not `timestamp`.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test server/salesPlan.test.ts server/dashboards.test.ts`
Expected: PASS

- [ ] **Step 7: Update the router boundary**

```typescript
// server/routers.ts — modify the salesPlan.create and salesPlan.planActualDeviation procedures
salesPlan: router({
  create: editorProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), periodDate: z.date(), plannedQty: z.number() }))
    .mutation(({ input }) => createSalesPlanEntry({ ...input, periodDate: input.periodDate.toISOString().slice(0, 10) })),
  volatility: protectedProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), weeks: z.number() }))
    .query(({ input }) => getSalesVolatility(input.skuId, input.warehouseId, input.weeks)),
  planActualDeviation: protectedProcedure
    .input(z.object({ skuId: z.number(), warehouseId: z.number(), from: z.date(), to: z.date() }))
    .query(({ input }) => getPlanActualDeviation(input.skuId, input.warehouseId, input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10))),
}),
```

The zod input schemas are unchanged (`periodDate`/`from`/`to` still `z.date()`) — only the mutation/query bodies convert to calendar-day strings before calling the now-`string`-typed functions.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 9: Verify live via the API**

Start the server, log in via the scriptable flow, call `salesPlan.create` with a real `Date`, then call `salesPlan.planActualDeviation` and confirm the returned `date` field is a plain `"YYYY-MM-DD"` string matching what was submitted. Stop the server when done.

- [ ] **Step 10: Commit**

```bash
git add drizzle/schema.ts server/salesPlan.ts server/salesPlan.test.ts server/dashboards.ts server/routers.ts
git commit -m "feat: sales_plan/sales_actuals dates as calendar-day strings, closing timezone drift"
```

---

## Task 5: Daily Shopify Pull Idempotency

**Files:**
- Modify: `drizzle/schema.ts`
- Modify: `server/shopifyDailyPull.ts`
- Modify: `server/shopifyDailyPull.test.ts`

**Interfaces:**
- Modifies: `runDailyShopifyPull`'s return type — `SkippedRow` gains no new fields, but a row skipped for being a duplicate now uses the reason `"duplicate: already imported for this SKU/warehouse/date"` rather than being silently inserted again.
- Depends on Task 4: `sales_actuals.date` must already be `date` (string) mode for the unique constraint below to be an exact calendar-day match with no timestamp-precision ambiguity. Dispatch this task after Task 4.

- [ ] **Step 1: Add the unique constraint to the schema**

```typescript
// drizzle/schema.ts — find the salesActuals table definition's third argument (the callback defining indexes/constraints)
// If salesActuals currently has no such callback (a plain two-argument mysqlTable(...) call), add one:
export const salesActuals = mysqlTable(
  "sales_actuals",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull(),
    warehouseId: int("warehouseId").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    qty: int("qty").notNull(),
    source: mysqlEnum("source", SALES_ACTUAL_SOURCES).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateSourceUnique: unique("sales_actuals_sku_warehouse_date_source_unique").on(
      table.skuId, table.warehouseId, table.date, table.source,
    ),
  }),
);
```

Add `unique` to the existing `drizzle-orm/mysql-core` import line if it isn't already imported (it should already be there from Stream B's `skus` table unique constraint — check before adding a duplicate import).

- [ ] **Step 2: Reset the local dev DB and write the failing test**

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"
```

```typescript
// server/shopifyDailyPull.test.ts (addition to the existing describe block)
it("skips a row that duplicates an already-imported SKU/warehouse/date/source, without double-counting SOH or COGS", async () => {
  const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
  const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
  await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

  const rows: ShopifyExportRow[] = [
    { sku: "JELLO-CAL-500", warehouse_code: "FF-DE", order_date: "2026-09-19", qty: "10" },
  ];
  const skuLookup = { "JELLO-CAL-500": sku.id };
  const warehouseLookup = { "FF-DE": ff.id };

  const firstRun = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
  expect(firstRun.imported).toBe(1);
  expect(firstRun.skipped).toEqual([]);

  const secondRun = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
  expect(secondRun.imported).toBe(0);
  expect(secondRun.skipped).toEqual([{ sku: "JELLO-CAL-500", reason: expect.stringContaining("duplicate") }]);

  const actualRows = await db.select().from(salesActuals);
  expect(actualRows).toHaveLength(1);
  const ledgerRows = await db.select().from(inventoryLedger).where(eq(inventoryLedger.eventType, "sale"));
  expect(ledgerRows).toHaveLength(1);
});
```

Check `server/shopifyDailyPull.test.ts`'s existing imports — you will need `db`, `salesActuals`, `inventoryLedger`, `eq`, `recordLedgerEvent`, `createSku`, `createWarehouse` added to the existing import lines if any are missing.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test server/shopifyDailyPull.test.ts`
Expected: FAIL — the second run currently imports the duplicate again instead of skipping it (`secondRun.imported` would be `1`, not `0`, and `actualRows`/`ledgerRows` would each have length `2`).

- [ ] **Step 4: Write minimal implementation**

```typescript
// server/shopifyDailyPull.ts — replace the whole file with this content
import { and, eq } from "drizzle-orm";
import { db } from "./dbClient";
import { salesActuals } from "../drizzle/schema";
import { recordSalesActual } from "./salesPlan";

export interface ShopifyExportRow {
  sku: string;
  warehouse_code: string;
  order_date: string;
  qty: string;
}

export interface ParsedSale {
  sku: string;
  warehouseCode: string;
  date: string;
  qty: number;
}

export function parseShopifyExport(rows: ShopifyExportRow[]): ParsedSale[] {
  const grouped = new Map<string, ParsedSale>();
  for (const row of rows) {
    const key = `${row.sku}|${row.warehouse_code}|${row.order_date}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += parseInt(row.qty, 10);
    } else {
      grouped.set(key, { sku: row.sku, warehouseCode: row.warehouse_code, date: row.order_date, qty: parseInt(row.qty, 10) });
    }
  }
  return Array.from(grouped.values());
}

export interface SkippedRow {
  sku: string;
  reason: string;
}

export async function runDailyShopifyPull(
  rows: ShopifyExportRow[],
  skuLookup: Record<string, number>,
  warehouseLookup: Record<string, number>,
): Promise<{ imported: number; skipped: SkippedRow[] }> {
  const parsed = parseShopifyExport(rows);
  let imported = 0;
  const skipped: SkippedRow[] = [];

  for (const sale of parsed) {
    const skuId = skuLookup[sale.sku];
    const warehouseId = warehouseLookup[sale.warehouseCode];
    if (!skuId) {
      skipped.push({ sku: sale.sku, reason: "unknown SKU" });
      continue;
    }
    if (!warehouseId) {
      skipped.push({ sku: sale.sku, reason: "unknown warehouse" });
      continue;
    }

    const [existing] = await db
      .select()
      .from(salesActuals)
      .where(
        and(
          eq(salesActuals.skuId, skuId),
          eq(salesActuals.warehouseId, warehouseId),
          eq(salesActuals.date, sale.date),
          eq(salesActuals.source, "shopify_daily_pull"),
        ),
      );
    if (existing) {
      skipped.push({ sku: sale.sku, reason: `duplicate: already imported ${sale.qty} unit(s) for this SKU/warehouse/date on a prior run` });
      continue;
    }

    await recordSalesActual({
      skuId,
      warehouseId,
      date: sale.date,
      qty: sale.qty,
      source: "shopify_daily_pull",
    });
    imported++;
  }

  return { imported, skipped };
}
```

Note `sale.date` is already a plain `"YYYY-MM-DD"` string (from `ShopifyExportRow.order_date`, unchanged by this plan) and `recordSalesActual`'s `date` field is now also a `string` per Task 4 — no conversion needed here, they already match.

- [ ] **Step 5: Apply the schema change and verify**

Run: `pnpm db:push`

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "SHOW CREATE TABLE sales_actuals\G"
```

Confirm the unique key `sales_actuals_sku_warehouse_date_source_unique` appears covering all four columns.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test server/shopifyDailyPull.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add drizzle/schema.ts server/shopifyDailyPull.ts server/shopifyDailyPull.test.ts
git commit -m "feat: make the daily Shopify pull idempotent — duplicate rows are quarantined, not re-imported"
```

---

## Task 6: Daily Shopify Pull CLI Entrypoint

**Files:**
- Create: `scripts/run-daily-shopify-pull.mjs`
- Modify: `RAILWAY.md`

**Interfaces:** None consumed by any other task — this is the final task in this plan.

- [ ] **Step 1: Read the existing nightly-export script's pattern**

Read `scripts/run-nightly-export.mjs` in full before writing this task's script — match its exact conventions (shebang or lack thereof, `tsx`-executable, `set -a && source .env` expectation documented in a comment, `process.exit(0)`/`process.exit(1)` on every path, since the mysql2 connection pool otherwise keeps the process alive).

- [ ] **Step 2: Write the CLI wrapper**

```javascript
// scripts/run-daily-shopify-pull.mjs
import { readFile } from "node:fs/promises";
import { runDailyShopifyPull } from "../server/shopifyDailyPull.ts";
import { listSkus, listWarehouses } from "../server/db.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-daily-shopify-pull.mjs <path-to-shopify-export.json>");
  process.exit(1);
}

let rows;
try {
  const raw = await readFile(inputPath, "utf-8");
  rows = JSON.parse(raw);
} catch (err) {
  console.error(`Failed to read or parse ${inputPath}: ${err.message}`);
  process.exit(1);
}

try {
  const skus = await listSkus();
  const warehouses = await listWarehouses();
  const skuLookup = Object.fromEntries(skus.filter((s) => s.sku).map((s) => [s.sku, s.id]));
  const warehouseLookup = Object.fromEntries(warehouses.map((w) => [w.code, w.id]));

  const result = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
  console.log(`Daily Shopify pull complete. Imported: ${result.imported}. Skipped: ${result.skipped.length}.`);
  if (result.skipped.length > 0) {
    console.log(JSON.stringify(result.skipped, null, 2));
  }
  process.exit(0);
} catch (err) {
  console.error("Daily Shopify pull failed:", err.message);
  process.exit(1);
}
```

Adjust the import paths' file extensions (`.ts` vs no extension) to match exactly what `scripts/run-nightly-export.mjs` actually uses for its own cross-directory imports — read that file's real import lines before finalizing this one, since this repo's own build history notes a real gotcha here (`node --experimental-strip-types` doesn't work against this repo's extensionless relative imports; the documented fix was switching to `pnpm exec tsx`, which resolves extensionless imports correctly — match whatever extension convention `run-nightly-export.mjs` actually uses).

- [ ] **Step 3: Verify it runs end-to-end against the real local dev DB**

Run: `set -a && source .env && set +a && echo '[]' > /tmp/empty-shopify-export.json && pnpm exec tsx scripts/run-daily-shopify-pull.mjs /tmp/empty-shopify-export.json`
Expected: `Daily Shopify pull complete. Imported: 0. Skipped: 0.`, exit code 0.

Then verify a real, non-empty run: create a real SKU and warehouse via the existing scriptable API-login flow (or directly via a small script using `createSku`/`createWarehouse`), write a matching export row to a temp JSON file, run the script again, and confirm it reports `Imported: 1`. Run it a second time with the same file and confirm it reports `Imported: 0, Skipped: 1` with a duplicate reason — this is a real end-to-end proof of Task 5's idempotency guarantee through the actual CLI path, not just the unit test.

- [ ] **Step 4: Document the command in RAILWAY.md**

Add a new section alongside the existing nightly-export and migration documentation:

```markdown
## Daily Shopify sales import

```bash
pnpm exec tsx scripts/run-daily-shopify-pull.mjs <path-to-shopify-export.json>
```

Idempotent — re-running for a day/SKU/warehouse combination already imported reports it as skipped (duplicate) rather than double-counting SOH depletion or COGS. Exits 0 even when rows are skipped (skipping is expected, not a failure); exits 1 only on a hard failure (missing file, malformed input, or an unexpected error).
```

- [ ] **Step 5: Commit**

```bash
git add scripts/run-daily-shopify-pull.mjs RAILWAY.md
git commit -m "feat: CLI entrypoint for the daily Shopify pull, matching the existing nightly-export pattern"
```

---

## Self-Review Notes

**Spec coverage check:** all 5 design sections map to tasks — Section 1 (idempotency) → Tasks 5-6; Section 2 (cron wrapper) → Task 6; Section 3 (calendar-day columns) → Tasks 3-4; Section 4 (pinned UTC timezone, `inventory_ledger.date` excluded) → Task 2; Section 5 (currency guard) → Task 1.

**Placeholder scan:** every step has real, complete code. Two deliberately-flagged points requiring the implementer's own verification against the actual installed library/file rather than blind trust: Task 2's `mysql2.createPool` options-object shape (verify against the installed version's types), and Task 6's import file-extension convention (verify against `run-nightly-export.mjs`'s actual current imports) — both are pre-existing-code checks, not open design decisions.

**Type consistency cross-check:** `CreateSalesPlanEntryInput.periodDate` (Task 4) is `string`, matching what `salesPlan.create`'s router handler (Task 4, same task) now passes after its own `.toISOString().slice(0, 10)` conversion. `getPlanActualDeviation`'s `from`/`to` (Task 4) are `string`, matching `salesPlan.planActualDeviation`'s router conversion in the same task. `updatePurchaseOrderPlannedReadyDate`'s `newDate` (Task 3) is `string`, matching `purchaseOrders.updatePlannedReadyDate`'s router conversion in the same task. `recordSalesActual`'s `date` (Task 4) is `string`, but its internal call to `recordLedgerEvent` (unchanged, still expects `Date`) is explicitly converted back via `new Date(input.date)` — cross-checked this exact mismatch and its fix are both called out explicitly in Task 4's Step 4, not left implicit. `runDailyShopifyPull`'s `recordSalesActual` call (Task 5) passes `sale.date`, already a string matching the post-Task-4 signature, confirmed no conversion needed there.
