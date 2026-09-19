import { eq } from "drizzle-orm";
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
    if (shipment.costCurrency != null && poLine.currency !== shipment.costCurrency) {
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
