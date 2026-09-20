#!/usr/bin/env tsx
// scripts/reset-password.mjs
//
// Resets a user's password and invalidates their existing sessions in the
// same operation — a reset always means "the old password, and anything
// signed while it was live, is no longer trusted." Run with tsx, not plain
// `node` — this repo's extensionless relative imports don't resolve under
// Node's native ESM loader.
//
//   RESET_USER_EMAIL=julian@accommerce.example RESET_USER_PASSWORD=new-password \
//     pnpm exec tsx scripts/reset-password.mjs
import { resetPassword } from "./reset-password-core.ts";

const email = process.env.RESET_USER_EMAIL;
const password = process.env.RESET_USER_PASSWORD;

if (!email) {
  console.error("RESET_USER_EMAIL is required");
  process.exit(1);
}
if (!password) {
  console.error("RESET_USER_PASSWORD is required");
  process.exit(1);
}

try {
  await resetPassword(email, password);
  console.log(`Password reset for ${email} — all existing sessions for this user are now invalidated.`);
  process.exit(0);
} catch (err) {
  console.error(`reset-password failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
