// scripts/reset-password.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword, verifyPassword } from "../server/_core/passwords";
import { resetPassword } from "./reset-password-core";

const EMAIL = "julian@accommerce.example";

beforeEach(async () => {
  // Real FKs tie other tables to users now (purchase_orders.createdBy,
  // shipments.createdBy, change_log.changedBy) -- a row left behind by
  // another test file's last test (no afterAll anywhere in this suite) can
  // otherwise block this delete regardless of file order. Disabling FK
  // checks for the cleanup makes this file's reset order-independent again.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("resetPassword", () => {
  it("changes the stored password hash and increments tokenVersion", async () => {
    const oldHash = await hashPassword("old password");
    const [result] = await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash: oldHash, tokenVersion: 2 });
    const [before] = await db.select().from(users).where(eq(users.id, result.insertId));

    await resetPassword(EMAIL, "new password");

    const [after] = await db.select().from(users).where(eq(users.id, result.insertId));
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    await expect(verifyPassword("new password", after.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("old password", after.passwordHash)).resolves.toBe(false);
  });

  it("throws for a nonexistent email", async () => {
    await expect(resetPassword("nobody@accommerce.example", "new password")).rejects.toThrow(/no user/i);
  });

  it("resets a password even when the email casing differs from how it was stored", async () => {
    const oldHash = await hashPassword("old password");
    const [result] = await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash: oldHash });

    await resetPassword(EMAIL.toUpperCase(), "new password");

    const [after] = await db.select().from(users).where(eq(users.id, result.insertId));
    await expect(verifyPassword("new password", after.passwordHash)).resolves.toBe(true);
  });
});
