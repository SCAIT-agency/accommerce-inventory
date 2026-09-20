import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plaintext: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false;

  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}
