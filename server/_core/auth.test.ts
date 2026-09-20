// server/_core/auth.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("session token", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = "mysql://user:pass@localhost:3306/accommerce_test";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round-trips a valid user id, role, and token version", async () => {
    const { createSessionToken, verifySessionToken } = await import("./auth");
    const token = await createSessionToken(7, "editor", 3);
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ userId: 7, role: "editor", tokenVersion: 3 });
  });

  it("rejects a tampered token", async () => {
    const { createSessionToken, verifySessionToken } = await import("./auth");
    const token = await createSessionToken(7, "editor", 0);
    const tampered = token.slice(0, -2) + "xx";
    await expect(verifySessionToken(tampered)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { verifySessionToken } = await import("./auth");
    const { SignJWT } = await import("jose");
    const secretKey = new TextEncoder().encode(process.env.SESSION_SECRET);
    const expiredToken = await new SignJWT({ userId: 7, role: "editor", tokenVersion: 0 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secretKey);
    await expect(verifySessionToken(expiredToken)).rejects.toThrow();
  });
});
