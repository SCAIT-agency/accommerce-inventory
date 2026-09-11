import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("session token", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = "mysql://user:pass@localhost:3306/accommerce_test";
    process.env.SESSION_SECRET = "x".repeat(32);
    process.env.APP_PASSWORD = "test-password";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round-trips a valid user id and role", async () => {
    const { createSessionToken, verifySessionToken } = await import(`./auth?t=${Date.now()}`);
    const token = await createSessionToken(7, "editor");
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ userId: 7, role: "editor" });
  });

  it("rejects a tampered token", async () => {
    const { createSessionToken, verifySessionToken } = await import(`./auth?t=${Date.now()}`);
    const token = await createSessionToken(7, "editor");
    const tampered = token.slice(0, -2) + "xx";
    await expect(verifySessionToken(tampered)).rejects.toThrow();
  });
});
