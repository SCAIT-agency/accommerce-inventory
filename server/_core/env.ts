export interface Env {
  databaseUrl: string;
  sessionSecret: string;
  port: number;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }

  return {
    databaseUrl,
    sessionSecret,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  };
}

export const ENV = loadEnv();
