import { THIRTY_DAYS_MS } from "./auth";

export const SESSION_COOKIE = "accommerce_session";

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: THIRTY_DAYS_MS,
    path: "/",
  };
}
