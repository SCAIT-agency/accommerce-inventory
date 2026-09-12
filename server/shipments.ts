import { eq } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, type Shipment, SHIPMENT_STATUSES } from "../drizzle/schema";
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
