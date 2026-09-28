/**
 * Who may use a `canvas relay` (ADR 0008). The relay's operator gives each
 * host (or team) an issuer key; `canvas serve` signs tokens with it, one for
 * the host and one for guest links, each good for one relay room
 * (`shared/relay-room.ts`) and 30 days. The relay checks them statelessly: the
 * issuer is still configured, the HMAC matches, the room is the one joined,
 * the token hasn't expired. Removing an issuer revokes all it signed.
 *
 *   v1.<issuer>.<room>.<h|g>.<expires, unix seconds>.<HMAC-SHA256, base64url>
 *
 * Only `canvas serve` and the relay handle tokens; peers pass them on.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type RelayRole = "host" | "guest";

export interface RelayToken {
  readonly issuer: string;
  readonly room: string;
  readonly role: RelayRole;
  /** Unix seconds. */
  readonly expires: number;
}

export interface Issuer {
  readonly name: string;
  readonly secret: string;
}

export const TOKEN_DAYS = 30;
const VERSION = "v1";
const ROLE = { host: "h", guest: "g" } as const;

const hmac = (secret: string, text: string) =>
  createHmac("sha256", secret).update(text).digest("base64url");

export function signRelayToken(
  issuer: Issuer,
  room: string,
  role: RelayRole,
  now = Date.now(),
): string {
  const expires = Math.floor(now / 1000) + TOKEN_DAYS * 86_400;
  const body = [VERSION, issuer.name, room, ROLE[role], expires].join(".");
  return `${body}.${hmac(issuer.secret, body)}`;
}

export type TokenCheck =
  | { readonly ok: true; readonly token: RelayToken }
  | { readonly ok: false; readonly reason: string };

/** `issuers`: issuer name → secret, as the relay is configured. */
export function verifyRelayToken(
  text: string,
  issuers: ReadonlyMap<string, string>,
  now = Date.now(),
): TokenCheck {
  const parts = text.split(".");
  if (parts.length !== 6 || parts[0] !== VERSION) return { ok: false, reason: "malformed token" };
  const [, issuer, room, role, expires, signature] = parts as [string, ...string[]];
  const secret = issuers.get(issuer!);
  if (secret === undefined) return { ok: false, reason: `unknown issuer ${issuer}` };
  const expected = Buffer.from(hmac(secret, parts.slice(0, 5).join(".")));
  const given = Buffer.from(signature!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "bad signature" };
  if (role !== "h" && role !== "g") return { ok: false, reason: "bad role" };
  const seconds = Number(expires);
  if (!Number.isFinite(seconds) || seconds * 1000 < now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    token: {
      issuer: issuer!,
      room: room!,
      role: role === "h" ? "host" : "guest",
      expires: seconds,
    },
  };
}

/** `name:secret,name:secret`: how issuer keys are configured (`CANVAS_RELAY_KEYS`). */
export function parseIssuers(text: string): Map<string, string> {
  const issuers = new Map<string, string>();
  for (const entry of text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const colon = entry.indexOf(":");
    if (colon <= 0 || colon === entry.length - 1)
      throw new Error(`issuer key "${entry}" is not name:secret`);
    const name = entry.slice(0, colon);
    if (!/^[\w-]+$/.test(name))
      throw new Error(`issuer name "${name}" may only use letters, digits, _ and -`);
    issuers.set(name, entry.slice(colon + 1));
  }
  return issuers;
}

/** One `name:secret` (`CANVAS_RELAY_KEY`): the issuer key a host signs with. */
export function parseIssuer(text: string): Issuer {
  const issuers = [...parseIssuers(text)];
  if (issuers.length !== 1) throw new Error("the relay key is one name:secret");
  const [[name, secret]] = issuers as [[string, string]];
  return { name, secret };
}
