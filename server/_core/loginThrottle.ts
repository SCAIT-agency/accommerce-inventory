// In-process, per-email tracking only — no persistent store. Resets on
// process restart (acceptable at this deployment's scale: infrequent
// restarts, ~4-5 trusted users, no adversary sophisticated enough to time a
// deploy). Per-email rather than per-IP so that legitimate users sharing an
// office network never lock each other out — see the design doc Section 5.
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Entry {
  count: number;
  windowStart: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, Entry>();

export function isLocked(email: string, now: number = Date.now()): boolean {
  const entry = attempts.get(email);
  if (!entry) return false;

  if (entry.lockedUntil !== null) {
    if (now < entry.lockedUntil) return true;
    attempts.delete(email);
    return false;
  }

  if (now - entry.windowStart > WINDOW_MS) {
    attempts.delete(email);
    return false;
  }

  return false;
}

export function recordFailedAttempt(email: string, now: number = Date.now()): void {
  const entry = attempts.get(email);

  if (entry?.lockedUntil !== null && entry?.lockedUntil !== undefined) {
    // Already locked — a retry during lockout must not extend it further,
    // or a scripted retry loop could keep a legitimate user locked out
    // indefinitely.
    if (now < entry.lockedUntil) return;
    attempts.delete(email);
  }

  const current = attempts.get(email);
  if (!current || now - current.windowStart > WINDOW_MS) {
    attempts.set(email, { count: 1, windowStart: now, lockedUntil: null });
    return;
  }

  current.count += 1;
  if (current.count >= MAX_ATTEMPTS) {
    current.lockedUntil = now + LOCKOUT_MS;
  }
}

export function clearAttempts(email: string): void {
  attempts.delete(email);
}
