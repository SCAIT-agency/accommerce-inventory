// server/_core/authRoutesLive.test.ts
//
// Unlike authRoutes.test.ts (which mocks loginFlow.ts to simulate a DB
// failure), this file exercises the real login flow against the real dev DB
// — proving two properties that only show up at the real HTTP layer: the
// three enumeration-sensitive failure cases produce byte-identical response
// bodies, and a successful login's Set-Cookie header carries the attributes
// the design requires.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";
import { db } from "../dbClient";
import { users } from "../../drizzle/schema";
import { hashPassword } from "./passwords";
import { mountAuthRoutes } from "./authRoutes";

const EMAIL = "julian@accommerce.example";
const PASSWORD = "correct horse battery staple";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  await db.delete(users);

  const app: Express = express();
  app.use(express.json());
  mountAuthRoutes(app);

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /api/auth/login — enumeration resistance", () => {
  it("returns byte-identical 401 bodies for a nonexistent email, a wrong password, and a passwordless account", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });
    await db.insert(users).values({ email: "nopassword@accommerce.example", role: "viewer" });

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@accommerce.example", password: PASSWORD }),
      }),
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: "wrong password" }),
      }),
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nopassword@accommerce.example", password: PASSWORD }),
      }),
    ]);

    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(responses.every((r) => r.status === 401)).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });
});

describe("POST /api/auth/login — cookie attributes", () => {
  it("sets a session cookie with the correct attributes and a ~30-day Max-Age", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    await db.insert(users).values({ email: EMAIL, role: "viewer", passwordHash });

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/accommerce_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const maxAgeMatch = setCookie!.match(/Max-Age=(\d+)/i);
    expect(maxAgeMatch).not.toBeNull();
    const maxAgeSeconds = Number(maxAgeMatch![1]);
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;
    expect(maxAgeSeconds).toBeGreaterThan(thirtyDaysSeconds - 60);
    expect(maxAgeSeconds).toBeLessThanOrEqual(thirtyDaysSeconds);
  });
});
