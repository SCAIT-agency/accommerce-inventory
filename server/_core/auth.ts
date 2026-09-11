import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./env";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(ENV.sessionSecret);
}

export interface SessionPayload {
  userId: number;
  role: "editor" | "viewer";
}

export async function createSessionToken(userId: number, role: "editor" | "viewer"): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + ONE_YEAR_MS) / 1000);
  return new SignJWT({ userId, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
  return { userId: payload.userId as number, role: payload.role as "editor" | "viewer" };
}

export function verifyAppPassword(candidate: string): boolean {
  return candidate === ENV.appPassword;
}

export async function createPasswordVerifiedToken(): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
  return new SignJWT({ passwordVerified: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(getSecretKey());
}

export async function verifyPasswordVerifiedToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    return payload.passwordVerified === true;
  } catch {
    return false;
  }
}
