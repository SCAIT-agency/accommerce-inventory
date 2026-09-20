// scripts/reset-password.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword, verifyPassword } from "../server/_core/passwords";
import { resetPassword } from "./resetPassword";

const EMAIL = "julian@accommerce.example";

beforeEach(async () => {
  await db.delete(users);
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
});
