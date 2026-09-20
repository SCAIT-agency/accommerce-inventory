// scripts/seed-first-user.ts
//
// Bootstrap for a fresh deploy (see RAILWAY.md) — also the general-purpose
// way to add any subsequent user, since its only guard is "this exact email
// already exists," not "a user already exists at all." Run with tsx, not
// plain `node` — this repo uses extensionless relative imports that Node's
// native ESM resolver cannot resolve.
//
//   SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor \
//     SEED_USER_PASSWORD=a-real-password \
//     pnpm exec tsx scripts/seed-first-user.ts
import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";
import { hashPassword } from "../server/_core/passwords";
import { normalizeEmail } from "../server/_core/loginFlow";

const ROLES = ["editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

async function main() {
  const rawEmail = process.env.SEED_USER_EMAIL;
  const role = process.env.SEED_USER_ROLE ?? "editor";
  const password = process.env.SEED_USER_PASSWORD;

  if (!rawEmail) throw new Error("SEED_USER_EMAIL is required");
  const email = normalizeEmail(rawEmail);
  if (!ROLES.includes(role as Role)) {
    throw new Error(`SEED_USER_ROLE must be one of ${ROLES.join(", ")} — got "${role}"`);
  }
  if (!password) throw new Error("SEED_USER_PASSWORD is required");

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    throw new Error(
      `user ${email} already exists (id ${existing.id}, role ${existing.role}) — this bootstrap script is meant to run once per email`,
    );
  }

  const passwordHash = await hashPassword(password);
  const [result] = await db.insert(users).values({ email, role: role as Role, passwordHash });
  const [created] = await db.select().from(users).where(eq(users.id, result.insertId));

  console.log(`Created user: id=${created.id} email=${created.email} role=${created.role}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`seed-first-user failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
