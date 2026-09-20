# Security Hardening (Backlog Stream C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared-`APP_PASSWORD`-plus-identity-picker login flow with real per-user credentials, add session revocation, a working sign-out control, and CLI-based user/password provisioning — closing every item in `docs/BACKLOG.md` section C.

**Architecture:** `jose`-signed JWTs stay the session mechanism (they were never the problem). A new `server/_core/passwords.ts` (Node's built-in `crypto.scrypt`, no new dependency) and `server/_core/loginThrottle.ts` (in-process per-email failed-attempt tracking) are pure, dependency-free modules. A new `server/_core/loginFlow.ts` is the single place that touches the DB for auth — `attemptLogin`, `resolveSession`, `performLogout` — consumed by both `server/_core/context.ts` (tRPC) and `server/_core/authRoutes.ts` (plain Express), so session-validity logic (including the new `tokenVersion` revocation check) lives in exactly one place instead of being duplicated across both.

**Tech Stack:** Node's built-in `crypto` module (`scrypt`, `timingSafeEqual`, `randomBytes`) for password hashing — no new npm dependency. Existing `jose`, `drizzle-orm`, `express`, `vitest` stack, unchanged.

**Spec:** `docs/2026-09-20-security-hardening-design.md`

## Global Constraints

- No new npm dependencies. Password hashing uses Node's built-in `crypto.scrypt`; there is no bcrypt/argon2 dependency to add.
- Every schema change requires a clean local dev DB reset (`mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"`) before `pnpm db:push`, and independent verification via `SHOW CREATE TABLE` afterward — never just trust `db:push`'s exit code.
- The full suite (`pnpm test`) must pass after every single task, not just at the end — no task may leave the build in a state where authentication is partially rewired (this is why Task 3 below is one larger task rather than several smaller ones: `auth.ts`'s signature changes and `authRoutes.ts`'s route rewrite are irreducibly coupled at the type level, and splitting them would leave a broken intermediate state).
- `editorProcedure`/`protectedProcedure` in `server/_core/trpc.ts` are NOT touched by this plan — their role enforcement is already correct; every task here only changes how a session gets its identity in the first place.
- Every new/changed auth code path fails closed: a missing, malformed, expired, or revoked token/password is always treated as "not authenticated" or "wrong password" — never as a crash, and never with a response that reveals which specific check failed (see `attemptLogin`'s single generic failure path in Task 3).
- `.env` (gitignored, not committed) is never edited by any task — only `.env.example` (tracked). An existing local `.env` keeping an unused `APP_PASSWORD=...` line after this plan lands is harmless (extra env vars are ignored) and not something any task needs to clean up.

---

### Task 1: Password Hashing

**Files:**
- Create: `server/_core/passwords.ts`
- Test: `server/_core/passwords.test.ts`

**Interfaces:**
- Produces: `hashPassword(plaintext: string): Promise<string>` — returns a string safe to store in the `users.passwordHash` column.
- Produces: `verifyPassword(plaintext: string, stored: string | null): Promise<boolean>` — `stored === null` (a user who was never given a password) always resolves `false` without doing any hash comparison work.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/_core/passwords.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test server/_core/passwords.test.ts`
Expected: FAIL — `./passwords` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// server/_core/passwords.ts
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plaintext: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false;

  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test server/_core/passwords.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add server/_core/passwords.ts server/_core/passwords.test.ts
git commit -m "feat: add scrypt-based password hashing (server/_core/passwords.ts)"
```

---

### Task 2: Failed-Login Throttle

**Files:**
- Create: `server/_core/loginThrottle.ts`
- Test: `server/_core/loginThrottle.test.ts`

**Interfaces:**
- Produces: `isLocked(email: string, now?: number): boolean`
- Produces: `recordFailedAttempt(email: string, now?: number): void`
- Produces: `clearAttempts(email: string): void`
- All three accept an optional `now` (milliseconds since epoch, defaulting to `Date.now()`) purely so tests can control time without mocking global `Date` or sleeping — no other caller in this plan ever passes it explicitly.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/_core/loginThrottle.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { isLocked, recordFailedAttempt, clearAttempts } from "./loginThrottle";

const EMAIL = "julian@accommerce.example";
const OTHER_EMAIL = "andrew@accommerce.example";
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

describe("login throttle", () => {
  beforeEach(() => {
    clearAttempts(EMAIL);
    clearAttempts(OTHER_EMAIL);
  });

  it("is not locked with no prior attempts", () => {
    expect(isLocked(EMAIL)).toBe(false);
  });

  it("locks after 5 failed attempts within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 5000)).toBe(true);
  });

  it("does not lock after only 4 failed attempts", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 4000)).toBe(false);
  });

  it("a different email is unaffected by this email's lockout", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(OTHER_EMAIL, now + 5000)).toBe(false);
  });

  it("clearAttempts lifts a lockout immediately", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 5000)).toBe(true);
    clearAttempts(EMAIL);
    expect(isLocked(EMAIL, now + 5000)).toBe(false);
  });

  it("the counting window resets if 15 minutes pass without hitting 5 attempts", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    // Well past the window, with no 5th attempt yet — the first 4 should no
    // longer count, so one more failure here starts a fresh count of 1.
    recordFailedAttempt(EMAIL, now + WINDOW_MS + 60_000);
    expect(isLocked(EMAIL, now + WINDOW_MS + 60_000)).toBe(false);
  });

  it("a lockout expires after its own 15-minute duration", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    const lockedAt = now + 5000;
    expect(isLocked(EMAIL, lockedAt)).toBe(true);
    expect(isLocked(EMAIL, lockedAt + LOCKOUT_MS + 1)).toBe(false);
  });

  it("a failed attempt during an active lockout does not extend it", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    const lockedAt = now + 5000;
    expect(isLocked(EMAIL, lockedAt)).toBe(true);
    // A retry attempt while already locked must not push the expiry further out.
    recordFailedAttempt(EMAIL, lockedAt + 1000);
    expect(isLocked(EMAIL, lockedAt + LOCKOUT_MS + 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test server/_core/loginThrottle.test.ts`
Expected: FAIL — `./loginThrottle` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// server/_core/loginThrottle.ts
//
// In-process, per-email tracking only — no persistent store. Resets on
// process restart (acceptable at this deployment's scale: infrequent
// restarts, ~4-5 trusted users, no adversary sophisticated enough to time a
// deploy). Per-email rather than per-IP so that legitimate users sharing an
// office network never lock each other out — see the design doc Section 5.
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Entry {
  count: number;
  windowStart: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, Entry>();

export function isLocked(email: string, now: number = Date.now()): boolean {
  const entry = attempts.get(email);
  if (!entry) return false;

  if (entry.lockedUntil !== null) {
    if (now < entry.lockedUntil) return true;
    attempts.delete(email);
    return false;
  }

  if (now - entry.windowStart > WINDOW_MS) {
    attempts.delete(email);
    return false;
  }

  return false;
}

export function recordFailedAttempt(email: string, now: number = Date.now()): void {
  const entry = attempts.get(email);

  if (entry?.lockedUntil !== null && entry?.lockedUntil !== undefined) {
    // Already locked — a retry during lockout must not extend it further,
    // or a scripted retry loop could keep a legitimate user locked out
    // indefinitely.
    if (now < entry.lockedUntil) return;
    attempts.delete(email);
  }

  const current = attempts.get(email);
  if (!current || now - current.windowStart > WINDOW_MS) {
    attempts.set(email, { count: 1, windowStart: now, lockedUntil: null });
    return;
  }

  current.count += 1;
  if (current.count >= MAX_ATTEMPTS) {
    current.lockedUntil = now + LOCKOUT_MS;
  }
}

export function clearAttempts(email: string): void {
  attempts.delete(email);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test server/_core/loginThrottle.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add server/_core/loginThrottle.ts server/_core/loginThrottle.test.ts
git commit -m "feat: add per-email failed-login throttle (server/_core/loginThrottle.ts)"
```

---

### Task 3: Core Login Flow Rewrite

This is the largest task in this plan and is deliberately not split further — `auth.ts`'s signature changes and `authRoutes.ts`'s route rewrite are irreducibly coupled at the type level (see Global Constraints), so splitting them would leave the suite red between tasks.

**Files:**
- Modify: `drizzle/schema.ts` (users table)
- Modify: `server/_core/auth.ts`
- Modify: `server/_core/auth.test.ts`
- Create: `server/_core/loginFlow.ts`
- Create: `server/_core/loginFlow.test.ts`
- Modify: `server/_core/authRoutes.ts`
- Modify: `server/_core/context.ts`
- Modify: `server/_core/cookies.ts`
- Modify: `server/_core/env.ts`
- Modify: `server/_core/env.test.ts`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` from Task 1 (`./passwords`); `isLocked`/`recordFailedAttempt`/`clearAttempts` from Task 2 (`./loginThrottle`).
- Produces: `SessionPayload { userId: number; role: "editor" | "viewer"; tokenVersion: number }`, `createSessionToken(userId, role, tokenVersion): Promise<string>`, `verifySessionToken(token): Promise<SessionPayload>` (all in `auth.ts`) — used by `loginFlow.ts`.
- Produces: `attemptLogin(email: string, password: string): Promise<{ ok: true; token: string; user: { id: number; email: string; role: "editor" | "viewer" } } | { ok: false }>`, `resolveSession(token: string | undefined): Promise<{ userId: number; role: "editor" | "viewer" } | null>`, `performLogout(token: string | undefined): Promise<void>` (all in `loginFlow.ts`) — `resolveSession` is consumed by both `context.ts` and `authRoutes.ts`'s `/api/auth/status`; later tasks do not call it directly.

- [ ] **Step 1: Reset the local dev DB and change the schema**

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword -e "DROP DATABASE IF EXISTS accommerce_dev; CREATE DATABASE accommerce_dev;"
```

```typescript
// drizzle/schema.ts — users table gains two columns
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  role: mysqlEnum("role", ["editor", "viewer"]).notNull(),
  managerId: int("managerId"),
  passwordHash: varchar("passwordHash", { length: 255 }),
  tokenVersion: int("tokenVersion").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

(`passwordHash` is nullable at the schema level only — every real login path in this plan requires it to be set; `verifyPassword` from Task 1 already fails closed on `null`.)

- [ ] **Step 2: Write the failing tests for `auth.ts`**

Replace the entire contents of `server/_core/auth.test.ts` with:

```typescript
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
```

(Note: this file no longer needs the `?t=${Date.now()}` cache-busting import suffix — `vi.resetModules()` alone is sufficient, and this file never actually depends on `ENV` at import time the way `env.test.ts` does, since `auth.ts` itself has no top-level `ENV` read. Verify this is genuinely true by reading the current `auth.ts` before assuming it — if `auth.ts` does read `ENV` at module load time, keep the cache-busting suffix instead of removing it.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test server/_core/auth.test.ts`
Expected: FAIL — `createSessionToken`'s current signature only takes `(userId, role)`, and `createPasswordVerifiedToken`/`verifyPasswordVerifiedToken` tests (being deleted from this file) will simply be gone.

- [ ] **Step 4: Rewrite `auth.ts`**

Replace the entire contents of `server/_core/auth.ts` with:

```typescript
// server/_core/auth.ts
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./env";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(ENV.sessionSecret);
}

export interface SessionPayload {
  userId: number;
  role: "editor" | "viewer";
  tokenVersion: number;
}

export async function createSessionToken(userId: number, role: "editor" | "viewer", tokenVersion: number): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + THIRTY_DAYS_MS) / 1000);
  return new SignJWT({ userId, role, tokenVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
  return {
    userId: payload.userId as number,
    role: payload.role as "editor" | "viewer",
    tokenVersion: payload.tokenVersion as number,
  };
}
```

This deletes `verifyAppPassword`, `createPasswordVerifiedToken`, and `verifyPasswordVerifiedToken` entirely — they have no remaining caller once Step 8 (below) rewrites `authRoutes.ts` in this same task.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test server/_core/auth.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Write the failing tests for `loginFlow.ts`**

```typescript
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
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `pnpm test server/_core/loginFlow.test.ts`
Expected: FAIL — `./loginFlow` does not exist yet.

- [ ] **Step 8: Write `loginFlow.ts`, then rewrite `authRoutes.ts`, `context.ts`, `cookies.ts`, `env.ts`**

```typescript
// server/_core/loginFlow.ts
//
// The single place auth logic touches the database. Both server/_core/context.ts
// (tRPC) and server/_core/authRoutes.ts (plain Express) call resolveSession here
// rather than each re-implementing "verify the JWT, then check tokenVersion" —
// see docs/2026-09-20-security-hardening-design.md Section 2.
import { eq, sql } from "drizzle-orm";
import { db } from "../dbClient";
import { users } from "../../drizzle/schema";
import { createSessionToken, verifySessionToken, type SessionPayload } from "./auth";
import { verifyPassword } from "./passwords";
import { isLocked, recordFailedAttempt, clearAttempts } from "./loginThrottle";

export type LoginResult =
  | { ok: true; token: string; user: { id: number; email: string; role: "editor" | "viewer" } }
  | { ok: false };

export async function attemptLogin(email: string, password: string): Promise<LoginResult> {
  if (isLocked(email)) return { ok: false };

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordFailedAttempt(email);
    return { ok: false };
  }

  clearAttempts(email);
  const token = await createSessionToken(user.id, user.role, user.tokenVersion);
  return { ok: true, token, user: { id: user.id, email: user.email, role: user.role } };
}

export async function resolveSession(token: string | undefined): Promise<{ userId: number; role: "editor" | "viewer" } | null> {
  if (!token) return null;

  let payload: SessionPayload;
  try {
    payload = await verifySessionToken(token);
  } catch {
    return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
  if (!user || user.tokenVersion !== payload.tokenVersion) return null;

  return { userId: user.id, role: user.role };
}

export async function performLogout(token: string | undefined): Promise<void> {
  const session = await resolveSession(token);
  if (!session) return;
  await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, session.userId));
}
```

```typescript
// server/_core/cookies.ts — replace the whole file
export const SESSION_COOKIE = "accommerce_session";

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}
```

(`PASSWORD_COOKIE`/`getPasswordCookieOptions` are deleted — nothing needs a short-lived intermediate cookie once login is one step.)

```typescript
// server/_core/context.ts — replace the whole file
import type { Request } from "express";
import { parse as parseCookieHeader } from "cookie";
import { SESSION_COOKIE } from "./cookies";
import { resolveSession } from "./loginFlow";

export interface TrpcContext {
  user: { id: number; role: "editor" | "viewer" } | null;
}

export async function createContext({ req }: { req: Request }): Promise<TrpcContext> {
  const cookies = req.headers.cookie ? parseCookieHeader(req.headers.cookie) : {};
  const session = await resolveSession(cookies[SESSION_COOKIE]);
  return { user: session };
}
```

```typescript
// server/_core/authRoutes.ts — replace the whole file
import type { Express, Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import { attemptLogin, resolveSession, performLogout } from "./loginFlow";
import { SESSION_COOKIE, getSessionCookieOptions } from "./cookies";

function getCookie(req: Request, name: string): string | undefined {
  if (!req.headers.cookie) return undefined;
  return parseCookieHeader(req.headers.cookie)[name];
}

export function mountAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    const result = await attemptLogin(email, password);
    if (!result.ok) {
      return res.status(401).json({ error: "invalid email or password" });
    }

    res.cookie(SESSION_COOKIE, result.token, getSessionCookieOptions());
    res.json({ ok: true, user: result.user });
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    await performLogout(getCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get("/api/auth/status", async (req: Request, res: Response) => {
    const session = await resolveSession(getCookie(req, SESSION_COOKIE));
    if (!session) return res.json({ authenticated: false });
    res.json({ authenticated: true, userId: session.userId, role: session.role });
  });
}
```

(`/api/auth/password`, `/api/auth/users`, and `/api/auth/select-user` are all deleted — `/api/auth/login` replaces the three-step flow entirely.)

```typescript
// server/_core/env.ts — replace the whole file
export interface Env {
  databaseUrl: string;
  sessionSecret: string;
  port: number;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }

  return {
    databaseUrl,
    sessionSecret,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  };
}

export const ENV = loadEnv();
```

Update `server/_core/env.test.ts` to remove the now-nonexistent `appPassword` field and the `process.env.APP_PASSWORD = "test-password"` lines from both tests (the `mod.loadEnv()`/`env.databaseUrl`/`env.port` assertions are unaffected).

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm test server/_core/loginFlow.test.ts server/_core/env.test.ts`
Expected: PASS.

- [ ] **Step 10: Apply the schema change and verify**

Run: `pnpm db:push`

```bash
mysql -h127.0.0.1 -P3306 -uroot -pdevpassword accommerce_dev -e "SHOW CREATE TABLE users\G"
```

Confirm `passwordHash` (nullable `varchar(255)`) and `tokenVersion` (`int NOT NULL DEFAULT 0`) both appear.

- [ ] **Step 11: Run the full suite**

Run: `pnpm test`
Expected: all tests pass. (Some other test files construct `users` rows via `createSku`-adjacent helpers or direct inserts — if any existing test's `db.insert(users).values(...)` call breaks because it now needs `tokenVersion`'s default to apply correctly, that's expected to just work via the column default; investigate and fix only if something genuinely fails, rather than assuming.)

- [ ] **Step 12: Verify live via the real HTTP flow**

Start the server in the background (`pnpm exec tsx server/_core/index.ts`), seed a test user directly against the dev DB with a known password (a temporary throwaway script using `hashPassword` + a direct insert is fine here — Task 5 makes this official via `scripts/seed-first-user.ts`), then:

- `POST /api/auth/login` with the correct email/password → expect `200` and a `Set-Cookie` for `accommerce_session`.
- `GET /api/auth/status` with that cookie → expect `{ authenticated: true, ... }`.
- `POST /api/auth/logout` with that cookie → expect `200`.
- `GET /api/auth/status` with the SAME (now-logged-out) cookie → expect `{ authenticated: false }` — this is the concrete proof that logout genuinely revokes the token server-side, not just clears the browser's copy.

Report the real observed responses, not predicted ones. Delete any throwaway seeding script afterward; stop the server.

- [ ] **Step 13: Commit**

```bash
git add drizzle/schema.ts drizzle/migrations server/_core/auth.ts server/_core/auth.test.ts server/_core/loginFlow.ts server/_core/loginFlow.test.ts server/_core/authRoutes.ts server/_core/context.ts server/_core/cookies.ts server/_core/env.ts server/_core/env.test.ts
git commit -m "feat: rewrite login flow around real per-user credentials and tokenVersion revocation"
```

---

### Task 4: Client — Login Form and Sign-Out Button

**Files:**
- Modify: `client/src/pages/LoginPage.tsx`
- Modify: `client/src/components/nav/AppNav.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/login` and `POST /api/auth/logout` from Task 3 (both already live on the server; no server-side changes in this task).

- [ ] **Step 1: Rewrite `LoginPage.tsx`**

Replace the entire contents of `client/src/pages/LoginPage.tsx` with:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";

const JSON_HEADERS = { "Content-Type": "application/json" };

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Invalid email or password." : `Could not sign in (HTTP ${res.status}).`);
        return;
      }
      navigate("/");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label>
          Email{" "}
          <input
            type="email"
            value={email}
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password{" "}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || email.length === 0 || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Add a Sign-Out button to `AppNav.tsx`**

Replace the entire contents of `client/src/components/nav/AppNav.tsx` with:

```tsx
import { NavLink, useNavigate } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Home" },
  { to: "/stock", label: "Stock" },
  { to: "/purchase-orders", label: "Purchase Orders" },
  { to: "/shipments", label: "Shipments" },
  { to: "/money", label: "Money" },
];

export function AppNav() {
  const navigate = useNavigate();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      // Always redirect, even if the network call failed — a signed-out user
      // stuck on a page that will just 401 on every subsequent action helps
      // no one.
      navigate("/login");
    }
  }

  return (
    <nav>
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}>
          {item.label}
        </NavLink>
      ))}
      <button onClick={signOut}>Sign out</button>
    </nav>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: zero errors. (This repo has no client-side automated test suite — `vitest.config.ts` runs in `node` environment only — so typechecking plus the live verification in Step 4 is this task's real verification, matching how every other client-only change in this repo's history has been verified.)

- [ ] **Step 4: Verify live in a real browser or via the scriptable flow**

Start the dev server (`pnpm dev`), and either:
- open the app in a browser, sign in with a real test user's email/password, confirm you land on `/`, click "Sign out" in the nav, confirm you're redirected to `/login` and that navigating back to `/` also redirects to `/login` (proving the session was actually invalidated, not just the UI's local state); or
- if a browser isn't available in this environment, use the scriptable HTTP flow (`POST /api/auth/login`, then check `GET /api/auth/status`, then simulate the Sign-Out button's own `POST /api/auth/logout` call, then re-check `GET /api/auth/status`) — this task's client code doesn't add new server behavior beyond what Task 3 already verified, so this step is about confirming the UI wires those existing calls correctly (correct method, `credentials: "include"`, correct navigation), which a code read plus Task 3's server-side proof already covers; note explicitly in your report which method you used.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/LoginPage.tsx client/src/components/nav/AppNav.tsx
git commit -m "feat: single email+password login form and a working sign-out button"
```

---

### Task 5: User Provisioning Scripts and Documentation

**Files:**
- Modify: `scripts/seed-first-user.ts`
- Create: `scripts/reset-password.mjs`
- Test: `scripts/reset-password.test.ts`
- Modify: `RAILWAY.md`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `hashPassword` from Task 1 (`server/_core/passwords.ts`).

- [ ] **Step 1: Extend `scripts/seed-first-user.ts` to require a password**

Replace the entire contents of `scripts/seed-first-user.ts` with:

```typescript
// scripts/seed-first-user.ts
//
// Bootstrap for a fresh deploy (see RAILWAY.md) — also the general-purpose
// way to add any subsequent user, since its only guard is "this exact email
// already exists," not "a user already exists at all." Run with tsx, not
// plain `node` — this repo uses extensionless relative imports that Node's
// native ESM resolver cannot resolve.
//
//   SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor \
//     SEED_USER_PASSWORD=a-real-password \
//     pnpm exec tsx scripts/seed-first-user.ts
import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword } from "../server/_core/passwords";

const ROLES = ["editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

async function main() {
  const email = process.env.SEED_USER_EMAIL;
  const role = process.env.SEED_USER_ROLE ?? "editor";
  const password = process.env.SEED_USER_PASSWORD;

  if (!email) throw new Error("SEED_USER_EMAIL is required");
  if (!ROLES.includes(role as Role)) {
    throw new Error(`SEED_USER_ROLE must be one of ${ROLES.join(", ")} — got "${role}"`);
  }
  if (!password) throw new Error("SEED_USER_PASSWORD is required");

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    throw new Error(
      `user ${email} already exists (id ${existing.id}, role ${existing.role}) — this bootstrap script is meant to run once per email`,
    );
  }

  const passwordHash = await hashPassword(password);
  const [result] = await db.insert(users).values({ email, role: role as Role, passwordHash });
  const [created] = await db.select().from(users).where(eq(users.id, result.insertId));

  console.log(`Created user: id=${created.id} email=${created.email} role=${created.role}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`seed-first-user failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
```

- [ ] **Step 2: Write the failing test for `reset-password`'s core logic**

```typescript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test scripts/reset-password.test.ts`
Expected: FAIL — `./resetPassword` does not exist yet.

- [ ] **Step 4: Write `scripts/resetPassword.ts` (the testable logic) and `scripts/reset-password.mjs` (the CLI entrypoint)**

```typescript
// scripts/resetPassword.ts
//
// Core logic for scripts/reset-password.mjs, factored out into its own
// plain-TypeScript file so it can be unit-tested directly against the real
// dev DB, matching this repo's existing convention (see
// scripts/parallel-run-report.ts for the same pattern: a CLI's actual logic
// lives in a plain, testable file; the .mjs file is a thin argv/exit-code
// wrapper around it).
import { eq, sql } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword } from "../server/_core/passwords";

export async function resetPassword(email: string, newPassword: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error(`no user found with email ${email}`);

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, user.id));
}
```

```javascript
#!/usr/bin/env tsx
// scripts/reset-password.mjs
//
// Resets a user's password and invalidates their existing sessions in the
// same operation — a reset always means "the old password, and anything
// signed while it was live, is no longer trusted." Run with tsx, not plain
// `node` — this repo's extensionless relative imports don't resolve under
// Node's native ESM loader.
//
//   RESET_USER_EMAIL=julian@accommerce.example RESET_USER_PASSWORD=new-password \
//     pnpm exec tsx scripts/reset-password.mjs
import { resetPassword } from "./resetPassword.ts";

const email = process.env.RESET_USER_EMAIL;
const password = process.env.RESET_USER_PASSWORD;

if (!email) {
  console.error("RESET_USER_EMAIL is required");
  process.exit(1);
}
if (!password) {
  console.error("RESET_USER_PASSWORD is required");
  process.exit(1);
}

try {
  await resetPassword(email, password);
  console.log(`Password reset for ${email} — all existing sessions for this user are now invalidated.`);
  process.exit(0);
} catch (err) {
  console.error(`reset-password failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

(Note `scripts/reset-password.test.ts` imports from `./resetPassword` (no `.ts`/`.mjs` extension, resolved by vitest directly) while `scripts/reset-password.mjs` imports from `./resetPassword.ts` (needs the extension under `tsx`'s resolution, matching this repo's established convention — see Stream E's Task 6 for the same distinction) — verify both actually resolve correctly when you run each in Step 5/6, don't assume.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test scripts/reset-password.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Verify the CLI script end-to-end against the real dev DB**

```bash
set -a && source .env && set +a
SEED_USER_EMAIL=temp-test@accommerce.example SEED_USER_ROLE=viewer SEED_USER_PASSWORD=original-password \
  pnpm exec tsx scripts/seed-first-user.ts
RESET_USER_EMAIL=temp-test@accommerce.example RESET_USER_PASSWORD=new-password \
  pnpm exec tsx scripts/reset-password.mjs
```

Expected: both exit 0, the second printing the reset confirmation. Then confirm via a real login attempt (`POST /api/auth/login` with `temp-test@accommerce.example` / `new-password`, against a running server) that the NEW password works and the OLD one (`original-password`) is rejected. Delete the `temp-test@accommerce.example` row from the dev DB afterward (`db.delete(users).where(eq(users.email, "temp-test@accommerce.example"))` via a throwaway script, or a direct `DELETE FROM users WHERE email = ...` via the mysql CLI) so it doesn't pollute other tests' `beforeEach` table-truncation expectations — check whether any other test file's `beforeEach` already truncates `users` (several do, per this codebase's convention) before deciding this cleanup is strictly necessary, but do it regardless for hygiene.

- [ ] **Step 7: Update `.env.example`**

Remove the `APP_PASSWORD=replace-with-a-real-password` line entirely. Resulting file:

```
DATABASE_URL=mysql://root:devpassword@localhost:3306/accommerce_dev
SESSION_SECRET=replace-with-openssl-rand-hex-32-output
PORT=3000
```

- [ ] **Step 8: Update `README.md`**

Change the "Local development" quickstart line:

```
cp .env.example .env   # fill in DATABASE_URL / SESSION_SECRET / APP_PASSWORD
```

to:

```
cp .env.example .env   # fill in DATABASE_URL / SESSION_SECRET
```

- [ ] **Step 9: Update `RAILWAY.md`**

In the "Required Environment Variables" table, delete the `APP_PASSWORD` row entirely.

In step 4 of "One-time setup," change:

```
4. In Railway: set environment variables `DATABASE_URL`, `SESSION_SECRET`
   (`openssl rand -hex 32`), `APP_PASSWORD`, `PORT=3000`.
```

to:

```
4. In Railway: set environment variables `DATABASE_URL`, `SESSION_SECRET`
   (`openssl rand -hex 32`), `PORT=3000`.
```

Replace step 7 entirely (the "Required one-time bootstrap" section) with:

```
7. **Required one-time bootstrap — create the first user.** Nothing in the
   app creates a `users` row on its own, so until this runs the login screen
   has no account to authenticate against. Run once against the production
   `DATABASE_URL`:

   ```bash
   SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor \
     SEED_USER_PASSWORD=a-real-password \
     pnpm exec tsx scripts/seed-first-user.ts
   ```

   `SEED_USER_ROLE` is `editor` or `viewer` (defaults to `editor`). The
   script prints the created user's id/email/role, and refuses to run twice
   for the same email. Add further users the same way, with a different
   `SEED_USER_EMAIL`.

   To reset a user's password later (e.g. a suspected leak, or someone
   forgetting theirs), run:

   ```bash
   RESET_USER_EMAIL=julian@accommerce.example RESET_USER_PASSWORD=a-new-password \
     pnpm exec tsx scripts/reset-password.mjs
   ```

   This also immediately invalidates every session that user currently has
   — see `docs/2026-09-20-security-hardening-design.md` Section 4.
```

- [ ] **Step 10: Run the full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add scripts/seed-first-user.ts scripts/resetPassword.ts scripts/reset-password.mjs scripts/reset-password.test.ts RAILWAY.md .env.example README.md
git commit -m "feat: password-based user provisioning scripts, retire APP_PASSWORD from docs/env"
```

---

## Self-Review Notes

**Spec coverage check:** all 5 design sections map to tasks — Section 1 (real per-user credentials) → Task 3 (`loginFlow.ts`/`authRoutes.ts`) + Task 4 (`LoginPage.tsx`); Section 2 (tokenVersion revocation) → Task 3 (`auth.ts`/`loginFlow.ts`); Section 3 (sign-out UI) → Task 4 (`AppNav.tsx`); Section 4 (user provisioning) → Task 5; Section 5 (login throttle) → Task 2, wired into `attemptLogin` in Task 3.

**Placeholder scan:** every step has real, complete code; no TBD/TODO. The two "verify live" steps (Task 3 Step 12, Task 4 Step 4) intentionally leave the exact verification tool (browser vs. scripted HTTP) to whichever is available in the execution environment, per this repo's established precedent (Stream A discovered subagents can't literally drive a browser and the scriptable-login-flow method became the standing substitute) — this is not a placeholder, it's the same judgment call every prior stream in this repo has already made explicit.

**Type consistency cross-check:** `createSessionToken`'s new 3-argument signature (Task 3) is used identically in `loginFlow.ts`'s `attemptLogin` (same task) and nowhere else. `SessionPayload`'s `tokenVersion` field flows from `auth.ts` → `loginFlow.ts`'s `resolveSession` → `context.ts`'s `TrpcContext.user` (which deliberately does NOT expose `tokenVersion` outward, matching the original `TrpcContext.user` shape `{ id, role }` used throughout every router in `server/routers.ts` — verified no router or client code anywhere reads a `tokenVersion` field off `ctx.user`, so this is a safe, non-breaking internal-only addition). `resolveSession`'s return shape (`{ userId, role } | null`) matches exactly between its three consumers (`context.ts`, `authRoutes.ts`'s `/api/auth/status`, `loginFlow.ts`'s own `performLogout`) since they all call the same function rather than three independent reimplementations.
