import { describe, it, expect, beforeEach } from "vitest";
import { isLocked, recordFailedAttempt, clearAttempts } from "./loginThrottle";

const EMAIL = "julian@accommerce.example";
const OTHER_EMAIL = "andrew@accommerce.example";
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

describe("login throttle", () => {
  beforeEach(() => {
    clearAttempts(EMAIL);
    clearAttempts(OTHER_EMAIL);
  });

  it("is not locked with no prior attempts", () => {
    expect(isLocked(EMAIL)).toBe(false);
  });

  it("locks after 5 failed attempts within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 5000)).toBe(true);
  });

  it("does not lock after only 4 failed attempts", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 4000)).toBe(false);
  });

  it("a different email is unaffected by this email's lockout", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(OTHER_EMAIL, now + 5000)).toBe(false);
  });

  it("clearAttempts lifts a lockout immediately", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    expect(isLocked(EMAIL, now + 5000)).toBe(true);
    clearAttempts(EMAIL);
    expect(isLocked(EMAIL, now + 5000)).toBe(false);
  });

  it("the counting window resets if 15 minutes pass without hitting 5 attempts", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    // Well past the window, with no 5th attempt yet — the first 4 should no
    // longer count, so one more failure here starts a fresh count of 1.
    recordFailedAttempt(EMAIL, now + WINDOW_MS + 60_000);
    expect(isLocked(EMAIL, now + WINDOW_MS + 60_000)).toBe(false);
  });

  it("a lockout expires after its own 15-minute duration", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    const lockedAt = now + 5000;
    expect(isLocked(EMAIL, lockedAt)).toBe(true);
    expect(isLocked(EMAIL, lockedAt + LOCKOUT_MS + 1)).toBe(false);
  });

  it("a failed attempt during an active lockout does not extend it", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailedAttempt(EMAIL, now + i * 1000);
    const lockedAt = now + 5000;
    expect(isLocked(EMAIL, lockedAt)).toBe(true);
    // A retry attempt while already locked must not push the expiry further out.
    recordFailedAttempt(EMAIL, lockedAt + 1000);
    expect(isLocked(EMAIL, lockedAt + LOCKOUT_MS + 1)).toBe(false);
  });

  it("evicts the oldest tracked email once MAX_TRACKED_EMAILS is exceeded", () => {
    const now = 2_000_000;
    // Fill to capacity with distinct emails, each with 1 failed attempt.
    for (let i = 0; i < 10_000; i++) {
      recordFailedAttempt(`flood-${i}@example.com`, now);
    }
    // One more distinct email should evict the very first one tracked.
    recordFailedAttempt("flood-10000@example.com", now);

    // The oldest entry's failure count should have been forgotten — a fresh
    // failed attempt against it now starts a new count of 1, not 2, so 4 more
    // failures (5 total post-eviction) should NOT lock it, proving eviction
    // actually happened rather than just capping silently. Without eviction,
    // flood-0 already carries 1 failure from the fill loop above, so these
    // same 4 calls would reach count 5 and WOULD lock it — this is what
    // makes the assertion below actually discriminate working eviction from
    // a silently-broken cap (an earlier version of this test used 3
    // iterations here, which passed regardless of whether eviction worked).
    for (let i = 0; i < 4; i++) recordFailedAttempt("flood-0@example.com", now + 1000 + i);
    expect(isLocked("flood-0@example.com", now + 5000)).toBe(false);

    clearAttempts("flood-0@example.com");
    for (let i = 0; i < 10_001; i++) clearAttempts(`flood-${i}@example.com`);
  });
});
