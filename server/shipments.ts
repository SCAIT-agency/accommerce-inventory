import { eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { shipments, shipmentLineItems, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
import { logChange, normalizeDecimalForAudit, type ReasonCategory } from "./changeLog";
import { recordLedgerEvent } from "./inventoryLedger";
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
