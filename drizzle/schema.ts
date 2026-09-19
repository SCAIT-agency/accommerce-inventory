import { sql, type SQL } from "drizzle-orm";
import { date, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, index, unique } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  role: mysqlEnum("role", ["editor", "viewer"]).notNull(),
  managerId: int("managerId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const appSettings = mysqlTable("app_settings", {
  key: varchar("key", { length: 128 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type AppSetting = typeof appSettings.$inferSelect;

export const skus = mysqlTable(
  "skus",
  {
    id: int("id").autoincrement().primaryKey(),
    sku: varchar("sku", { length: 128 }),
    ssku: varchar("ssku", { length: 128 }),
    asin: varchar("asin", { length: 32 }),
    ean: varchar("ean", { length: 32 }),
    fnsku: varchar("fnsku", { length: 32 }),
    name: varchar("name", { length: 256 }),
    primaryIdentifierType: mysqlEnum("primaryIdentifierType", [
      "sku", "ssku", "asin", "ean", "fnsku", "name",
    ]).notNull(),
    identifierValue: varchar("identifierValue", { length: 256 })
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`case
          when primaryIdentifierType = 'sku' then sku
          when primaryIdentifierType = 'ssku' then ssku
          when primaryIdentifierType = 'asin' then asin
          when primaryIdentifierType = 'ean' then ean
          when primaryIdentifierType = 'fnsku' then fnsku
          else name
        end`,
        { mode: "stored" },
      ),
    status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
    isBundle: boolean("isBundle").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    identifierUnique: unique("sku_identifier_unique").on(table.primaryIdentifierType, table.identifierValue),
  }),
);
export type Sku = typeof skus.$inferSelect;
export type InsertSku = typeof skus.$inferInsert;

export const vendors = mysqlTable("vendors", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  contactEmail: varchar("contactEmail", { length: 320 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Vendor = typeof vendors.$inferSelect;
export type InsertVendor = typeof vendors.$inferInsert;

export const warehouses = mysqlTable("warehouses", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Warehouse = typeof warehouses.$inferSelect;
export type InsertWarehouse = typeof warehouses.$inferInsert;

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

export const changeLog = mysqlTable("change_log", {
  id: int("id").autoincrement().primaryKey(),
  entityType: varchar("entityType", { length: 64 }).notNull(),
  entityId: int("entityId").notNull(),
  field: varchar("field", { length: 128 }).notNull(),
  oldValue: text("oldValue"),
  newValue: text("newValue"),
  reasonCategory: mysqlEnum("reasonCategory", REASON_CATEGORIES),
  reasonNote: text("reasonNote"),
  changedBy: int("changedBy").notNull(),
  changedAt: timestamp("changedAt").defaultNow().notNull(),
});
export type ChangeLogEntry = typeof changeLog.$inferSelect;

export const PO_STATUSES = [
  "draft", "confirmed", "in_production", "shipped", "customs", "delivered", "closed",
] as const;

export const purchaseOrders = mysqlTable("purchase_orders", {
  id: int("id").autoincrement().primaryKey(),
  poNumber: varchar("poNumber", { length: 64 }).notNull().unique(),
  vendorId: int("vendorId").notNull(),
  vendorReference: varchar("vendorReference", { length: 128 }),
  status: mysqlEnum("status", PO_STATUSES).default("draft").notNull(),
  plannedReadyDate: date("plannedReadyDate", { mode: "string" }),
  notes: text("notes"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const poLineItems = mysqlTable("po_line_items", {
  id: int("id").autoincrement().primaryKey(),
  poId: int("poId").notNull().references(() => purchaseOrders.id),
  skuId: int("skuId").notNull().references(() => skus.id),
  qty: int("qty").notNull(),
  unitPrice: varchar("unitPrice", { length: 32 }).notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PoLineItem = typeof poLineItems.$inferSelect;

export const SHIPMENT_STATUSES = ["planned", "departed", "in_transit", "customs", "delivered"] as const;
export const CUSTOMS_STATUSES = ["not_declared", "declared", "held", "cleared"] as const;

export const shipments = mysqlTable("shipments", {
  id: int("id").autoincrement().primaryKey(),
  shipmentRef: varchar("shipmentRef", { length: 64 }).notNull().unique(),
  vendorReference: varchar("vendorReference", { length: 128 }),
  status: mysqlEnum("status", SHIPMENT_STATUSES).default("planned").notNull(),
  customsStatus: mysqlEnum("customsStatus", CUSTOMS_STATUSES).default("not_declared").notNull(),
  customsDeclarationLink: varchar("customsDeclarationLink", { length: 512 }),
  plannedDepartDate: timestamp("plannedDepartDate"),
  actualDepartDate: timestamp("actualDepartDate"),
  plannedArrivalDate: timestamp("plannedArrivalDate"),
  actualArrivalDate: timestamp("actualArrivalDate"),
  /** Total freight/duty for the whole shipment, in `costCurrency` — allocated to
   * individual SKU lines via each shipment_line_items row's weightShare/valueShare.
   * Nullable: not every shipment has a real invoice yet at creation time. */
  freightCost: varchar("freightCost", { length: 32 }),
  dutyCost: varchar("dutyCost", { length: 32 }),
  costCurrency: varchar("costCurrency", { length: 8 }),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Shipment = typeof shipments.$inferSelect;

export const shipmentLineItems = mysqlTable("shipment_line_items", {
  id: int("id").autoincrement().primaryKey(),
  shipmentId: int("shipmentId").notNull().references(() => shipments.id),
  poLineItemId: int("poLineItemId").notNull().references(() => poLineItems.id),
  skuId: int("skuId").notNull().references(() => skus.id),
  qty: int("qty").notNull(),
  weightShare: varchar("weightShare", { length: 16 }).notNull(),
  valueShare: varchar("valueShare", { length: 16 }).notNull(),
});
export type ShipmentLineItem = typeof shipmentLineItems.$inferSelect;

export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  poId: int("poId").references(() => purchaseOrders.id),
  shipmentId: int("shipmentId").references(() => shipments.id),
  sequenceNo: int("sequenceNo").notNull(),
  expectedAmount: varchar("expectedAmount", { length: 32 }).notNull(),
  expectedDate: timestamp("expectedDate").notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  paid: boolean("paid").default(false).notNull(),
  paidAmount: varchar("paidAmount", { length: 32 }),
  paidDate: timestamp("paidDate"),
  fxRate: varchar("fxRate", { length: 16 }),
  baseCurrencyAmount: varchar("baseCurrencyAmount", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Payment = typeof payments.$inferSelect;

export const transactions = mysqlTable("transactions", {
  id: int("id").autoincrement().primaryKey(),
  date: timestamp("date").notNull(),
  amount: varchar("amount", { length: 32 }).notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  fxRate: varchar("fxRate", { length: 16 }).notNull(),
  counterparty: varchar("counterparty", { length: 256 }),
  description: text("description"),
  matchedPaymentId: int("matchedPaymentId").references(() => payments.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Transaction = typeof transactions.$inferSelect;

export const LEDGER_EVENT_TYPES = ["receipt", "sale", "adjustment"] as const;

export const inventoryLedger = mysqlTable(
  "inventory_ledger",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull().references(() => skus.id),
    warehouseId: int("warehouseId").notNull().references(() => warehouses.id),
    eventType: mysqlEnum("eventType", LEDGER_EVENT_TYPES).notNull(),
    qty: int("qty").notNull(),
    unitCost: varchar("unitCost", { length: 32 }),
    // fsp: 3 (millisecond precision) matches what JS Date actually carries.
    // Default second-level precision rounds (not truncates) on insert, which
    // can flip the ordering of two events timestamped milliseconds apart
    // within the same wall-clock second relative to an unrounded query
    // parameter in getSoh's lte() comparison — silently miscomputing SOH.
    date: timestamp("date", { fsp: 3 }).notNull(),
    sourceRef: varchar("sourceRef", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateIdx: index("sku_warehouse_date_idx").on(table.skuId, table.warehouseId, table.date),
  }),
);
export type LedgerEvent = typeof inventoryLedger.$inferSelect;
export type InsertLedgerEvent = typeof inventoryLedger.$inferInsert;

export const salesPlan = mysqlTable("sales_plan", {
  id: int("id").autoincrement().primaryKey(),
  skuId: int("skuId").notNull(),
  warehouseId: int("warehouseId").notNull(),
  periodDate: date("periodDate", { mode: "string" }).notNull(),
  plannedQty: int("plannedQty").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SalesPlanRow = typeof salesPlan.$inferSelect;

export const SALES_ACTUAL_SOURCES = ["shopify_daily_pull", "manual"] as const;

export const salesActuals = mysqlTable(
  "sales_actuals",
  {
    id: int("id").autoincrement().primaryKey(),
    skuId: int("skuId").notNull(),
    warehouseId: int("warehouseId").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    qty: int("qty").notNull(),
    source: mysqlEnum("source", SALES_ACTUAL_SOURCES).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    skuWarehouseDateSourceUnique: unique("sales_actuals_sku_warehouse_date_source_unique").on(
      table.skuId, table.warehouseId, table.date, table.source,
    ),
  }),
);
export type SalesActualRow = typeof salesActuals.$inferSelect;
