// Constants shared between server and client that must NOT pull in
// drizzle-orm (client/src imports this directly; drizzle-orm/mysql-core is
// server-only weight that has no reason to ship in the browser bundle).
// `drizzle/schema.ts` imports and re-exports REASON_CATEGORIES from here so
// server code can keep importing it from the schema module as before.

export const REASON_CATEGORIES = [
  "production_delay",
  "artwork_delay",
  "customs_hold",
  "logistics_delay",
  "payment_timing",
  "vendor_price_change",
  "freight_rate_change",
  "holiday_capacity",
  "other",
] as const;
