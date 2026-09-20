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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function attemptLogin(email: string, password: string): Promise<LoginResult> {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail.length === 0 || normalizedEmail.length > 320) return { ok: false };

  if (isLocked(normalizedEmail)) return { ok: false };

  const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordFailedAttempt(normalizedEmail);
    return { ok: false };
  }

  clearAttempts(normalizedEmail);
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
