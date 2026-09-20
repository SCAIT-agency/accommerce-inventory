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
  return { user: session ? { id: session.userId, role: session.role } : null };
}
