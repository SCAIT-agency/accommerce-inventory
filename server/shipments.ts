import { eq, and, isNull } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { shipments, shipmentLineItems, inventoryLedger, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
import { logChange, normalizeDecimalForAudit, type ReasonCategory } from "./changeLog";
import { recordLedgerEvent, correctLedgerReceipt, type LedgerCorrectionResult } from "./inventoryLedger";
import { getShipmentLandedUnitCost } from "./landedCost";

const VALID_SHIPMENT_TRANSITIONS: Record<(typeof SHIPMENT_STATUSES)[number], (typeof SHIPMENT_STATUSES)[number][]> = {
  planned: ["departed"],
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};

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

export async function listShipments() {
  return db.select().from(shipments);
}

export async function getShipmentWithLineItems(id: number) {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  const lineItems = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, id));
  return { ...shipment, lineItems };
}

export async function listShipmentsForPo(poLineItemIds: number[]) {
  if (poLineItemIds.length === 0) return [];
  const rows = await db.select().from(shipmentLineItems);
  const matchingShipmentIds = new Set(
    rows.filter((r) => poLineItemIds.includes(r.poLineItemId)).map((r) => r.shipmentId),
  );
  const all = await db.select().from(shipments);
  return all.filter((s) => matchingShipmentIds.has(s.id));
}

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
      // Plain calendar-day string, matching purchase_orders.plannedReadyDate's
      // own change_log format — plannedDepartDate is a calendar-day concept
      // even though the column itself is still `timestamp` (a schema change
      // is out of scope here; this is a cosmetic audit-trail fix only).
      oldValue: shipment.plannedDepartDate?.toISOString().slice(0, 10) ?? null,
      newValue: newDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}

export async function updateShipmentStatus(
  id: number,
  newStatus: (typeof SHIPMENT_STATUSES)[number],
  opts: { changedBy: number; reasonCategory?: ReasonCategory; reasonNote?: string },
): Promise<void> {
  if (newStatus === "departed") {
    throw new Error(
      "updateShipmentStatus: cannot transition to 'departed' via this function — use markShipmentDeparted, " +
      "which also records the actual depart date and enforces the planned-depart-date precondition.",
    );
  }
  if (newStatus === "delivered") {
    throw new Error(
      "updateShipmentStatus: cannot transition to 'delivered' via this function — use markShipmentArrived, " +
      "which also records the inventory ledger receipt and enforces the recorded-costs precondition.",
    );
  }
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`updateShipmentStatus: no shipment found with id ${id}`);
    }
    if (!VALID_SHIPMENT_TRANSITIONS[shipment.status].includes(newStatus)) {
      throw new Error(`invalid transition from ${shipment.status} to ${newStatus}`);
    }
    await tx.update(shipments).set({ status: newStatus }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "status",
      oldValue: shipment.status,
      newValue: newStatus,
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}

export async function markShipmentDeparted(id: number, actualDate: Date, opts: { changedBy: number }) {
  await db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) {
      throw new Error(`markShipmentDeparted: no shipment found with id ${id}`);
    }
    if (!shipment.plannedDepartDate) {
      throw new Error("cannot mark departed: no planned depart date set");
    }
    if (!VALID_SHIPMENT_TRANSITIONS[shipment.status].includes("departed")) {
      throw new Error(`invalid transition from ${shipment.status} to departed`);
    }
    await tx
      .update(shipments)
      .set({ actualDepartDate: actualDate, status: "departed" })
      .where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "actualDepartDate",
      // Plain calendar-day string — see updateShipmentPlannedDepartDate's
      // comment above for why.
      oldValue: shipment.actualDepartDate?.toISOString().slice(0, 10) ?? null,
      newValue: actualDate.toISOString().slice(0, 10),
      changedBy: opts.changedBy,
    }, tx);
  });
}

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

    const [row] = await tx.select().from(shipments).where(eq(shipments.id, id));
    return row;
  });
}

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
      entityType: "shipment",
      entityId: id,
      field: "customsStatus",
      oldValue: shipment.customsStatus,
      newValue: newStatus,
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}

export async function markShipmentArrived(
  id: number,
  actualArrivalDate: Date,
  opts: { changedBy: number; reasonCategory: ReasonCategory; reasonNote?: string },
): Promise<void> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment) {
    throw new Error(`markShipmentArrived: no shipment found with id ${id}`);
  }
  if (!VALID_SHIPMENT_TRANSITIONS[shipment.status].includes("delivered")) {
    throw new Error(`markShipmentArrived: invalid transition from ${shipment.status} to delivered`);
  }
  if (shipment.freightCost == null || shipment.dutyCost == null || shipment.costCurrency == null) {
    throw new Error(
      `markShipmentArrived: cannot record receipt for shipment ${id} — freight/duty costs must be recorded first ` +
      `(recordShipmentCosts) so the ledger receipt carries a real landed cost, not a silent EXW-only placeholder`,
    );
  }
  const landedCosts = await getShipmentLandedUnitCost(id);
  const lines = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, id));
  const landedCostByLineItemId = new Map(landedCosts.map((lc) => [lc.lineItemId, lc.landedUnitCost]));

  await db.transaction(async (tx) => {
    await tx.update(shipments).set({ actualArrivalDate, status: "delivered" }).where(eq(shipments.id, id));
    await logChange({
      entityType: "shipment",
      entityId: id,
      field: "actualArrivalDate",
      // Plain calendar-day string — see updateShipmentPlannedDepartDate's
      // comment above for why.
      oldValue: shipment.actualArrivalDate?.toISOString().slice(0, 10) ?? null,
      newValue: actualArrivalDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
    for (const line of lines) {
      const landedUnitCost = landedCostByLineItemId.get(line.id);
      if (landedUnitCost === undefined) {
        throw new Error(`markShipmentArrived: no landed cost computed for sku ${line.skuId} on shipment ${id}`);
      }
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
    }
  });
}

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
      entityType: "shipment",
      entityId: id,
      field: "actualDepartDate",
      // Plain calendar-day string — see updateShipmentPlannedDepartDate's
      // comment above for why.
      oldValue: shipment.actualDepartDate.toISOString().slice(0, 10),
      newValue: newDate.toISOString().slice(0, 10),
      reasonCategory: opts.reasonCategory,
      reasonNote: opts.reasonNote,
      changedBy: opts.changedBy,
    }, tx);
  });
}

/**
 * A receipt is still correctable iff no OTHER row points at it via
 * correctsEventId — exactly the guard correctLedgerReceipt itself enforces.
 *
 * Deliberately NOT filtered on `correctsEventId IS NULL`: a replacement
 * receipt written by a previous correction carries a non-null correctsEventId
 * (pointing back at the event it replaced) while being the line item's
 * current, perfectly correctable receipt. Excluding those would make a second
 * correction of the same line item silently impossible.
 */
async function filterUncorrected(tx: DbClient, candidates: { id: number }[]): Promise<{ id: number }[]> {
  const uncorrected: { id: number }[] = [];
  for (const candidate of candidates) {
    const [alreadyCorrected] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.correctsEventId, candidate.id));
    if (!alreadyCorrected) uncorrected.push(candidate);
  }
  return uncorrected;
}

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
    ));
  const uncorrectedByLineItem = await filterUncorrected(tx, byLineItem);
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
  const uncorrectedBySku = await filterUncorrected(tx, bySku);
  if (uncorrectedBySku.length === 0) {
    throw new Error(`findUncorrectedReceipt: no uncorrected receipt found for shipment ref ${shipmentRef} / line item ${lineItemId}`);
  }
  if (uncorrectedBySku.length > 1) {
    throw new Error(
      `ambiguous: ${uncorrectedBySku.length} uncorrected receipts found for shipment ref ${shipmentRef}, and this shipment predates per-line-item ledger tracking — cannot disambiguate which one is line item ${lineItemId}`,
    );
  }
  return uncorrectedBySku[0];
}

/**
 * Corrects a wrong received quantity by the identifiers a human actually has
 * — the shipment and the line item on it — instead of a raw ledger event id.
 *
 * Resolves that pair to the line item's current, not-yet-corrected receipt
 * (lineItemId first; skuId fallback for receipts written before
 * inventory_ledger carried lineItemId) and delegates to correctLedgerReceipt,
 * inheriting all of its guards: no-op refusal, non-negative whole-unit qty,
 * required reasonNote, the negative-stock guard, and the FIFO-replayability
 * self-check. Runs inside one transaction, so a refusal there leaves no rows
 * behind here either.
 */
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

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
    if (!before) {
      throw new Error(`correctShipmentLandedCost: no shipment found with id ${shipmentId}`);
    }
    await tx.update(shipments).set(updates).where(eq(shipments.id, shipmentId));
    if (updates.freightCost !== undefined) {
      await logChange({
        entityType: "shipment",
        entityId: shipmentId,
        field: "freightCost",
        oldValue: normalizeDecimalForAudit(before.freightCost),
        newValue: normalizeDecimalForAudit(updates.freightCost),
        reasonCategory: "data_correction",
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
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
        changedBy: opts.changedBy,
      }, tx);
    }

    // Reads back through `tx`, so it sees the restated costs above.
    const landedCosts = await getShipmentLandedUnitCost(shipmentId, tx);
    const corrections: LedgerCorrectionResult[] = [];
    for (const lc of landedCosts) {
      const receipt = await findUncorrectedReceipt(tx, before.shipmentRef, lc.lineItemId, lc.skuId);
      // toFixed(8) matches both the ledger column's scale and the exact
      // formatting markShipmentArrived writes, so a restatement that lands on
      // the same cost is recognised as a no-op by correctLedgerReceipt rather
      // than written as a cost-changing correction pair.
      corrections.push(await correctLedgerReceipt(receipt.id, { unitCost: lc.landedUnitCost.toFixed(8) }, opts, tx));
    }
    return { corrections };
  });
}
