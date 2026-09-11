import type { Express, Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import { verifyAppPassword, createPasswordVerifiedToken, verifyPasswordVerifiedToken, createSessionToken, verifySessionToken } from "./auth";
import { SESSION_COOKIE, PASSWORD_COOKIE, getSessionCookieOptions, getPasswordCookieOptions } from "./cookies";
import { db } from "../dbClient";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

function getCookie(req: Request, name: string): string | undefined {
  if (!req.headers.cookie) return undefined;
  return parseCookieHeader(req.headers.cookie)[name];
}

export function mountAuthRoutes(app: Express) {
  app.post("/api/auth/password", async (req: Request, res: Response) => {
    const { password } = req.body ?? {};
    if (typeof password !== "string" || !verifyAppPassword(password)) {
      return res.status(401).json({ error: "invalid password" });
    }
    const token = await createPasswordVerifiedToken();
    res.cookie(PASSWORD_COOKIE, token, getPasswordCookieOptions());
    res.json({ ok: true });
  });

  app.get("/api/auth/users", async (req: Request, res: Response) => {
    const pwCookie = getCookie(req, PASSWORD_COOKIE);
    if (!pwCookie || !(await verifyPasswordVerifiedToken(pwCookie))) {
      return res.status(401).json({ error: "password not verified" });
    }
    const rows = await db.select({ id: users.id, email: users.email, role: users.role }).from(users);
    res.json(rows);
  });

  app.post("/api/auth/select-user", async (req: Request, res: Response) => {
    const pwCookie = getCookie(req, PASSWORD_COOKIE);
    if (!pwCookie || !(await verifyPasswordVerifiedToken(pwCookie))) {
      return res.status(401).json({ error: "password not verified" });
    }
    const { userId } = req.body ?? {};
    if (typeof userId !== "number") {
      return res.status(400).json({ error: "userId is required" });
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return res.status(404).json({ error: "user not found" });

    const token = await createSessionToken(user.id, user.role);
    res.cookie(SESSION_COOKIE, token, getSessionCookieOptions());
    res.clearCookie(PASSWORD_COOKIE);
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get("/api/auth/status", async (req: Request, res: Response) => {
    const sessionCookie = getCookie(req, SESSION_COOKIE);
    if (!sessionCookie) return res.json({ authenticated: false });
    try {
      const payload = await verifySessionToken(sessionCookie);
      res.json({ authenticated: true, userId: payload.userId, role: payload.role });
    } catch {
      res.json({ authenticated: false });
    }
  });
}
