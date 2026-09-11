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

describe("password-verified token", () => {
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

  it("round-trips a valid token", async () => {
    const { createPasswordVerifiedToken, verifyPasswordVerifiedToken } = await import(`./auth?t=${Date.now()}`);
    const token = await createPasswordVerifiedToken();
    const result = await verifyPasswordVerifiedToken(token);
    expect(result).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const { createPasswordVerifiedToken, verifyPasswordVerifiedToken } = await import(`./auth?t=${Date.now()}`);
    const token = await createPasswordVerifiedToken();
    const tampered = token.slice(0, -2) + "xx";
    const result = await verifyPasswordVerifiedToken(tampered);
    expect(result).toBe(false);
  });

  it("rejects an expired token", async () => {
    const { verifyPasswordVerifiedToken } = await import(`./auth?t=${Date.now()}`);
    const { SignJWT } = await import("jose");
    const secretKey = new TextEncoder().encode(process.env.SESSION_SECRET);
    const expiredToken = await new SignJWT({ passwordVerified: true })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secretKey);
    const result = await verifyPasswordVerifiedToken(expiredToken);
    expect(result).toBe(false);
  });
});
