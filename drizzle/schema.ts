import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

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

export const skus = mysqlTable("skus", {
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
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  isBundle: boolean("isBundle").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
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
  status: mysqlEnum("status", PO_STATUSES).default("draft").notNull(),
  plannedReadyDate: timestamp("plannedReadyDate"),
  notes: text("notes"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const poLineItems = mysqlTable("po_line_items", {
  id: int("id").autoincrement().primaryKey(),
  poId: int("poId").notNull(),
  skuId: int("skuId").notNull(),
  qty: int("qty").notNull(),
  unitPrice: varchar("unitPrice", { length: 32 }).notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PoLineItem = typeof poLineItems.$inferSelect;
