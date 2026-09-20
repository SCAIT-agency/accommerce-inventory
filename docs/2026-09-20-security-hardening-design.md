# Security Hardening (Backlog Stream C) — Design

## Context & Motivation

V1's final whole-branch review flagged the auth model as a real gap, deferred as "matters most once anyone other than Artem is actually operating the deployed instance." That moment is close: the spec's own stated user model (`docs/spec.md`) names real individuals — one SCAIT-side editor account and client-side viewers (Andrew/Julian/Klemens) — and none of them can safely use this app today.

The current flow: `POST /api/auth/password` checks a single shared `APP_PASSWORD` against a plaintext env var, then `GET /api/auth/users` lists every row in `users`, and `POST /api/auth/select-user` lets the caller pick *any* of those rows — including the one editor identity — with no further check. Anyone who knows the one shared password can become the editor. The resulting session JWT (`server/_core/auth.ts`, signed via `jose`) is valid for 365 days with no way to invalidate it short of rotating `SESSION_SECRET` for every user at once, and `POST /api/auth/logout` only clears the browser's cookie — a copied token stays valid regardless. Nothing in the client UI calls `/api/auth/logout` at all.

`jose` itself is not the problem — it is exactly the "standard session-based library" the original spec asked for, used correctly (HS256, proper `jwtVerify`). The gap is entirely in the flow built around it. This design keeps `jose` and replaces the flow: real per-user credentials, a real revocation mechanism, and a real sign-out control.

## Goals

- A viewer or the editor can only ever authenticate as themselves — no shared secret grants access to every identity in the system.
- A compromised or leaked session token can be invalidated without affecting any other user's session.
- Session lifetime drops from 365 days to 30 days.
- A real "Sign out" control exists in the UI and actually invalidates the session server-side, not just the browser cookie.
- Provisioning a new user (or resetting a lost password) has a real, documented path — today only the *first* user can be created at all (`scripts/seed-first-user.ts`), via a one-time bootstrap script.

## Non-Goals

- A full session-management table (list of active devices, per-device revoke) — no requirement in the spec or BACKLOG asks for session visibility; the `tokenVersion` mechanism below gives real revocation without it.
- Single sign-on, OAuth, or magic-link email login — this app has no email-sending capability today, and introducing an external identity provider or email infrastructure is a new dependency this stream doesn't need to take on. Worth revisiting if the spec's planned SCAIT Console (a separate, multi-instance portfolio app) makes centralized auth valuable later.
- An in-app UI for creating/managing users — no such UI exists today (only a one-time seed script), and BACKLOG doesn't ask for one. This design extends the existing CLI-script convention instead.
- Distributed or IP-based rate limiting, CAPTCHA, or persistent (survives-a-restart) lockout tracking — real additional hardening, but this stream includes a minimal in-process per-email throttle (Section 5) that already closes the obvious "unlimited password guesses" gap for a login endpoint now protecting real financial data; the heavier versions of this control are worth a future item only if this app ever faces a wider or more adversarial audience than its current ~4-5 trusted users.
- Any change to how `editorProcedure`/`protectedProcedure` enforce roles at the router layer (`server/_core/trpc.ts`) — that enforcement is already correct; the gap is entirely upstream, in how a session gets its identity in the first place.

## Design

### 1. Real per-user credentials

Add `passwordHash: varchar("passwordHash", { length: 255 })` to the `users` table (nullable at the schema level only to keep the migration simple for any pre-existing row — every real login path requires it to be set). Hashing uses Node's built-in `crypto.scrypt` (no new dependency, no native bindings to worry about on deploy) with a random 16-byte salt per password, stored as `${saltHex}:${hashHex}` in the single column. A new `server/_core/passwords.ts` exports `hashPassword(plaintext): Promise<string>` and `verifyPassword(plaintext, stored): Promise<boolean>` (constant-time comparison via `crypto.timingSafeEqual`).

The two-step `/api/auth/password` → `/api/auth/users` → `/api/auth/select-user` flow is retired entirely, along with `PASSWORD_COOKIE` and its 10-minute cookie. One new endpoint replaces all three:

```
POST /api/auth/login
body: { email: string, password: string }
```

Looks up the user by email, verifies the password against `passwordHash` (a missing/null `passwordHash` fails closed — treated as "wrong password", not a crash), and on success issues the session JWT directly (see Section 2 for its new payload shape). Wrong email or wrong password both return the same generic `401 { error: "invalid email or password" }` — not distinguishing "no such user" from "wrong password", so the login form's *response body* can't be used to enumerate registered emails. Response *timing* still differs slightly (a nonexistent email skips the `scrypt` hash comparison entirely; an existing one pays its real cost) — a real, known side-channel in principle, but an accepted residual risk here: the handful of real emails in this system (Andrew/Julian/Klemens, the SCAIT editor) are already known to each other through normal business contact, so timing-based enumeration defends against a threat that doesn't meaningfully exist for this deployment. Not worth the extra complexity of a dummy-hash comparison on the not-found path.

`client/src/pages/LoginPage.tsx` becomes a single email+password form, replacing the current password-then-identity-list UI. `GET /api/auth/users` is deleted — nothing needs to list every identity anymore.

### 2. Real revocation via a token-version counter

Add `tokenVersion: int("tokenVersion").notNull().default(0)` to `users`. `SessionPayload` (`server/_core/auth.ts`) gains a `tokenVersion` field, embedded in the JWT at sign time alongside `userId`/`role`. Session lifetime changes from 365 days to 30 days (`THIRTY_DAYS_MS`, replacing `ONE_YEAR_MS`).

Verification becomes two steps instead of one: `verifySessionToken` still checks the JWT's signature/expiry via `jose` exactly as today, but its caller (`server/_core/context.ts`'s `createContext`) now also loads the user's *current* `tokenVersion` from the DB and compares it against the token's embedded value — a mismatch means "session software says this token is valid, but user data says it's been revoked", and the request is treated as unauthenticated (`ctx.user = null`) exactly like a failed signature check, not a distinct error. This is one extra indexed-by-primary-key `SELECT` per authenticated request — negligible at this codebase's current and near-term scale (BACKLOG section D is where real query-volume performance work belongs, not this stream).

`POST /api/auth/logout` changes from `res.clearCookie` only to: first identify the calling user by reading and verifying the current session cookie exactly as `createContext` does (a missing or already-invalid cookie means there is no `tokenVersion` to bump — just clear the cookie and return success, matching "logging out an already-logged-out session" being a harmless no-op, not an error); if a valid session is found, increment that user's `tokenVersion` in the DB (invalidating every outstanding token for that user, including the very cookie now being cleared, and any other copies of it that might exist), *then* clear the cookie. A user can also be force-logged-out remotely (e.g. after a suspected leak) by incrementing their `tokenVersion` directly — no new endpoint needed for this in v1 of this design, since the only person who could plausibly need it today is the editor acting on their own account, or the editor resetting a viewer's compromised password (which naturally also needs to invalidate that viewer's outstanding sessions — `scripts/reset-password.mjs`, below, does this as part of the same operation).

### 3. Real sign-out UI

`client/src/components/nav/AppNav.tsx` gains a "Sign out" button. It calls `POST /api/auth/logout` (`credentials: "include"`), then navigates to `/login` regardless of the response (logout must never leave a user stuck if the network call fails — clearing local state and redirecting is always safe). No new state management needed: the existing `/api/auth/status` check in `main.tsx` already re-runs auth status appropriately on route changes.

### 4. User provisioning

`scripts/seed-first-user.ts` is extended (not replaced) to also accept a password:

```
SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor SEED_USER_PASSWORD=... \
  pnpm exec tsx scripts/seed-first-user.ts
```

hashing it via `hashPassword` before insert. A new `scripts/create-user.mjs`, matching this exact pattern, covers every *subsequent* user (the seed script's own guard — "throws if a user with this email already exists" — is what actually distinguishes "first user" from "any user" today; the two scripts differ only in name/docs, not mechanism, so `create-user.mjs` is a thin wrapper reusing the same insert logic factored into a shared helper).

A new `scripts/reset-password.mjs`:

```
RESET_USER_EMAIL=julian@accommerce.example RESET_USER_PASSWORD=... \
  pnpm exec tsx scripts/reset-password.mjs
```

hashes the new password, updates `passwordHash`, and increments `tokenVersion` in the same update — a password reset always invalidates that user's existing sessions, since a reset is presumed to mean the old password (and anything signed while it was live) is no longer trusted.

Both new scripts follow the existing CLI convention (`tsx`-executable, `process.exit(0)`/`process.exit(1)` on every path, since the mysql2 pool otherwise keeps the process alive) and get documented in `RAILWAY.md` alongside the existing seed-user section.

### 5. Minimal failed-login throttle

`/api/auth/login` is now a real password-checking endpoint protecting access to real financial data — leaving it open to unlimited guesses would undercut everything above it. A new `server/_core/loginThrottle.ts` tracks failed attempts **per email** in an in-process `Map<string, { count: number; firstFailureAt: number }>` (no new dependency, no persistent store): 5 failed attempts within a 15-minute window for a given email locks that email out for the next 15 minutes, returning the same generic `401` as a wrong password (not a distinct "locked out" message, so a lockout itself can't be used to confirm an email exists via a different response shape). A successful login clears that email's entry. The window resets on process restart — an accepted limitation at this deployment's scale (infrequent restarts, no adversary sophisticated enough to time deploys), not worth the complexity of persisting counters to the DB.

Deliberately per-email, not per-IP: the real users here may share an office network, and per-IP tracking would let one legitimate user's failed attempts lock out a colleague on the same connection. Per-email correctly rate-limits guessing against any single account regardless of source IP, which is the threat that actually matters at this scale.

## Testing

`server/_core/passwords.test.ts`: round-trips a password through `hashPassword`/`verifyPassword` (correct password verifies, wrong password doesn't, two hashes of the same password differ due to random salting).

`server/_core/authRoutes.test.ts` (extended, real DB not mocks, matching this codebase's existing test convention): `/api/auth/login` succeeds with correct credentials and issues a session cookie; fails with wrong password; fails with a nonexistent email; fails with a null `passwordHash` (a user who exists but was never given a password); the generic error message is identical across all three failure cases (byte-for-byte, proving no enumeration signal). `/api/auth/logout` test proves the OLD token stops working immediately after logout — verified against a real request using the pre-logout cookie, not just checking the cookie-clearing response. A `tokenVersion` mismatch test proves `createContext` treats a stale token as unauthenticated even though its JWT signature and expiry are still valid.

`scripts/reset-password.mjs`'s behavior (password changes AND old sessions get invalidated) gets its own test proving both effects from one invocation, run against the real dev DB matching this codebase's existing script-testing convention (see `scripts/parallel-run-report.test.ts` for the pattern of testing a script's core logic without shelling out to the CLI itself).

`server/_core/loginThrottle.test.ts`: 5 failed attempts for one email locks it out (the 6th correct-password attempt still fails while locked); a *different* email is unaffected by another email's lockout; a successful login clears that email's failure count; the lockout expires after the window elapses (test controls the clock rather than sleeping 15 real minutes — inject time via a parameter or module-level override, matching whatever pattern this codebase already uses for time-dependent tests, if any exists — check before inventing a new one).

## Open Questions

None.
