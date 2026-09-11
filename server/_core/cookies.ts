export const SESSION_COOKIE = "accommerce_session";

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export const PASSWORD_COOKIE = "accommerce_password_verified";

export function getPasswordCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 10 * 60 * 1000, // 10 minutes — just long enough to complete login
    path: "/",
  };
}
