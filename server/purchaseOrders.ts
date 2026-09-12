import { eq } from "drizzle-orm";
import { db } from "./dbClient";
import { purchaseOrders, poLineItems, PO_STATUSES, type PurchaseOrder } from "../drizzle/schema";
import { logChange, type ReasonCategory } from "./changeLog";

const VALID_TRANSITIONS: Record<(typeof PO_STATUSES)[number], (typeof PO_STATUSES)[number][]> = {
  draft: ["confirmed"],
  confirmed: ["in_production"],
  in_production: ["shipped"],
  shipped: ["customs"],
  customs: ["delivered"],
  delivered: ["closed"],
  closed: [],
};

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

export async function getPurchaseOrderWithLineItems(id: number) {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  const lineItems = await db.select().from(poLineItems).where(eq(poLineItems.poId, id));
  return { ...po, lineItems };
}

export async function listPurchaseOrders() {
  return db.select().from(purchaseOrders);
}

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

export async function updatePurchaseOrderPlannedReadyDate(
  id: number,
  newDate: Date,
  opts: { reasonCategory: ReasonCategory; reasonNote?: string; changedBy: number },
) {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  await db.update(purchaseOrders).set({ plannedReadyDate: newDate }).where(eq(purchaseOrders.id, id));
  await logChange({
    entityType: "purchase_order",
    entityId: id,
    field: "plannedReadyDate",
    oldValue: po.plannedReadyDate?.toISOString() ?? null,
    newValue: newDate.toISOString(),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
}
