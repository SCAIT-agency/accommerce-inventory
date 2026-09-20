import { eq, inArray } from "drizzle-orm";
import { db } from "./dbClient";
import { shipments, shipmentLineItems, poLineItems } from "../drizzle/schema";

/**
 * unitCost must already be expressed in the instance's single reporting
 * currency — multi-currency PO components (EXW in USD/CNY, freight in EUR)
 * are converted to base currency by the caller before this function runs.
 * See spec "Open Questions — Multi-currency landed cost aggregation":
 * the conversion strategy itself is not yet decided; this function only
 * documents where that decision must land.
 */
export interface LandedBatch {
  qty: number;
  unitCost: number;
  date: Date;
}

export interface SaleEvent {
  qty: number;
  date: Date;
}

export interface FifoCogsResult {
  totalCogs: number;
  remainingBatches: LandedBatch[];
}

export function computeFifoCogs(receipts: LandedBatch[], saleEvents: SaleEvent[]): FifoCogsResult {
  const sortedReceipts = [...receipts].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedSales = [...saleEvents].sort((a, b) => a.date.getTime() - b.date.getTime());

  const batches = sortedReceipts.map((r) => ({ ...r }));
  let totalCogs = 0;

  for (const sale of sortedSales) {
    let remainingToConsume = sale.qty;
    while (remainingToConsume > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= sale.date);
      if (!batch) {
        throw new Error(`insufficient stock: cannot consume ${remainingToConsume} units for sale on ${sale.date.toISOString()}`);
      }
      const consumed = Math.min(batch.qty, remainingToConsume);
      totalCogs += consumed * batch.unitCost;
      batch.qty -= consumed;
      remainingToConsume -= consumed;
    }
  }

  return {
    totalCogs,
    remainingBatches: batches.filter((b) => b.qty > 0),
  };
}

/**
 * Per-SKU landed unit cost for a shipment: PO line unit price (EXW) plus this
 * line's weight/value share of the shipment's total freight/duty cost.
 * Same single-reporting-currency assumption as computeFifoCogs above — the
 * PO line's unitPrice/currency and the shipment's costCurrency must already
 * match the caller's base currency.
 */
export async function getShipmentLandedUnitCost(
  shipmentId: number,
): Promise<{ lineItemId: number; skuId: number; landedUnitCost: number }[]> {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
  const lines = await db.select().from(shipmentLineItems).where(eq(shipmentLineItems.shipmentId, shipmentId));

  const freightCost = parseFloat(shipment.freightCost ?? "0");
  const dutyCost = parseFloat(shipment.dutyCost ?? "0");

  // weightShare/valueShare are freeform decimal strings at input time —
  // validate them here, the one place every consumer (dashboards, and the
  // ledger receipt this feeds at arrival) goes through, rather than trusting
  // the write path. A non-numeric or out-of-range share would otherwise
  // propagate as NaN into `landedUnitCost` below and, via markShipmentArrived,
  // be written permanently into inventory_ledger.unitCost — there is no
  // reversal path for a corrupted ledger row anywhere in this codebase.
  const SHARE_SUM_TOLERANCE = 0.001;
  const weightShares = new Map<number, number>();
  const valueShares = new Map<number, number>();
  for (const line of lines) {
    const weightShare = parseFloat(line.weightShare);
    const valueShare = parseFloat(line.valueShare);
    if (!Number.isFinite(weightShare) || weightShare < 0 || weightShare > 1) {
      throw new Error(
        `getShipmentLandedUnitCost: shipment ${shipmentId} line item ${line.id} has an invalid weightShare "${line.weightShare}" — must be a number between 0 and 1`,
      );
    }
    if (!Number.isFinite(valueShare) || valueShare < 0 || valueShare > 1) {
      throw new Error(
        `getShipmentLandedUnitCost: shipment ${shipmentId} line item ${line.id} has an invalid valueShare "${line.valueShare}" — must be a number between 0 and 1`,
      );
    }
    weightShares.set(line.id, weightShare);
    valueShares.set(line.id, valueShare);
  }
  if (lines.length > 0) {
    const weightShareSum = [...weightShares.values()].reduce((a, b) => a + b, 0);
    const valueShareSum = [...valueShares.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(weightShareSum - 1) > SHARE_SUM_TOLERANCE) {
      throw new Error(
        `getShipmentLandedUnitCost: shipment ${shipmentId}'s line items' weightShare sums to ${weightShareSum}, not 1 — freight would be mis-allocated`,
      );
    }
    if (Math.abs(valueShareSum - 1) > SHARE_SUM_TOLERANCE) {
      throw new Error(
        `getShipmentLandedUnitCost: shipment ${shipmentId}'s line items' valueShare sums to ${valueShareSum}, not 1 — duty would be mis-allocated`,
      );
    }
  }

  // One query for every line's PO line item, instead of one query per line —
  // this is bounded by a single shipment's own line count (not SKU count
  // across the whole catalog), but it's the same N+1 shape the rest of this
  // stream closed elsewhere, and it's reachable from a dashboard.
  const poLineIds = lines.map((line) => line.poLineItemId);
  const poLinesById = new Map(
    poLineIds.length === 0
      ? []
      : (await db.select().from(poLineItems).where(inArray(poLineItems.id, poLineIds))).map((pl) => [pl.id, pl]),
  );

  const results = [];
  for (const line of lines) {
    if (line.qty <= 0) {
      throw new Error(`shipment line item ${line.id} has invalid qty ${line.qty}, cannot compute landed unit cost`);
    }
    const poLine = poLinesById.get(line.poLineItemId);
    if (!poLine) {
      throw new Error(`getShipmentLandedUnitCost: no PO line item found with id ${line.poLineItemId} (shipment ${shipmentId}, line item ${line.id})`);
    }
    // Currency codes are freeform text at input time (no enum/normalization
    // at write time) — compare case-insensitively so "usd" vs "USD" isn't
    // treated as a real mismatch; a genuine mismatch (e.g. USD vs EUR) still
    // throws regardless of casing on either side.
    if (shipment.costCurrency != null && poLine.currency.toUpperCase() !== shipment.costCurrency.toUpperCase()) {
      throw new Error(
        `getShipmentLandedUnitCost: currency mismatch on shipment ${shipmentId}, line item ${line.id} — ` +
        `PO line currency is "${poLine.currency}" but shipment cost currency is "${shipment.costCurrency}"; ` +
        `landed cost cannot be computed across mismatched currencies`,
      );
    }
    const exwTotal = parseFloat(poLine.unitPrice) * line.qty;
    const allocatedFreight = freightCost * weightShares.get(line.id)!;
    const allocatedDuty = dutyCost * valueShares.get(line.id)!;
    const landedUnitCost = (exwTotal + allocatedFreight + allocatedDuty) / line.qty;
    if (!Number.isFinite(landedUnitCost)) {
      throw new Error(`getShipmentLandedUnitCost: computed a non-finite landedUnitCost for shipment ${shipmentId} line item ${line.id} — refusing to write this into the ledger`);
    }
    results.push({ lineItemId: line.id, skuId: line.skuId, landedUnitCost });
  }
  return results;
}
