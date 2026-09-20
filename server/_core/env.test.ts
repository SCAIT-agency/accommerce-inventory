import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("ENV", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws if DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    process.env.SESSION_SECRET = "x".repeat(32);
    await expect(async () => {
      const mod = await import("./env");
      mod.loadEnv();
    }).rejects.toThrow(/DATABASE_URL/);
  });

  it("loads all required vars when present", async () => {
    process.env.DATABASE_URL = "mysql://user:pass@localhost:4000/accommerce";
    process.env.SESSION_SECRET = "x".repeat(32);
    process.env.PORT = "3000";
    const mod = await import("./env");
    const env = mod.loadEnv();
    expect(env.databaseUrl).toBe("mysql://user:pass@localhost:4000/accommerce");
    expect(env.port).toBe(3000);
  });
});
