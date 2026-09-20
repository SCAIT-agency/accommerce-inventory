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

    try {
      const result = await attemptLogin(email, password);
      if (!result.ok) {
        return res.status(401).json({ error: "invalid email or password" });
      }
      res.cookie(SESSION_COOKIE, result.token, getSessionCookieOptions());
      res.json({ ok: true, user: result.user });
    } catch {
      res.status(500).json({ error: "login failed" });
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      await performLogout(getCookie(req, SESSION_COOKIE));
    } catch {
      // Logout must never leave a client stuck — clear the cookie regardless
      // of whether the tokenVersion bump succeeded.
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get("/api/auth/status", async (req: Request, res: Response) => {
    try {
      const session = await resolveSession(getCookie(req, SESSION_COOKIE));
      if (!session) return res.json({ authenticated: false });
      res.json({ authenticated: true, userId: session.userId, role: session.role });
    } catch {
      res.json({ authenticated: false });
    }
  });
}
