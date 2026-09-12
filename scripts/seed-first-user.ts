// scripts/seed-first-user.ts
//
// One-time bootstrap for a fresh deploy (see RAILWAY.md). The app's login
// flow is: app password -> pick an identity from `users` -> session cookie.
// Nothing in the app creates that first `users` row, so without this script a
// fresh deploy has no identity to select and nobody can get past the login
// screen. Run once, after `pnpm db:push`:
//
//   SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor \
//     pnpm exec tsx scripts/seed-first-user.ts
//
// Run with tsx, not plain `node` — this repo uses extensionless relative
// imports that Node's native ESM resolver cannot resolve.
import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { users } from "../drizzle/schema";

const ROLES = ["editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

async function main() {
  const email = process.env.SEED_USER_EMAIL;
  const role = process.env.SEED_USER_ROLE ?? "editor";

  if (!email) throw new Error("SEED_USER_EMAIL is required");
  if (!ROLES.includes(role as Role)) {
    throw new Error(`SEED_USER_ROLE must be one of ${ROLES.join(", ")} — got "${role}"`);
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    throw new Error(
      `user ${email} already exists (id ${existing.id}, role ${existing.role}) — this bootstrap script is meant to run once against a fresh deploy`,
    );
  }

  const [result] = await db.insert(users).values({ email, role: role as Role });
  const [created] = await db.select().from(users).where(eq(users.id, result.insertId));

  console.log(`Created first user: id=${created.id} email=${created.email} role=${created.role}`);
}

main()
  .then(() => {
    // The mysql2 pool keeps its sockets open, which would otherwise keep the
    // event loop alive forever — a one-shot script must actually exit.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`seed-first-user failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
