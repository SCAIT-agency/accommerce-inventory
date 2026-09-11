export interface Env {
  databaseUrl: string;
  sessionSecret: string;
  appPassword: string;
  port: number;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  const appPassword = process.env.APP_PASSWORD;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }
  if (!appPassword) throw new Error("APP_PASSWORD is required");

  return {
    databaseUrl,
    sessionSecret,
    appPassword,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  };
}

let ENV: Env | null = null;
try {
  ENV = loadEnv();
} catch {
  // Env will be loaded later if needed
}

export { ENV };
