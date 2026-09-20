import { eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import {
  skus,
  vendors,
  warehouses,
  appSettings,
  users,
  type InsertSku,
  type InsertVendor,
  type InsertWarehouse,
  type InsertUser,
} from "../drizzle/schema";

export async function createSku(data: Omit<InsertSku, "id">, dbClient: DbClient = db) {
  const [result] = await dbClient.insert(skus).values(data);
  const [row] = await dbClient.select().from(skus).where(eq(skus.id, result.insertId));
  return row;
}

export async function createUser(data: Omit<InsertUser, "id">, dbClient: DbClient = db) {
  const [result] = await dbClient.insert(users).values(data);
  const [row] = await dbClient.select().from(users).where(eq(users.id, result.insertId));
  return row;
}

export async function listSkus(status?: "active" | "inactive") {
  if (status) return db.select().from(skus).where(eq(skus.status, status));
  return db.select().from(skus);
}

export async function createVendor(data: Omit<InsertVendor, "id">, dbClient: DbClient = db) {
  const [result] = await dbClient.insert(vendors).values(data);
  const [row] = await dbClient.select().from(vendors).where(eq(vendors.id, result.insertId));
  return row;
}

export async function listVendors() {
  return db.select().from(vendors);
}

export async function createWarehouse(data: Omit<InsertWarehouse, "id">, dbClient: DbClient = db) {
  const [result] = await dbClient.insert(warehouses).values(data);
  const [row] = await dbClient.select().from(warehouses).where(eq(warehouses.id, result.insertId));
  return row;
}

export async function listWarehouses() {
  return db.select().from(warehouses);
}

export async function getAppSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row?.value ?? null;
}

export async function setAppSetting(key: string, value: string) {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}
