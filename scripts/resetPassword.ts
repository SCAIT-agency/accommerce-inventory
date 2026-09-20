// scripts/resetPassword.ts
//
// Core logic for scripts/reset-password.mjs, factored out into its own
// plain-TypeScript file so it can be unit-tested directly against the real
// dev DB, matching this repo's existing convention (see
// scripts/parallel-run-report.ts for the same pattern: a CLI's actual logic
// lives in a plain, testable file; the .mjs file is a thin argv/exit-code
// wrapper around it).
import { eq, sql } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword } from "../server/_core/passwords";

export async function resetPassword(email: string, newPassword: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error(`no user found with email ${email}`);

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, user.id));
}
