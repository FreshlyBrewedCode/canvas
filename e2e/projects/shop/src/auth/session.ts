import { randomBytes } from "node:crypto";

const sessions = new Map<string, { userId: string; expires: number }>();

/** A new session for a user, valid for a day. */
export function createSession(userId: string): string {
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, { userId, expires: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

/** The user a session token belongs to, if it is still valid. */
export function userOf(token: string): string | null {
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) return null;
  return session.userId;
}

export function endSession(token: string): void {
  sessions.delete(token);
}
