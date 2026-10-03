import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A salted hash of a password, as `salt:hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

/** Whether `password` is the one `stored` was made from. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const attempt = createHash("sha256").update(salt + password).digest("hex");
  return timingSafeEqual(Buffer.from(attempt), Buffer.from(hash));
}
