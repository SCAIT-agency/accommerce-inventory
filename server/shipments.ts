import { eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { shipments, shipmentLineItems, type Shipment, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
import { logChange, type ReasonCategory } from "./changeLog";

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
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  await db.update(shipments).set({ plannedDepartDate: newDate }).where(eq(shipments.id, id));
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "plannedDepartDate",
    oldValue: shipment.plannedDepartDate?.toISOString() ?? null,
    newValue: newDate.toISOString(),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
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
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment) {
    throw new Error(`updateShipmentStatus: no shipment found with id ${id}`);
  }
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

export async function markShipmentDeparted(id: number, actualDate: Date, opts: { changedBy: number }) {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id));
  if (!shipment) {
    throw new Error(`markShipmentDeparted: no shipment found with id ${id}`);
  }
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
    oldValue: shipment.actualDepartDate?.toISOString() ?? null,
    newValue: actualDate.toISOString(),
    changedBy: opts.changedBy,
  });
}

export async function recordShipmentCosts(
  id: number,
  costs: { freightCost: string; dutyCost: string; costCurrency: string },
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
): Promise<Shipment> {
  const [before] = await db.select().from(shipments).where(eq(shipments.id, id));
  await db.update(shipments).set(costs).where(eq(shipments.id, id));

  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "freightCost",
    oldValue: before.freightCost,
    newValue: costs.freightCost,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
  await logChange({
    entityType: "shipment",
    entityId: id,
    field: "dutyCost",
    oldValue: before.dutyCost,
    newValue: costs.dutyCost,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });

  const [row] = await db.select().from(shipments).where(eq(shipments.id, id));
  return row;
}

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
