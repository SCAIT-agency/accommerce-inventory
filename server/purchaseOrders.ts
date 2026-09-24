import { eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
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

export async function createPurchaseOrder(input: CreatePoInput, dbClient: DbClient = db): Promise<PurchaseOrder> {
  const [result] = await dbClient.insert(purchaseOrders).values({
    poNumber: input.poNumber,
    vendorId: input.vendorId,
    vendorReference: input.vendorReference,
    status: input.initialStatus ?? "draft",
    createdBy: input.createdBy,
  });
  if (input.lineItems.length > 0) {
    await dbClient.insert(poLineItems).values(
      input.lineItems.map((li) => ({ ...li, poId: result.insertId })),
    );
  }
  const [po] = await dbClient.select().from(purchaseOrders).where(eq(purchaseOrders.id, result.insertId));
  return po;
}

export async function getPurchaseOrderWithLineItems(id: number, dbClient: DbClient = db) {
  const [po] = await dbClient.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  if (!po) {
    throw new Error(`getPurchaseOrderWithLineItems: no purchase order found with id ${id}`);
  }
  // Explicit ORDER BY: callers (e.g. migration) zip this array against the
  // original transform-order line items by index — insertion-order return
  // with no ORDER BY is a MySQL convention, not a guarantee.
  const lineItems = await dbClient.select().from(poLineItems).where(eq(poLineItems.poId, id)).orderBy(poLineItems.id);
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

export interface PurchaseOrderLinks {
  contractLink?: string;
  invoiceLink?: string;
  addOnLink?: string;
}

/**
 * Sets external reference links (e.g. Google Drive) on a purchase order.
 * Unaudited: change_log in this codebase is scoped to fields that affect
 * delay or cost, which these don't. Only the fields actually passed are
 * written — an omitted field leaves its current value untouched.
 */
export async function updatePurchaseOrderLinks(
  id: number,
  links: PurchaseOrderLinks,
  dbClient: DbClient = db,
): Promise<PurchaseOrder> {
  const [po] = await dbClient.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  if (!po) {
    throw new Error(`updatePurchaseOrderLinks: no purchase order found with id ${id}`);
  }
  await dbClient.update(purchaseOrders).set(links).where(eq(purchaseOrders.id, id));
  const [updated] = await dbClient.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  return updated;
}

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
