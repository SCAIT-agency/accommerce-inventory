# Freight/Duty Cost Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the freight/duty desync bug (`recordShipmentCosts` can silently drift a shipment's displayed cost away from what's already baked into `inventory_ledger` once it has arrived) by making `recordShipmentCosts` ledger-safe for the whole post-arrival period, and add an explicit, one-way `lockShipmentCosts` action an operator uses once costs are confirmed final.

**Architecture:** `correctShipmentLandedCost`'s existing ledger-correcting body is extracted into a shared, module-private core (`applyShipmentCostChange`) that both `correctShipmentLandedCost` and `recordShipmentCosts`'s new post-arrival branch call. `recordShipmentCosts` gains three branches keyed on shipment status/lock state: pre-arrival (unchanged), post-arrival-unlocked (now ledger-safe via the shared core), post-arrival-locked (refused). `lockShipmentCosts` is a new, one-way function — no unlock exists. Two nullable columns (`costsLockedAt`, `costsLockedBy`) carry lock state on `shipments`.

**Tech Stack:** Node/Express + tRPC v11 + React + TiDB (MySQL) via Drizzle ORM + Vitest.

**Spec:** `docs/2026-09-23-freight-duty-cost-lock-design.md`

## Global Constraints

- Locking is only possible once `status === "delivered"` — never before.
- Locking is one-way; no `unlockShipmentCosts` function exists.
- `recordShipmentCosts` is ledger-safe for the entire period after arrival, locked or not — the actual desync bug this design exists to close must not persist in the unlocked "window."
- Once locked, `recordShipmentCosts` always refuses; `correctShipmentLandedCost` is the only path forward.
- The ledger-side correction (`correctLedgerReceipt`, called internally by both `recordShipmentCosts`'s post-arrival branch and `correctShipmentLandedCost`) always hardcodes `reasonCategory: "data_correction"` on the `inventory_ledger` rows themselves — this already holds today via `correctLedgerReceipt`'s own existing implementation and needs no new code to preserve.
- The shipment-level `change_log` entries for `freightCost`/`dutyCost` continue to use the caller's own genuine manual `reasonCategory` in `recordShipmentCosts`'s post-arrival branch (not `"data_correction"`) — only `correctShipmentLandedCost` and `lockShipmentCosts` hardcode `"data_correction"` at the shipment-log level too.
- No new `MANUAL_REASON_CATEGORIES`/`REASON_CATEGORIES` changes — this design introduces no new reason category.
- Every existing `recordShipmentCosts`/`correctShipmentLandedCost` test in `server/shipments.test.ts` must still pass unmodified except where this design explicitly changes behavior (the post-arrival branch).
- `correctShipmentLandedCost`'s own external signature, error messages, and behavior are unchanged by the extraction — it becomes a thin wrapper, not a different function.
- This codebase has no toast/notification library — any new UI error/status message uses the same inline `<div>`/`<p>` pattern every other control on `ShipmentsPage.tsx` already uses.
- Migrations are generated (`pnpm exec drizzle-kit generate`), never hand-written, and applied locally via `pnpm db:migrate` (never `db:push` outside dev-from-scratch setup) — matching every prior stream's convention.

## Review Focus

- A `recordShipmentCosts` call against a **locked** shipment must be refused before any write happens — not just have its final result look right, but leave zero rows changed (no partial `shipments` update, no `change_log` entry, no ledger correction) if the call is made anyway.
- A post-arrival-unlocked `recordShipmentCosts` call with a **blank or whitespace-only `reasonNote`** must be rejected before any write — the design requires this to be a value-level check, not just "field present," and a naive `opts.reasonNote !== undefined` check would let `"   "` through.
- `lockShipmentCosts` called a **second time** on an already-locked shipment must refuse cleanly (no double-write of `costsLockedAt`, no duplicate `change_log` entry) rather than silently re-locking or throwing an unrelated error.
- `lockShipmentCosts` called on a shipment that **hasn't arrived yet** (`status !== "delivered"`) must refuse with a message naming that precondition, not a generic failure — an operator acting on the wrong shipment needs to understand why immediately.
- The `allowNegativeSoh` escape hatch must actually reach the post-arrival branch's ledger correction — since every routine post-arrival cost tweak now triggers a real ledger correction (not just the rarer, deliberate `correctShipmentLandedCost` calls), Stream M's same-day FIFO-unreplayable refusal is more likely to fire here in absolute terms, so the bypass has to work from this call site too, not just `correctShipmentLandedCost`'s.

---

### Task 1: Schema — `costsLockedAt`/`costsLockedBy` columns on `shipments`

**Files:**
- Modify: `drizzle/schema.ts:143-165` (the `shipments` table definition)
- Create: a new Drizzle migration under `drizzle/migrations/` (generated, not hand-written)
- Test: `server/shipments.test.ts`

**Interfaces:**
- Produces: `shipments.costsLockedAt` (nullable `timestamp`), `shipments.costsLockedBy` (nullable `int`, FK to `users.id`) — on the `Shipment`/`ShipmentListItem` types every later task and the frontend's `inferRouterOutputs` type both pick up automatically (no manual type edits needed anywhere else).

- [ ] **Step 1: Add the two columns to `drizzle/schema.ts`**

Current block (lines 143-165):
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
  /** Total freight/duty for the whole shipment, in `costCurrency` — allocated to
   * individual SKU lines via each shipment_line_items row's weightShare/valueShare.
   * Nullable: not every shipment has a real invoice yet at creation time. */
  freightCost: decimal("freightCost", { precision: 18, scale: 4, mode: "string" }),
  dutyCost: decimal("dutyCost", { precision: 18, scale: 4, mode: "string" }),
  costCurrency: varchar("costCurrency", { length: 8 }),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Shipment = typeof shipments.$inferSelect;
```

Replace with:
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
  /** Total freight/duty for the whole shipment, in `costCurrency` — allocated to
   * individual SKU lines via each shipment_line_items row's weightShare/valueShare.
   * Nullable: not every shipment has a real invoice yet at creation time. */
  freightCost: decimal("freightCost", { precision: 18, scale: 4, mode: "string" }),
  dutyCost: decimal("dutyCost", { precision: 18, scale: 4, mode: "string" }),
  costCurrency: varchar("costCurrency", { length: 8 }),
  /** Set once an operator confirms freight/duty are final (only possible once
   * status === "delivered"). Null means unlocked — recordShipmentCosts stays
   * callable. Never cleared once set: lockShipmentCosts is one-way, matching
   * this platform's append-only ledger philosophy. See
   * docs/2026-09-23-freight-duty-cost-lock-design.md §3-4. */
  costsLockedAt: timestamp("costsLockedAt"),
  costsLockedBy: int("costsLockedBy").references(() => users.id),
  createdBy: int("createdBy").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Shipment = typeof shipments.$inferSelect;
```

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
pnpm exec drizzle-kit generate
```

Check `ls drizzle/migrations/*.sql | tail -1` first to confirm the actual latest number before assuming `0014` (current latest is `0013_solid_bedlam.sql`). Read the generated SQL file to confirm it contains exactly 2 `ALTER TABLE shipments ADD COLUMN` statements (or 1 `ADD COLUMN` for both plus 1 `ADD CONSTRAINT` for the FK, depending on how drizzle-kit batches it) and nothing else.

Apply it:
```bash
pnpm db:migrate
```

- [ ] **Step 3: Confirm the new columns exist via `DESCRIBE`**

Run: `mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "DESCRIBE shipments;"`
Expected: `costsLockedAt` and `costsLockedBy` both present, both nullable (`YES` in the `Null` column).

- [ ] **Step 4: Add one schema-shape regression test**

Add to `server/shipments.test.ts`, inside the existing `describe("shipments", ...)` block (anywhere among the other `it(...)` cases — this file has no nested `describe`s for individual functions):

```ts
  it("creates a shipment with costsLockedAt/costsLockedBy left null", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container-Lock1", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    expect(shipment.costsLockedAt).toBeNull();
    expect(shipment.costsLockedBy).toBeNull();
  });
```

This test file already imports `createShipment` and has `ffWarehouseId`/`userId` set up in `beforeEach` — no new imports needed.

- [ ] **Step 5: Run tests**

Run: `pnpm test shipments`
Expected: all pass, including the new test.

- [ ] **Step 6: Commit**

```bash
git add drizzle/schema.ts drizzle/migrations/ server/shipments.test.ts
git commit -m "feat: add costsLockedAt/costsLockedBy columns to shipments

Schema-only change: both nullable, unused by any write path yet —
Task 3 (lockShipmentCosts) is the first writer, Task 2
(recordShipmentCosts's post-arrival branches) the first reader.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared correction core + `recordShipmentCosts`'s post-arrival branches

**Files:**
- Modify: `server/shipments.ts:170-206` (`recordShipmentCosts`), `server/shipments.ts:452-524` (`correctShipmentLandedCost`)
- Modify: `server/routers.ts` (the `shipments.recordCosts` procedure)
- Test: `server/shipments.test.ts`

**Interfaces:**
- Consumes: `getShipmentLandedUnitCost(shipmentId, tx?)` → `{ lineItemId: number; skuId: number; landedUnitCost: number }[]` (`server/landedCost.ts`); `correctLedgerReceipt(eventId, corrections, opts, tx)` → `Promise<LedgerCorrectionResult>` (`server/inventoryLedger.ts`); `findUncorrectedReceipt(tx, shipmentRef, lineItemId, fallbackSkuId)` → `Promise<{ id: number }>` (already private to `server/shipments.ts`); `isNoOpCorrection(err)` → `boolean` (already private to `server/shipments.ts`); `logChange(input, tx)` (`server/changeLog.ts`); `normalizeDecimalForAudit(value)` → `string | null` (`server/changeLog.ts`).
- Produces: `applyShipmentCostChange(tx, shipmentId, updates, opts): Promise<{ corrections: LedgerCorrectionResult[] }>` — module-private (not exported), used by both `correctShipmentLandedCost` and `recordShipmentCosts`. `recordShipmentCosts`'s `opts` gains `allowNegativeSoh?: boolean`. `recordShipmentCosts` return type (`Promise<Shipment>`) and every pre-arrival caller's behavior are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `server/shipments.test.ts`, inside `describe("shipments", ...)`, near the existing `correctShipmentLandedCost` tests (after the one at line ~1073-1096, "refuses a call that restates no cost field at all"):

```ts
  it("recordShipmentCosts corrects every affected line's ledger receipt once a shipment has arrived", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container-Lock2",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);

    const updated = await recordShipmentCosts(
      shipment.id,
      { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", reasonNote: "real forwarder invoice arrived", changedBy: userId },
    );

    expect(updated.freightCost).toBe("1800.0000");
    // The shipment-level audit trail carries the caller's own real reason,
    // never "data_correction" — only the ledger-side correction hardcodes that.
    const history = await listChangeLog("shipment", shipment.id);
    const freightEntries = history.filter((h) => h.field === "freightCost");
    expect(freightEntries).toHaveLength(2); // one from driveShipmentToDelivered's initial recordShipmentCosts, one from this call
    expect(freightEntries[1].reasonCategory).toBe("freight_rate_change");
    expect(freightEntries[1].oldValue).toBe("900");
    expect(freightEntries[1].newValue).toBe("1800");

    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    const corrected = events.find((e) => e.correctsEventId !== null && e.eventType === "receipt")!;
    expect(corrected).toBeDefined();
    // The ledger-side correction itself is always tagged data_correction,
    // regardless of the caller's own reasonCategory above.
    expect(corrected.reasonCategory).toBe("data_correction");
    expect(parseFloat(corrected.unitCost ?? "0")).toBeCloseTo((90000 * 0.15 + 1800 + 100) / 90000, 4);
    expect(await getSoh(skuId, ffWarehouseId)).toBe(90000);
  });

  it("recordShipmentCosts skips a line whose landed cost is unchanged, mirroring correctShipmentLandedCost's no-op skip", async () => {
    const { shipment, movingSku, unchangedSku } = await seedShipmentWithAZeroFreightShareLine("PO1-W6-Lock1");

    const [unchangedReceiptBefore] = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, unchangedSku.id));

    // dutyCost passed unchanged ("100.00", matching driveShipmentToDelivered's
    // fixed cost) — only freightCost moves, and the unchanged-share line's
    // landed cost is driven entirely by dutyCost*valueShare, so it must not move.
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", reasonNote: "final forwarder invoice", changedBy: userId },
    );

    const movingEvents = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, movingSku.id));
    expect(movingEvents.some((e) => e.correctsEventId !== null && e.eventType === "receipt")).toBe(true);

    const unchangedEvents = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, unchangedSku.id));
    expect(unchangedEvents).toHaveLength(1);
    expect(unchangedEvents[0].id).toBe(unchangedReceiptBefore.id);
    expect(unchangedEvents[0].correctsEventId).toBeNull();
    expect(unchangedEvents[0].unitCost).toBe(unchangedReceiptBefore.unitCost);
  });

  it("recordShipmentCosts rejects a post-arrival call with a blank reasonNote before writing anything", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container-Lock3",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);
    const historyBefore = await listChangeLog("shipment", shipment.id);

    await expect(
      recordShipmentCosts(
        shipment.id,
        { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
        { reasonCategory: "freight_rate_change", reasonNote: "   ", changedBy: userId },
      ),
    ).rejects.toThrow(/reasonNote is required/);

    const [unchanged] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchanged.freightCost).toBe("900.0000");
    const historyAfter = await listChangeLog("shipment", shipment.id);
    expect(historyAfter).toHaveLength(historyBefore.length);
    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    expect(events.every((e) => e.correctsEventId === null)).toBe(true);
  });

  it("recordShipmentCosts refuses a locked shipment before writing anything", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container-Lock4",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);
    // lockShipmentCosts doesn't exist until Task 3 — simulate the locked
    // state directly, the same column recordShipmentCosts itself reads.
    await db.update(shipments).set({ costsLockedAt: new Date(), costsLockedBy: userId }).where(eq(shipments.id, shipment.id));
    const historyBefore = await listChangeLog("shipment", shipment.id);

    await expect(
      recordShipmentCosts(
        shipment.id,
        { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
        { reasonCategory: "freight_rate_change", reasonNote: "trying anyway", changedBy: userId },
      ),
    ).rejects.toThrow(/costs are locked/);

    const [unchanged] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchanged.freightCost).toBe("900.0000");
    const historyAfter = await listChangeLog("shipment", shipment.id);
    expect(historyAfter).toHaveLength(historyBefore.length);
    const events = await db.select().from(inventoryLedger).where(eq(inventoryLedger.skuId, skuId));
    expect(events.every((e) => e.correctsEventId === null)).toBe(true);
  });

  it("recordShipmentCosts's post-arrival branch accepts allowNegativeSoh to bypass the FIFO-replayability guard", async () => {
    const { lineItemId, skuId } = await seedPoWithLineItem();
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container-Lock5",
      warehouseId: ffWarehouseId,
      lineItems: [{ poLineItemId: lineItemId, skuId, qty: 90000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await driveShipmentToDelivered(shipment.id);
    // Sell past what a plain reversal-and-re-receive can replay without going
    // negative, forcing correctLedgerReceipt's guard to fire — the same setup
    // Stream M's own correctShipmentLandedCost force-bypass tests use.
    await recordLedgerEvent({ skuId, warehouseId: ffWarehouseId, eventType: "sale", qty: -85000, unitCost: null, date: new Date("2026-09-21"), sourceRef: "SO1" });

    await expect(
      recordShipmentCosts(
        shipment.id,
        { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
        { reasonCategory: "freight_rate_change", reasonNote: "final invoice", changedBy: userId },
      ),
    ).rejects.toThrow(/allowNegativeSoh|drive SOH negative/i);

    const forced = await recordShipmentCosts(
      shipment.id,
      { freightCost: "1800.00", dutyCost: "100.00", costCurrency: "USD" },
      { reasonCategory: "freight_rate_change", reasonNote: "final invoice, forced", changedBy: userId, allowNegativeSoh: true },
    );
    expect(forced.freightCost).toBe("1800.0000");
  });
```

This file already imports `recordLedgerEvent`, `getSoh`, `inventoryLedger`, `shipments`, `db`, `eq`, `listChangeLog` — no new imports needed for these tests. `seedShipmentWithAZeroFreightShareLine` is already defined further down the file (module-scope `async function`, reused as-is by the second test above).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test shipments`
Expected: the 5 new tests FAIL — `recordShipmentCosts` doesn't yet branch on `status`/`costsLockedAt`, so e.g. the "corrects every affected line's ledger receipt" test currently just overwrites `freightCost`/`dutyCost` with no ledger correction at all, and the locked-shipment test currently succeeds instead of throwing.

- [ ] **Step 3: Extract `applyShipmentCostChange` and make `correctShipmentLandedCost` a thin wrapper**

Replace the current `correctShipmentLandedCost` (lines 452-524 of `server/shipments.ts`) with:

```ts
async function applyShipmentCostChange(
  tx: DbClient,
  shipmentId: number,
  updates: { freightCost?: string; dutyCost?: string },
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<{ corrections: LedgerCorrectionResult[] }> {
  const [before] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!before) {
    throw new Error(`applyShipmentCostChange: no shipment found with id ${shipmentId}`);
  }
  await tx.update(shipments).set(updates).where(eq(shipments.id, shipmentId));
  if (updates.freightCost !== undefined) {
    await logChange({
      entityType: "shipment",
      entityId: shipmentId,
      field: "freightCost",
      oldValue: normalizeDecimalForAudit(before.freightCost),
      newValue: normalizeDecimalForAudit(updates.freightCost),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  }
  if (updates.dutyCost !== undefined) {
    await logChange({
      entityType: "shipment",
      entityId: shipmentId,
      field: "dutyCost",
      oldValue: normalizeDecimalForAudit(before.dutyCost),
      newValue: normalizeDecimalForAudit(updates.dutyCost),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  }

  // Reads back through `tx`, so it sees the restated costs above.
  const landedCosts = await getShipmentLandedUnitCost(shipmentId, tx);
  const corrections: LedgerCorrectionResult[] = [];
  for (const lc of landedCosts) {
    const receipt = await findUncorrectedReceipt(tx, before.shipmentRef, lc.lineItemId, lc.skuId);
    try {
      // toFixed(8) matches both the ledger column's scale and the exact
      // formatting markShipmentArrived writes, so a restatement that lands
      // on the same cost is recognised as a no-op by correctLedgerReceipt
      // rather than written as a cost-changing correction pair.
      corrections.push(
        await correctLedgerReceipt(
          receipt.id,
          { unitCost: lc.landedUnitCost.toFixed(8) },
          { changedBy: opts.changedBy, reasonNote: opts.reasonNote, allowNegativeSoh: opts.allowNegativeSoh },
          tx,
        ),
      );
    } catch (err) {
      // Narrow on purpose: ONLY correctLedgerReceipt's no-op refusal means
      // "this line needed no correction". Every other refusal it can raise
      // is a real failure and must still roll the whole change back.
      if (!isNoOpCorrection(err)) throw err;
    }
  }
  return { corrections };
}

/**
 * Restates a shipment's freight and/or duty cost and corrects every line
 * item's receipt to the landed unit cost that recomputes from it.
 *
 * All-or-nothing across the whole shipment: the `shipments` row update, its
 * change_log entries, and every line item's correction pair share one
 * transaction, so a single line whose receipt is missing, ambiguous, already
 * corrected, or whose reversal cannot replay rolls back the cost restatement
 * too. A shipment is never left with a new freight cost on the row and stale
 * landed costs in the ledger.
 *
 * Only the cost fields actually passed are written and audited, but the
 * recompute always re-reads the whole row — so restating freight alone still
 * yields a landed cost carrying the shipment's existing duty allocation.
 *
 * A line whose recomputed landed cost is unchanged is SKIPPED, not failed —
 * see applyShipmentCostChange's own no-op handling above.
 */
export async function correctShipmentLandedCost(
  shipmentId: number,
  costs: { freightCost?: string; dutyCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
): Promise<{ corrections: LedgerCorrectionResult[] }> {
  // An explicit `undefined` is dropped rather than written: `{ freightCost:
  // undefined }` is the same request as `{}` and must hit the same refusal,
  // not reach the UPDATE as a column-less write.
  const updates: { freightCost?: string; dutyCost?: string } = {};
  if (costs.freightCost !== undefined) updates.freightCost = costs.freightCost;
  if (costs.dutyCost !== undefined) updates.dutyCost = costs.dutyCost;
  if (Object.keys(updates).length === 0) {
    throw new Error("correctShipmentLandedCost: no cost fields provided to correct");
  }

  return db.transaction((tx) =>
    applyShipmentCostChange(tx, shipmentId, updates, { ...opts, reasonCategory: "data_correction" }),
  );
}
```

Note what moved and what didn't: `isNoOpCorrection` and `findUncorrectedReceipt` stay exactly where they are in the file (both already module-private, both already used elsewhere) — only the body between "read `before`" and "return `{ corrections }`" moved into the new function.

- [ ] **Step 4: Rewrite `recordShipmentCosts`**

Replace the current `recordShipmentCosts` (lines 170-206 of `server/shipments.ts`) with:

```ts
export async function recordShipmentCosts(
  id: number,
  costs: { freightCost: string; dutyCost: string; costCurrency: string },
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number; allowNegativeSoh?: boolean },
): Promise<Shipment> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!before) {
      throw new Error(`recordShipmentCosts: no shipment found with id ${id}`);
    }

    if (before.status !== "delivered") {
      // Unchanged from before this design: no ledger involvement, reasonNote
      // stays optional. Preserves every existing caller's pre-arrival
      // behavior exactly.
      await tx.update(shipments).set(costs).where(eq(shipments.id, id));
      await logChange({
        entityType: "shipment",
        entityId: id,
        field: "freightCost",
        oldValue: normalizeDecimalForAudit(before.freightCost),
        newValue: normalizeDecimalForAudit(costs.freightCost),
        reasonCategory: opts.reasonCategory,
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      }, tx);
      await logChange({
        entityType: "shipment",
        entityId: id,
        field: "dutyCost",
        oldValue: normalizeDecimalForAudit(before.dutyCost),
        newValue: normalizeDecimalForAudit(costs.dutyCost),
        reasonCategory: opts.reasonCategory,
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      }, tx);
    } else if (before.costsLockedAt !== null) {
      throw new Error(
        `recordShipmentCosts: shipment ${id}'s costs are locked — use correctShipmentLandedCost to make further changes`,
      );
    } else {
      // Delivered, unlocked: this now performs a real ledger correction under
      // the hood, so reasonNote is required at the value level even though
      // the type signature keeps it optional for the pre-arrival case above.
      const reasonNote = opts.reasonNote?.trim();
      if (!reasonNote) {
        throw new Error(
          `recordShipmentCosts: reasonNote is required to record costs for shipment ${id} after arrival — this now performs a real ledger correction`,
        );
      }
      // costCurrency has no ledger dependency beyond the existing
      // currency-mismatch guard inside getShipmentLandedUnitCost, so it's
      // written directly, outside applyShipmentCostChange's own scope.
      await tx.update(shipments).set({ costCurrency: costs.costCurrency }).where(eq(shipments.id, id));
      await applyShipmentCostChange(
        tx,
        id,
        { freightCost: costs.freightCost, dutyCost: costs.dutyCost },
        {
          changedBy: opts.changedBy,
          reasonCategory: opts.reasonCategory,
          reasonNote,
          allowNegativeSoh: opts.allowNegativeSoh,
        },
      );
    }

    const [row] = await tx.select().from(shipments).where(eq(shipments.id, id));
    return row;
  });
}
```

- [ ] **Step 5: Update the `shipments.recordCosts` tRPC procedure**

In `server/routers.ts`, find the `recordCosts` procedure inside `shipments: router({ ... })`:

```ts
    recordCosts: editorProcedure
      .input(z.object({
        id: z.number(),
        freightCost: z.string(),
        dutyCost: z.string(),
        costCurrency: z.string(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        recordShipmentCosts(
          input.id,
          { freightCost: input.freightCost, dutyCost: input.dutyCost, costCurrency: input.costCurrency },
          { reasonCategory: input.reasonCategory, reasonNote: input.reasonNote, changedBy: ctx.user.id },
        ),
      ),
```

Replace with:

```ts
    recordCosts: editorProcedure
      .input(z.object({
        id: z.number(),
        freightCost: z.string(),
        dutyCost: z.string(),
        costCurrency: z.string(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
        allowNegativeSoh: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) =>
        recordShipmentCosts(
          input.id,
          { freightCost: input.freightCost, dutyCost: input.dutyCost, costCurrency: input.costCurrency },
          {
            reasonCategory: input.reasonCategory,
            reasonNote: input.reasonNote,
            changedBy: ctx.user.id,
            allowNegativeSoh: input.allowNegativeSoh,
          },
        ),
      ),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test shipments`
Expected: all pass, including the 5 new tests from Step 1.

- [ ] **Step 7: Run the full regression suite**

Run: `pnpm test`
Expected: all pass — this step exists specifically to prove the extraction didn't change `correctShipmentLandedCost`'s own externally observable behavior (its full existing test block, lines ~705-1096, must pass with zero modification) and that nothing outside `shipments.test.ts` broke (e.g. `payments.test.ts`, which also uses `correctLedgerReceipt`'s conventions).

- [ ] **Step 8: Run type check**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add server/shipments.ts server/routers.ts server/shipments.test.ts
git commit -m "feat: make recordShipmentCosts ledger-safe for the whole post-arrival period

Extracts correctShipmentLandedCost's ledger-correcting body into a
shared applyShipmentCostChange core. recordShipmentCosts now branches
on shipment status/lock state: pre-arrival stays exactly as before,
post-arrival-unlocked now performs a real ledger correction (closing
the actual desync bug this design exists to fix), post-arrival-locked
refuses. correctShipmentLandedCost's own signature and behavior are
unchanged — it's a thin wrapper now, not a different function.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `lockShipmentCosts`

**Files:**
- Modify: `server/shipments.ts` (new exported function, placed after `recordShipmentCosts`)
- Modify: `server/routers.ts` (new `shipments.lockCosts` procedure)
- Test: `server/shipments.test.ts`

**Interfaces:**
- Consumes: `logChange` (`server/changeLog.ts`).
- Produces: `lockShipmentCosts(id: number, opts: { changedBy: number; reasonNote: string }): Promise<void>` — exported from `server/shipments.ts`, imported into `server/routers.ts`. Task 4 (UI) calls this via the new `shipments.lockCosts` tRPC procedure.

- [ ] **Step 1: Write the failing tests**

Add to `server/shipments.test.ts`, inside `describe("shipments", ...)`, after the new Task 2 tests:

```ts
  it("lockShipmentCosts locks a delivered shipment's costs", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container-Lock6", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await driveShipmentToDelivered(shipment.id);

    await lockShipmentCosts(shipment.id, { changedBy: userId, reasonNote: "forwarder invoice reconciled, final" });

    const [locked] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(locked.costsLockedAt).not.toBeNull();
    expect(locked.costsLockedBy).toBe(userId);

    const history = await listChangeLog("shipment", shipment.id);
    const lockEntry = history.find((h) => h.field === "costsLockedAt");
    expect(lockEntry).toBeDefined();
    expect(lockEntry?.oldValue).toBeNull();
    expect(lockEntry?.newValue).not.toBeNull();
    expect(lockEntry?.reasonCategory).toBe("data_correction");
    expect(lockEntry?.reasonNote).toBe("forwarder invoice reconciled, final");
  });

  it("lockShipmentCosts refuses a shipment that hasn't arrived yet", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container-Lock7", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });

    await expect(
      lockShipmentCosts(shipment.id, { changedBy: userId, reasonNote: "too early" }),
    ).rejects.toThrow(/has not arrived yet/);

    const [unchanged] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchanged.costsLockedAt).toBeNull();
  });

  it("lockShipmentCosts refuses a shipment that's already locked", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container-Lock8", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await driveShipmentToDelivered(shipment.id);
    await lockShipmentCosts(shipment.id, { changedBy: userId, reasonNote: "first lock" });
    const historyAfterFirstLock = await listChangeLog("shipment", shipment.id);

    await expect(
      lockShipmentCosts(shipment.id, { changedBy: userId, reasonNote: "second attempt" }),
    ).rejects.toThrow(/already locked/);

    const historyAfterSecondAttempt = await listChangeLog("shipment", shipment.id);
    expect(historyAfterSecondAttempt).toHaveLength(historyAfterFirstLock.length);
  });

  it("lockShipmentCosts rejects a blank reasonNote", async () => {
    const shipment = await createShipment({ shipmentRef: "PO1-W4-Container-Lock9", warehouseId: ffWarehouseId, lineItems: [], createdBy: userId });
    await driveShipmentToDelivered(shipment.id);

    await expect(
      lockShipmentCosts(shipment.id, { changedBy: userId, reasonNote: "  " }),
    ).rejects.toThrow(/reasonNote is required/);

    const [unchanged] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(unchanged.costsLockedAt).toBeNull();
  });
```

Add `lockShipmentCosts` to this test file's existing import from `./shipments` (the line starting `import { createShipment, ... } from "./shipments";`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test shipments`
Expected: the 4 new tests FAIL with a "not a function" / import error — `lockShipmentCosts` doesn't exist yet.

- [ ] **Step 3: Implement `lockShipmentCosts`**

Add to `server/shipments.ts`, after `recordShipmentCosts`:

```ts
export async function lockShipmentCosts(
  id: number,
  opts: { changedBy: number; reasonNote: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`lockShipmentCosts: no shipment found with id ${id}`);
    }
    if (shipment.status !== "delivered") {
      throw new Error(`lockShipmentCosts: shipment ${id} has not arrived yet — costs can only be locked after arrival`);
    }
    if (shipment.costsLockedAt !== null) {
      throw new Error(`lockShipmentCosts: shipment ${id}'s costs are already locked`);
    }
    if (opts.reasonNote.trim() === "") {
      throw new Error(`lockShipmentCosts: reasonNote is required to lock shipment ${id}'s costs`);
    }
    const lockedAt = new Date();
    await tx.update(shipments).set({ costsLockedAt: lockedAt, costsLockedBy: opts.changedBy }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "costsLockedAt",
      oldValue: null,
      // Full timestamp, not a calendar-day string like plannedDepartDate/
      // actualArrivalDate elsewhere in this file — costsLockedAt records the
      // exact moment of a deliberate, one-way commitment, not a business
      // calendar-day concept.
      newValue: lockedAt.toISOString(),
      reasonCategory: "data_correction",
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}
```

- [ ] **Step 4: Add the `shipments.lockCosts` tRPC procedure**

In `server/routers.ts`, add `lockShipmentCosts` to the existing import from `./shipments`, then add a new procedure inside `shipments: router({ ... })`, immediately after `correctLandedCost` and before `history`:

```ts
    lockCosts: editorProcedure
      .input(z.object({ id: z.number(), reasonNote: z.string().min(1) }))
      .mutation(({ input, ctx }) => lockShipmentCosts(input.id, { changedBy: ctx.user.id, reasonNote: input.reasonNote })),
```

No `reasonCategory` field — matches `correctReceiptQty`/`correctLandedCost`'s existing precedent of no user-suppliable category on correction-adjacent actions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test shipments`
Expected: all pass, including the 4 new tests and the Task 2 test that simulated a locked shipment via a raw `db.update` (that test is unaffected by this task — it still sets the column directly rather than calling `lockShipmentCosts`, and both routes land on the same column).

- [ ] **Step 6: Run the full regression suite and type check**

Run: `pnpm test && pnpm check`
Expected: all pass, clean.

- [ ] **Step 7: Commit**

```bash
git add server/shipments.ts server/routers.ts server/shipments.test.ts
git commit -m "feat: add lockShipmentCosts — one-way freight/duty cost lock

Only possible once a shipment has arrived; no unlock path exists,
matching this platform's append-only ledger philosophy. Once locked,
recordShipmentCosts (Task 2) always refuses and correctShipmentLandedCost
is the only way to change costs further.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — Lock button, locked indicator, disabled inputs on `ShipmentsPage.tsx`

**Files:**
- Modify: `client/src/pages/ShipmentsPage.tsx`

**Interfaces:**
- Consumes: `trpc.shipments.lockCosts` (new tRPC mutation from Task 3); `shipment.costsLockedAt`/`shipment.costsLockedBy` (new fields on `ShipmentListItem`, flow through automatically via `inferRouterOutputs`).
- Produces: `LockCostsControl` component, rendered inside `ShipmentRow`.

- [ ] **Step 1: Add `LockCostsControl`**

Add to `client/src/pages/ShipmentsPage.tsx`, after `CorrectReceiptControl` (which ends around line 595) and before `ShipmentRow`:

```tsx
// Visible only once a shipment has arrived and isn't locked yet — locking a
// not-yet-arrived shipment has no real meaning (see
// docs/2026-09-23-freight-duty-cost-lock-design.md §3), and once locked
// there's no unlock path to render a control for.
function LockCostsControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const lockCosts = trpc.shipments.lockCosts.useMutation({ onSuccess: onUpdated });
  const [reasonNote, setReasonNote] = useState("");

  if (shipment.status !== "delivered" || shipment.costsLockedAt != null) return null;

  return (
    <div>
      <input
        type="text"
        placeholder="why these costs are final"
        value={reasonNote}
        onChange={(e) => setReasonNote(e.target.value)}
      />
      <button
        disabled={reasonNote.trim().length === 0 || lockCosts.isPending}
        onClick={() => lockCosts.mutate({ id: shipment.id, reasonNote })}
      >
        Lock costs
      </button>
      {lockCosts.error && <div>Failed to lock: {lockCosts.error.message}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Update `ShipmentRow`'s cost-editing block**

In `ShipmentRow` (around line 597-708), find the `<td>` block that renders freight/duty display and the cost-editing form (the block containing `Freight: {...}` through the `recordCosts.error` line). Replace it with:

```tsx
      <td>
        <div>
          Freight: {shipment.freightCost != null && shipment.costCurrency ? formatMoney(shipment.freightCost, shipment.costCurrency) : "—"}
          {" · "}
          Duty: {shipment.dutyCost != null && shipment.costCurrency ? formatMoney(shipment.dutyCost, shipment.costCurrency) : "—"}
        </div>
        {shipment.costsLockedAt != null && (
          <p>
            🔒 Locked on {new Date(shipment.costsLockedAt).toISOString().slice(0, 10)} — use the correction form
            above ("Correct cost restated") to make further changes.
          </p>
        )}
        <input
          type="text"
          placeholder="freight cost"
          value={form.freightCost}
          disabled={shipment.costsLockedAt != null}
          onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="duty cost"
          value={form.dutyCost}
          disabled={shipment.costsLockedAt != null}
          onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="currency"
          value={form.costCurrency}
          onChange={(e) => setForm((prev) => ({ ...prev, costCurrency: e.target.value }))}
        />
        <select
          value={form.reasonCategory}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
        >
          {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {noteRequired && (
          <input
            type="text"
            placeholder="required note"
            value={form.reasonNote}
            onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
          />
        )}
        <button
          disabled={!canSave || shipment.costsLockedAt != null || recordCosts.isPending}
          onClick={() =>
            recordCosts.mutate({
              id: shipment.id,
              freightCost: form.freightCost,
              dutyCost: form.dutyCost,
              costCurrency: form.costCurrency,
              reasonCategory: form.reasonCategory,
              reasonNote: noteRequired ? form.reasonNote : undefined,
            })
          }
        >
          Save costs
        </button>
        {recordCosts.error && <div>Failed to save: {recordCosts.error.message}</div>}
        <div style={{ marginTop: "8px" }}>
          <LockCostsControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
      </td>
```

Just above this block, update the `noteRequired`/`canSave` derivation (currently `const noteRequired = form.reasonCategory === "other";` / `const canSave = ...`) to:

```tsx
  // Once a shipment has arrived, the server requires reasonNote regardless of
  // reasonCategory — this now performs a real ledger correction, not just an
  // ordinary field edit. Pre-arrival, the old "only required for 'other'"
  // rule still applies.
  const noteRequired = form.reasonCategory === "other" || shipment.status === "delivered";
  const canSave = form.freightCost.trim().length > 0 && form.dutyCost.trim().length > 0 && form.costCurrency.trim().length > 0
    && (!noteRequired || form.reasonNote.trim().length > 0);
```

(The `disabled={!canSave || shipment.costsLockedAt != null || ...}` on the Save button above is the belt-and-suspenders half — `canSave` alone doesn't know about the lock, so both conditions are needed.)

Design note: the design doc's illustrative copy for the locked indicator was "Costs locked by {name} on {date}" — this codebase has no user-id-to-display-name resolution anywhere in the frontend (confirmed: `ChangeLogPage.tsx` doesn't render `changedBy` at all), so the indicator above shows the date only, matching what's actually available rather than inventing a lookup this design doesn't otherwise need.

- [ ] **Step 3: Manual verification against the real dev server**

Run: `pnpm dev` (server on :3000, Vite client via the `/api` proxy). Log in, navigate to the Shipments page, find (or drive) a `delivered` shipment, and:
1. Confirm the freight/duty inputs and "Save costs" button are enabled, and saving without a reasonNote is blocked (button stays disabled) while the shipment is delivered and unlocked.
2. Save a cost change with a reasonNote filled in — confirm it succeeds and the landed-cost figure elsewhere (Cost & Cashflow's Landed Cost tab) updates.
3. Click "Lock costs" with a reason filled in — confirm the 🔒 indicator appears, the freight/duty inputs become disabled, and "Save costs" is now unclickable.
4. Confirm the existing "Correct cost restated" control (from Stream M) still works normally on the now-locked shipment — that's the only remaining path forward.

This is a UI change — `pnpm check`/`pnpm test` alone do not prove the form renders and behaves correctly; this manual pass is required before considering this task done, per this project's own established convention for frontend changes.

- [ ] **Step 4: Run type check**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/ShipmentsPage.tsx
git commit -m "feat: Lock costs control and locked-state UI on the Shipments page

Freight/duty inputs and Save costs disable once locked; a required
reasonNote field appears on the plain cost form once a shipment has
arrived, matching the server's own new requirement (Task 2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Review

After all 4 tasks: dispatch the final whole-branch code reviewer on the most capable available model (opus), given this touches real ledger/shipment-cost write paths — matching this project's own established escalation precedent for financial-correctness-sensitive reviews. The review should specifically re-verify, against the final code (not just each task's own diff):

1. **Zero-partial-write guarantee on refusal**: for both the locked-shipment refusal and the blank-reasonNote refusal in `recordShipmentCosts`, re-trace by hand that the throw genuinely happens before any `tx.update`/`logChange`/`applyShipmentCostChange` call — not just that the test's before/after row counts happened to match.
2. **`applyShipmentCostChange`'s extraction is behavior-preserving**: diff the final `correctShipmentLandedCost` against its pre-extraction form (available via `git show` on Task 2's commit) and confirm no logic was dropped or reordered beyond the mechanical move.
3. **The caller's real `reasonCategory` vs. hardcoded `"data_correction"` split** — re-read the final `server/shipments.ts` and confirm `recordShipmentCosts`'s post-arrival branch's `change_log` entries carry the caller's `opts.reasonCategory` while every `inventory_ledger` correction row (via `correctLedgerReceipt`) still hardcodes `"data_correction"`, exactly as the Global Constraints require — this is easy to get backwards during a refactor.
4. **`lockShipmentCosts` and `recordShipmentCosts`'s locked-check read the same column consistently** — no race where one reads a stale value within its own transaction (both should read `shipment.costsLockedAt` fresh inside their own `db.transaction`, not from a value captured outside it).
5. **UI copy audit**: grep `ShipmentsPage.tsx`'s new/modified lines for "error"/"mistake"/"wrong" — this codebase's established copy convention (Stream M) requires neutral language throughout correction-adjacent UI, and the lock/unlock language should read as a deliberate business action, not a failure state.

If the final whole-branch review returns findings, dispatch ONE fix subagent with the complete findings list, then one scoped re-review, per this project's established process. Then push per the established `gh auth switch` dance (`gh auth switch --user Artem-SCM-AI`, push, `gh auth switch --user ArtemTucann`), and update:
- `docs/BACKLOG.md` — the relevant bullet under section I currently bundles two items together ("freight/duty can still be edited after a shipment has already arrived, permanently desyncing the ledger... nightly export still has no row bound..."). Split it: mark the freight/duty half done (reference this stream), leave the nightly-export-row-bound half open exactly as it is today — this stream does not touch it.
- `docs/BUILD-HISTORY.md` — a new dated section narrating this stream, matching every prior stream's format.
- `README.md`'s Current Status section and test count (currently 410/411 — confirm the real final count after this stream's tests land, and check whether the pre-existing 1 failing/skipped test is still the same one, unrelated to this work).
- `hot-accommerce.md` — per this workspace's Session Protocol, update Current Focus and add a Recent Sessions entry once this stream ships.
