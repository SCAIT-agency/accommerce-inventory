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
