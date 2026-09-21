import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { inventoryLedger, type InsertLedgerEvent, type LedgerEvent } from "../drizzle/schema";
import { getAppSetting } from "./db";

/**
 * Per-instance policy: when set to "true", sales may drive SOH negative
 * (backorders — Jello launched on them, and its Daily COGS prices them
 * retroactively from the batch that later lands). Absent or any other value
 * keeps the strict guard, which stays the default for every instance.
 */
export const ALLOW_BACKORDERS_SETTING = "allow_backorders";

/**
 * `allowNegativeSoh` bypasses the negative-stock guard for this one call only
 * (defaults to false — today's behavior exactly). It exists for
 * correctLedgerReceipt's documented escape hatch, where an operator has
 * reviewed a correction that cannot be absorbed by real stock and decided to
 * record it anyway; the instance-wide `allow_backorders` setting would be the
 * wrong tool, since flipping it would silently permit backorders everywhere.
 */
export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">, dbClient: DbClient = db, allowNegativeSoh = false) {
  // Known, accepted TOCTOU race: the SOH check below and the insert after it
  // are not atomic against another concurrent write for the same SKU/
  // warehouse — two negative-qty events checked in parallel could each see
  // the same pre-write SOH and both pass, together driving it negative. Not
  // fixed: this is a single-operator system with no concurrent-write path in
  // practice today (the daily Shopify pull and manual entry aren't run
  // concurrently against the same SKU/warehouse), and a real fix (a
  // SELECT ... FOR UPDATE or a DB-level CHECK constraint) is more machinery
  // than the actual risk currently justifies. Revisit if a second writer
  // (e.g. a second operator, or a concurrent import) is ever introduced.
  if (event.qty < 0) {
    // Same-day ledger events have no reliable sub-day insertion order: a
    // whole-day sales aggregate (recordSalesActual) anchors at end-of-day,
    // while a receipt or manual correction keeps its true wall-clock time.
    // Evaluating solvency as of the END of this event's own calendar day
    // (not its exact timestamp) makes every same-day event visible to every
    // other same-day event's guard check, regardless of insertion order.
    const asOfDate = endOfDayUtc(event.date);
    const currentSoh = await getSoh(event.skuId, event.warehouseId, asOfDate, dbClient);
    if (currentSoh + event.qty < 0 && !allowNegativeSoh && (await getAppSetting(ALLOW_BACKORDERS_SETTING)) !== "true") {
      throw new Error(
        `recordLedgerEvent: this event would drive SOH negative for sku ${event.skuId}/warehouse ${event.warehouseId} ` +
        `(current: ${currentSoh}, event qty: ${event.qty}) — refusing to write`,
      );
    }
  }
  await dbClient.insert(inventoryLedger).values(event);
}

function endOfDayUtc(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999Z`);
}

export async function getSoh(skuId: number, warehouseId: number, asOfDate?: Date, dbClient: DbClient = db): Promise<number> {
  const conditions = [eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)];
  if (asOfDate) conditions.push(lte(inventoryLedger.date, asOfDate));

  const [row] = await dbClient
    .select({ total: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)` })
    .from(inventoryLedger)
    .where(and(...conditions));
  return row?.total ?? 0;
}

export async function getSohForSkus(skuIds: number[]): Promise<Map<number, { warehouseId: number; soh: number }[]>> {
  const result = new Map<number, { warehouseId: number; soh: number }[]>();
  if (skuIds.length === 0) return result;

  const rows = await db
    .select({
      skuId: inventoryLedger.skuId,
      warehouseId: inventoryLedger.warehouseId,
      soh: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)`,
    })
    .from(inventoryLedger)
    .where(inArray(inventoryLedger.skuId, skuIds))
    .groupBy(inventoryLedger.skuId, inventoryLedger.warehouseId);

  for (const row of rows) {
    const existing = result.get(row.skuId) ?? [];
    existing.push({ warehouseId: row.warehouseId, soh: row.soh });
    result.set(row.skuId, existing);
  }
  return result;
}

export interface RemainingBatch {
  batchDate: Date;
  sourceRef: string | null;
  unitCost: number;
  remainingQty: number;
}

export interface FifoBatch {
  qty: number;
  unitCost: number;
  date: Date;
  sourceRef: string | null;
}

// Shared FIFO replay primitive used by getRemainingBatches (below) and by
// getDailyCogsForRange (server/salesPlan.ts) — previously two separate,
// drifting implementations of the exact same consume() loop. onSaleConsumed
// fires only for "sale" events, not adjustments: an adjustment consumes FIFO
// stock like a sale (a write-off/correction) but must never be counted as
// Daily COGS, since it isn't a sale.
export function replayLedgerEventsFifo(
  events: LedgerEvent[],
  onSaleConsumed?: (event: LedgerEvent, consumedCost: number) => void,
  onAdjustmentConsumed?: (event: LedgerEvent, consumedCost: number, touchedSourceRefs: Set<string | null>) => void,
): FifoBatch[] {
  const batches: FifoBatch[] = [];

  const consume = (qtyToConsume: number, asOfDate: Date, context: string): { consumedCost: number; touchedSourceRefs: Set<string | null> } => {
    let remaining = qtyToConsume;
    let consumedCost = 0;
    const touchedSourceRefs = new Set<string | null>();
    while (remaining > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= asOfDate);
      if (!batch) throw new Error(`replayLedgerEventsFifo: insufficient stock to consume ${remaining} units for ${context}`);
      const consumed = Math.min(batch.qty, remaining);
      consumedCost += consumed * batch.unitCost;
      touchedSourceRefs.add(batch.sourceRef);
      batch.qty -= consumed;
      remaining -= consumed;
    }
    return { consumedCost, touchedSourceRefs };
  };

  for (const event of events) {
    if (event.eventType === "receipt") {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    } else if (event.eventType === "sale") {
      const { consumedCost } = consume(Math.abs(event.qty), event.date, `sale event ${event.id}`);
      onSaleConsumed?.(event, consumedCost);
    } else if (event.qty < 0) {
      const { consumedCost, touchedSourceRefs } = consume(Math.abs(event.qty), event.date, `adjustment event ${event.id}`);
      onAdjustmentConsumed?.(event, consumedCost, touchedSourceRefs);
    } else if (event.qty > 0) {
      batches.push({ qty: event.qty, unitCost: parseFloat(event.unitCost ?? "0"), date: event.date, sourceRef: event.sourceRef });
    }
  }

  return batches;
}

// Known ordering asymmetry: recordLedgerEvent's negative-stock guard
// evaluates solvency as of END OF DAY (see endOfDayUtc above), so same-day
// events are mutually visible to each other's guard check regardless of
// insertion order — but the query below orders strictly by timestamp (with
// id as a same-timestamp tiebreaker). A negative adjustment timestamped
// earlier in the same day than its covering receipt would pass the guard but
// could then make this function throw "insufficient stock".
//
// A live "adjustment" write path now exists: correctLedgerReceipt (below)
// writes a reversal adjustment dated `new Date()`. The risk is NOT dormant
// any more, but that function defends itself and the rest of this file
// against it: before committing, it replays the SKU/warehouse's full history
// through replayLedgerEventsFifo exactly as this function does, and refuses
// the whole correction (rolling back both appended rows) if its own reversal
// cannot be covered by FIFO stock available at its own timestamp. So a
// correction can never newly leave this function throwing — it fails loudly
// at write time instead, with a message naming the allowNegativeSoh escape
// hatch.
//
// Two paths still lead past that refusal, and both leave this function (and
// getDailyCogsForRange) throwing for that SKU until the underlying over-sale
// is itself resolved — which is out of the correction design's scope:
//   1. allowNegativeSoh: true — an operator explicitly recording a reversal
//      that real stock cannot cover, driving SOH negative on purpose.
//   2. A SKU whose history ALREADY failed to replay before the correction ran
//      (an instance running with allow_backorders accumulates these). The
//      correction is not refused there, because it is not what broke the
//      replay and refusing would make corrections impossible on exactly the
//      data most likely to need them; no allowNegativeSoh is required.
// Neither is a new consequence — it is the same one a backorder instance
// already has today — but both are now reachable on purpose rather than by
// accident. Revisit if any OTHER live
// "adjustment" write path is introduced: it would need the same self-check,
// which nothing in this file forces it to have.
export async function getRemainingBatches(skuId: number, warehouseId: number): Promise<RemainingBatch[]> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date, inventoryLedger.id);

  const batches = replayLedgerEventsFifo(events);

  return batches
    .filter((b) => b.qty > 0)
    .map((b) => ({ batchDate: b.date, sourceRef: b.sourceRef, unitCost: b.unitCost, remainingQty: b.qty }))
    .sort((a, b) => a.batchDate.getTime() - b.batchDate.getTime());
}

export interface LedgerCorrectionResult {
  reversalId: number;
  correctedId: number;
  // true iff the reversal's FIFO consumption reached stock that did NOT come
  // from the batch being corrected — either because that batch had already
  // been partly or fully sold through, or because FIFO's oldest-first order
  // put an older batch in front of it. Also true when the reversal could not
  // be covered at all — reachable only with allowNegativeSoh, or on a SKU
  // whose history already failed to replay before this correction.
  // Forward-only by design (see docs/2026-09-21-reversal-correction-paths-design.md §4):
  // past Daily COGS is never recalculated, even when this is true.
  //
  // Batches are identified by sourceRef, so two receipts sharing one
  // sourceRef (the same shipment's two line items for one SKU — the case
  // §3 of that design describes) read as one batch here and report false
  // when the reversal crosses between them. That under-reports a caveat
  // toast; it never mis-writes the ledger.
  consumedFromOtherBatches: boolean;
}

// inventoryLedger.unitCost is decimal(18,8): 18 digits of precision, 8 of
// scale (decimal places). Both ends of a no-op comparison therefore have to
// be normalized to THAT scale, not to whatever scale each side happens to be
// written at — the column round-trips "1.00" as "1.00000000" (a trailing-zero
// difference) and rounds "10.000000001" to "10.00000000" (a sub-scale
// difference, invisible to trailing-zero stripping alone). Either one slipping
// through writes a correction pair that changes no stored value, which is NOT
// harmless: the reversal consumes FIFO stock oldest-first and the replacement
// lands as a new batch dated today, reshuffling which cost future sales draw.
//
// Rounds through BigInt rather than parseFloat so the comparison stays exact
// across the column's full 18 digits, well past what a double represents, and
// matches MySQL's own round-half-away-from-zero at the column's scale.
const LEDGER_UNIT_COST_SCALE = 8;
const PLAIN_DECIMAL_LITERAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

function normalizeDecimalForComparison(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const match = PLAIN_DECIMAL_LITERAL.exec(trimmed);
  // Not a plain decimal literal (so not something this column can store as
  // written): compare it verbatim rather than inventing a normalization.
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return trimmed;

  const intDigits = match[2] === "" ? "0" : match[2];
  const fracDigits = match[3] ?? "";
  const keptFrac = fracDigits.slice(0, LEDGER_UNIT_COST_SCALE).padEnd(LEDGER_UNIT_COST_SCALE, "0");
  let scaled = BigInt(intDigits + keptFrac);
  if (fracDigits.length > LEDGER_UNIT_COST_SCALE && Number(fracDigits[LEDGER_UNIT_COST_SCALE]) >= 5) {
    scaled += 1n; // magnitude-only, so this rounds away from zero for either sign
  }
  if (scaled === 0n) return "0"; // collapses "-0.00000000" and "0" to one form

  const digits = scaled.toString().padStart(LEDGER_UNIT_COST_SCALE + 1, "0");
  const normalizedInt = digits.slice(0, digits.length - LEDGER_UNIT_COST_SCALE);
  const normalizedFrac = digits.slice(digits.length - LEDGER_UNIT_COST_SCALE).replace(/0+$/, "");
  const sign = match[1] === "-" ? "-" : "";
  return normalizedFrac ? `${sign}${normalizedInt}.${normalizedFrac}` : `${sign}${normalizedInt}`;
}

function fifoReplayFails(events: LedgerEvent[]): boolean {
  try {
    replayLedgerEventsFifo(events);
    return false;
  } catch {
    return true;
  }
}

/**
 * Forward-only correction of a receipt whose qty and/or unit cost was wrong.
 *
 * Never edits or deletes the original row: appends an offsetting `adjustment`
 * plus a replacement `receipt`, both dated now and both pointing at the
 * original via `correctsEventId`. Consequence, accepted by design: Daily COGS
 * already reported for past days does not change.
 *
 * `reasonCategory` is always the literal "data_correction" — deliberately not
 * a parameter. The schema's enum accepts all 10 REASON_CATEGORIES with no
 * DB-level narrowing, so this function being the sole write path for the
 * correction columns is what actually holds that invariant.
 *
 * Joins the caller's transaction when `dbClient !== db` (same core/wrapper
 * pattern as recordSalesActual), so a wrapper correcting several line items
 * gets all-or-nothing behavior for free.
 */
export async function correctLedgerReceipt(
  eventId: number,
  corrections: { qty?: number; unitCost?: string },
  opts: { changedBy: number; reasonNote: string; allowNegativeSoh?: boolean },
  dbClient: DbClient = db,
): Promise<LedgerCorrectionResult> {
  const write = async (tx: DbClient): Promise<LedgerCorrectionResult> => {
    const [original] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.id, eventId));
    if (!original) {
      throw new Error(`correctLedgerReceipt: no ledger event found with id ${eventId}`);
    }
    if (original.eventType !== "receipt") {
      throw new Error(`correctLedgerReceipt: event ${eventId} is not a receipt — only receipt events can be corrected`);
    }
    // A correction of a correction targets the replacement receipt's own id,
    // never the original's — so this guard can't be worked around by
    // re-submitting the same eventId.
    const [alreadyCorrected] = await tx.select().from(inventoryLedger).where(eq(inventoryLedger.correctsEventId, eventId));
    if (alreadyCorrected) {
      throw new Error(`correctLedgerReceipt: event ${eventId} has already been corrected`);
    }

    // A negative or fractional qty would be written straight into a "receipt"
    // event, where replayLedgerEventsFifo pushes it as a batch it can never
    // consume (it only draws from batches with qty > 0) — permanently
    // breaking the batches-sum-to-SOH invariant. 0 is legitimate ("this
    // shipment never actually arrived").
    if (corrections.qty !== undefined && (!Number.isInteger(corrections.qty) || corrections.qty < 0)) {
      throw new Error(
        `correctLedgerReceipt: corrected qty ${corrections.qty} must be a non-negative whole number of units`,
      );
    }
    // Plain decimal notation only: exponent forms ("1e-9") would sail past
    // the no-op check below, which can only normalize what this column can
    // actually store as written.
    if (corrections.unitCost !== undefined) {
      const costMatch = PLAIN_DECIMAL_LITERAL.exec(corrections.unitCost.trim());
      const hasDigits = costMatch !== null && (costMatch[2] !== "" || (costMatch[3] ?? "") !== "");
      const isNegative = costMatch !== null && costMatch[1] === "-";
      if (!hasDigits || isNegative) {
        throw new Error(
          `correctLedgerReceipt: corrected unitCost "${corrections.unitCost}" must be a non-negative number in plain decimal notation`,
        );
      }
    }
    if (opts.reasonNote.trim() === "") {
      throw new Error(
        `correctLedgerReceipt: reasonNote is required on every correction — event ${eventId} cannot be corrected without a recorded explanation of what changed and why`,
      );
    }

    const finalQty = corrections.qty ?? original.qty;
    const finalUnitCost = corrections.unitCost ?? original.unitCost;
    if (
      finalQty === original.qty &&
      normalizeDecimalForComparison(finalUnitCost) === normalizeDecimalForComparison(original.unitCost)
    ) {
      throw new Error("correctLedgerReceipt: correction changes nothing — refusing to write a no-op correction pair");
    }

    // One timestamp for both rows: the reversal's lower autoincrement id then
    // breaks the tie in every (date, id) replay, so the reversal is always
    // consumed before its replacement is available to consume from.
    const now = new Date();
    await recordLedgerEvent(
      {
        skuId: original.skuId,
        warehouseId: original.warehouseId,
        eventType: "adjustment",
        qty: -original.qty,
        unitCost: original.unitCost,
        date: now,
        sourceRef: original.sourceRef,
        lineItemId: original.lineItemId,
        correctsEventId: eventId,
        changedBy: opts.changedBy,
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
      },
      tx,
      opts.allowNegativeSoh,
    );
    const [reversal] = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.correctsEventId, eventId), eq(inventoryLedger.eventType, "adjustment")));

    await recordLedgerEvent(
      {
        skuId: original.skuId,
        warehouseId: original.warehouseId,
        eventType: "receipt",
        qty: finalQty,
        unitCost: finalUnitCost,
        date: now,
        sourceRef: original.sourceRef,
        lineItemId: original.lineItemId,
        correctsEventId: eventId,
        changedBy: opts.changedBy,
        reasonCategory: "data_correction",
        reasonNote: opts.reasonNote,
      },
      tx,
    );
    const [corrected] = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.correctsEventId, eventId), eq(inventoryLedger.eventType, "receipt")));

    // Replays the whole history the way getRemainingBatches does, with the
    // two new rows in place. Two jobs at once: report which batches the
    // reversal actually drew from, and prove the appended pair leaves a
    // ledger that still replays — see the ordering-asymmetry comment above
    // getRemainingBatches for why the negative-stock guard alone can't.
    const allEvents = await tx
      .select()
      .from(inventoryLedger)
      .where(and(eq(inventoryLedger.skuId, original.skuId), eq(inventoryLedger.warehouseId, original.warehouseId)))
      .orderBy(inventoryLedger.date, inventoryLedger.id);

    let consumedFromOtherBatches = false;
    let reversalReplayed = false;
    try {
      replayLedgerEventsFifo(allEvents, undefined, (event, _cost, touchedSourceRefs) => {
        if (event.id === reversal.id) {
          reversalReplayed = true;
          consumedFromOtherBatches = [...touchedSourceRefs].some((ref) => ref !== original.sourceRef);
        }
      });
    } catch (err) {
      // Distinguish "this correction broke the replay" from "this SKU's
      // history already couldn't replay" (an instance running with
      // allow_backorders has such SKUs today) — refusing the latter would
      // make corrections impossible on exactly the data most likely to need
      // them, and the negative-stock guard above already ruled on solvency.
      const historyAlreadyFailed = fifoReplayFails(
        allEvents.filter((e) => e.id !== reversal.id && e.id !== corrected.id),
      );
      if (!historyAlreadyFailed && !opts.allowNegativeSoh) {
        // Deliberately not framed as "the reversal's own coverage failed":
        // the replay can also die on a LATER event that this correction's
        // reversal starved downstream. The inner message names whichever
        // event actually ran out.
        throw new Error(
          `correctLedgerReceipt: correcting event ${eventId} (reversing ${original.qty} units for sku ${original.skuId}/` +
          `warehouse ${original.warehouseId}) leaves this SKU's FIFO history unreplayable (${(err as Error).message}) — ` +
          "pass allowNegativeSoh to record the correction anyway",
        );
      }
      // If the replay never got as far as the reversal, or died on it, the
      // reversal demonstrably could not be absorbed by the corrected batch's
      // own remaining stock — the caller's warning applies. If it died on a
      // LATER event, the callback already reported the reversal's real
      // batches; keep that answer rather than overstating it.
      if (!reversalReplayed) consumedFromOtherBatches = true;
    }

    return { reversalId: reversal.id, correctedId: corrected.id, consumedFromOtherBatches };
  };

  if (dbClient === db) {
    return db.transaction(write);
  }
  return write(dbClient);
}
