import type { Request } from "express";
import { parse as parseCookieHeader } from "cookie";
import { SESSION_COOKIE } from "./cookies";
import { verifySessionToken } from "./auth";

export interface TrpcContext {
  user: { id: number; role: "editor" | "viewer" } | null;
}

export async function createContext({ req }: { req: Request }): Promise<TrpcContext> {
  const cookies = req.headers.cookie ? parseCookieHeader(req.headers.cookie) : {};
  const token = cookies[SESSION_COOKIE];
  if (!token) return { user: null };
  try {
    const { userId, role } = await verifySessionToken(token);
    return { user: { id: userId, role } };
  } catch {
    return { user: null };
  }
}
