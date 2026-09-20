import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("password hashing", () => {
  it("verifies a correct password against its own hash", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("produces a different hash for the same password each time (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same password", a)).resolves.toBe(true);
    await expect(verifyPassword("same password", b)).resolves.toBe(true);
  });

  it("resolves false immediately for a null stored hash, without throwing", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
  });

  it("resolves false for a malformed stored value instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
  });
});
