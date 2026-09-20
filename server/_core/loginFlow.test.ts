// server/_core/loginFlow.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../dbClient";
import { users } from "../../drizzle/schema";
import { hashPassword } from "./passwords";
import { clearAttempts } from "./loginThrottle";
import { attemptLogin, resolveSession, performLogout } from "./loginFlow";

const EMAIL = "julian@accommerce.example";
const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await db.delete(users);
  clearAttempts(EMAIL);
});

describe("attemptLogin", () => {
  it("succeeds with the correct email and password, returning a usable token", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const [result] = await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });
    const [user] = await db.select().from(users).where(eq(users.id, result.insertId));

    const outcome = await attemptLogin(EMAIL, PASSWORD);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.user).toEqual({ id: user.id, email: EMAIL, role: "viewer" });

    const session = await resolveSession(outcome.token);
    expect(session).toEqual({ userId: user.id, role: "viewer" });
  });

  it("fails with the wrong password", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });

    const outcome = await attemptLogin(EMAIL, "wrong password");
    expect(outcome.ok).toBe(false);
  });

  it("fails for a nonexistent email", async () => {
    const outcome = await attemptLogin("nobody@accommerce.example", PASSWORD);
    expect(outcome.ok).toBe(false);
  });

  it("fails for a user that exists but has no password set", async () => {
    await db.insert(users).values({ email: EMAIL, role: "viewer" });
    const outcome = await attemptLogin(EMAIL, PASSWORD);
    expect(outcome.ok).toBe(false);
  });

  it("locks out after 5 failed attempts, rejecting even the correct password", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });

    for (let i = 0; i < 5; i++) {
      const outcome = await attemptLogin(EMAIL, "wrong password");
      expect(outcome.ok).toBe(false);
    }
    const outcome = await attemptLogin(EMAIL, PASSWORD);
    expect(outcome.ok).toBe(false);
  });
});

describe("resolveSession", () => {
  it("returns null for an undefined token", async () => {
    expect(await resolveSession(undefined)).toBeNull();
  });

  it("returns null for a garbage token", async () => {
    expect(await resolveSession("not-a-real-token")).toBeNull();
  });

  it("returns null once the user's tokenVersion has advanced past the token's", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "editor", passwordHash });
    const outcome = await attemptLogin(EMAIL, PASSWORD);
    if (!outcome.ok) throw new Error("expected success");

    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.email, EMAIL));

    expect(await resolveSession(outcome.token)).toBeNull();
  });
});

describe("performLogout", () => {
  it("invalidates the token it was called with", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });
    const outcome = await attemptLogin(EMAIL, PASSWORD);
    if (!outcome.ok) throw new Error("expected success");

    expect(await resolveSession(outcome.token)).not.toBeNull();
    await performLogout(outcome.token);
    expect(await resolveSession(outcome.token)).toBeNull();
  });

  it("does nothing (no throw) when called with an undefined token", async () => {
    await expect(performLogout(undefined)).resolves.toBeUndefined();
  });
});
