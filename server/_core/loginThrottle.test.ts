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
});
