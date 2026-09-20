// server/_core/authRoutes.test.ts
//
// Regression test for the fail-closed fix: an unexpected error from
// loginFlow.ts (e.g. a transient DB failure) must never become an uncaught
// promise rejection inside an async Express route handler — Express 4 does
// not catch those, and with no global unhandledRejection handler in
// server/_core/index.ts, Node's default is to kill the whole process. This
// mounts the real routes on a real (randomly-ported) HTTP server and mocks
// loginFlow.ts to reject, so the test would itself crash the vitest worker
// if the routes' try/catch were ever removed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

vi.mock("./loginFlow", () => ({
  attemptLogin: vi.fn(),
  resolveSession: vi.fn(),
  performLogout: vi.fn(),
}));

import { attemptLogin, resolveSession, performLogout } from "./loginFlow";
import { mountAuthRoutes } from "./authRoutes";

describe("authRoutes fail closed on an unexpected loginFlow error", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    mountAuthRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POST /api/auth/login returns 500 instead of crashing when attemptLogin throws", async () => {
    vi.mocked(attemptLogin).mockRejectedValue(new Error("db exploded"));

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "x" }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "login failed" });
  });

  it("GET /api/auth/status returns {authenticated:false} instead of crashing when resolveSession throws", async () => {
    vi.mocked(resolveSession).mockRejectedValue(new Error("db exploded"));

    const res = await fetch(`${baseUrl}/api/auth/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("POST /api/auth/logout still returns 200 ok instead of crashing when performLogout throws", async () => {
    vi.mocked(performLogout).mockRejectedValue(new Error("db exploded"));

    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
