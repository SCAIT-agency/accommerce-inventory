// Constants shared between server and client that must NOT pull in
// drizzle-orm (client/src imports this directly; drizzle-orm/mysql-core is
// server-only weight that has no reason to ship in the browser bundle).
// `drizzle/schema.ts` imports and re-exports REASON_CATEGORIES and
// SKU_IDENTIFIER_TYPES from here so server code can keep importing them from
// the schema module as before.

export const SKU_IDENTIFIER_TYPES = ["sku", "ssku", "asin", "ean", "fnsku", "name"] as const;

export const REASON_CATEGORIES = [
  "production_delay",
  "artwork_delay",
  "customs_hold",
  "logistics_delay",
  "payment_timing",
  "vendor_price_change",
  "freight_rate_change",
  "holiday_capacity",
  "data_correction",
  "other",
] as const;

// Every PRE-EXISTING manual reason-category dropdown (PO status change,
// shipment status/customs/cost changes, transaction matching, etc.) must
// offer this list, never REASON_CATEGORIES itself: "data_correction" is
// reserved for the hardcoded literal correctLedgerReceipt/
// correctShipmentReceiptQty/correctShipmentLandedCost/correctPaymentAmount
// write server-side (see server/payments.ts's doc comment on why that
// literal is what makes a correction distinguishable from an ordinary write
// in change_log) — letting an operator hand-pick it on an ordinary write
// would make that distinction meaningless. The 3 new correction
// procedures/controls (Tasks 8/9) never had a reasonCategory field at all,
// so they don't consume this constant either way.
type ManualReasonCategory = Exclude<(typeof REASON_CATEGORIES)[number], "data_correction">;
// z.enum requires a non-empty TUPLE type ([string, ...string[]]), not a plain
// array -- .filter() alone only narrows the element type, so the result is
// re-asserted into that tuple shape. Safe: REASON_CATEGORIES is a fixed
// literal list, so this can never actually produce an empty array at runtime.
export const MANUAL_REASON_CATEGORIES = REASON_CATEGORIES.filter(
  (c): c is ManualReasonCategory => c !== "data_correction",
) as [ManualReasonCategory, ...ManualReasonCategory[]];
