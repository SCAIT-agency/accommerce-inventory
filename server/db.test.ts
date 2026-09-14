import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { skus, vendors, warehouses } from "../drizzle/schema";
import { createSku, listSkus, createVendor, createWarehouse, setAppSetting, getAppSetting } from "./db";

beforeEach(async () => {
  // Real FKs now tie skus/warehouses to other tables, but each test file only
  // cleans its own tables at the start of each test (no afterAll anywhere in
  // this suite) — so a row left by another file's last test can otherwise
  // block these deletes regardless of order. Disabling FK checks for the
  // cleanup makes this file's reset order-independent again.
  //
  // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
  // deletes, and the toggle-on all land on the same pooled connection from
  // `db` (mysql.createPool). A real db.transaction pins one connection for
  // its whole duration, which is exactly the guarantee this needs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(skus);
      await tx.delete(vendors);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("catalog repository", () => {
  it("creates a SKU with a chosen primary identifier and active status by default", async () => {
    const sku = await createSku({
      sku: "JELLO-CAL-500",
      name: "Jello Calm Cocktail 500ml",
      primaryIdentifierType: "sku",
    });
    expect(sku.status).toBe("active");
    expect(sku.isBundle).toBe(false);

    const all = await listSkus();
    expect(all).toHaveLength(1);
  });

  it("creates warehouses without any hardcoded count assumption", async () => {
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });
    expect(ff.id).not.toBe(mutual.id);
  });

  it("round-trips app_settings as key/value", async () => {
    await setAppSetting("enabled_modules", JSON.stringify(["stock", "money"]));
    const value = await getAppSetting("enabled_modules");
    expect(JSON.parse(value!)).toEqual(["stock", "money"]);
  });

  it("rejects a second SKU with the same primary identifier value", async () => {
    await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    await expect(createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" })).rejects.toThrow();
  });

  it("allows two SKUs with the same value in a non-primary identifier column", async () => {
    await createSku({ sku: "JELLO-CAL-500", ean: "0000000000001", primaryIdentifierType: "sku" });
    const second = await createSku({ sku: "JELLO-CAL-600", ean: "0000000000001", primaryIdentifierType: "sku" });
    expect(second.id).toBeGreaterThan(0);
  });

  it("rejects a SKU with no value in the primary identifier column", async () => {
    await expect(createSku({ primaryIdentifierType: "sku" })).rejects.toThrow();
  });
});
