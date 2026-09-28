/**
 * `canvas relay`'s settings (ADR 0008): environment variables, which a flag
 * overrides where there is one. Issuer keys only come from the environment:
 * flags show in process lists.
 *
 *   CANVAS_RELAY_KEYS             name:secret[,name:secret]   required
 *   CANVAS_RELAY_PORT   --port    4419
 *   CANVAS_RELAY_HOST   --host    0.0.0.0
 *   CANVAS_RELAY_TLS_CERT --cert  serve wss:// itself (else put it behind a TLS proxy)
 *   CANVAS_RELAY_TLS_KEY  --key
 *   CANVAS_RELAY_MAX_PEERS        64     peers in one room
 *   CANVAS_RELAY_MAX_CONNECTIONS  256    open connections per issuer
 *   CANVAS_RELAY_MAX_MESSAGE_MB   64     one message (a whole agent thread goes in one)
 *   CANVAS_RELAY_RATE             500    messages per second per connection
 *   CANVAS_RELAY_BANDWIDTH_MB     20     MB per second per connection
 */

import { parseIssuers } from "./relay-token";

export interface RelayConfig {
  readonly port: number;
  readonly hostname: string;
  readonly issuers: ReadonlyMap<string, string>;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly limits: RelayLimits;
}

export interface RelayLimits {
  readonly peersPerRoom: number;
  readonly connectionsPerIssuer: number;
  /** Bytes. */
  readonly maxMessage: number;
  /** Messages per second, per connection; bursts up to 4 s worth. */
  readonly messagesPerSecond: number;
  /** Bytes per second, per connection; bursts up to 4 s worth. */
  readonly bytesPerSecond: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  peersPerRoom: 64,
  connectionsPerIssuer: 256,
  maxMessage: 64 * 1024 * 1024,
  messagesPerSecond: 500,
  bytesPerSecond: 20 * 1024 * 1024,
};

export interface RelayFlags {
  readonly port?: string;
  readonly host?: string;
  readonly cert?: string;
  readonly key?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function relayConfig(env: Env, flags: RelayFlags = {}): RelayConfig {
  const issuers = parseIssuers(env.CANVAS_RELAY_KEYS ?? "");
  if (issuers.size === 0)
    throw new Error("canvas relay needs issuer keys: CANVAS_RELAY_KEYS=name:secret[,name:secret]");
  const cert = flags.cert ?? env.CANVAS_RELAY_TLS_CERT;
  const key = flags.key ?? env.CANVAS_RELAY_TLS_KEY;
  if (Boolean(cert) !== Boolean(key))
    throw new Error("TLS needs both a certificate and its key (CANVAS_RELAY_TLS_CERT and _KEY)");
  const number = (name: string, fallback: number, scale = 1) => {
    const text = env[name];
    if (text === undefined || text === "") return Math.round(fallback * scale);
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return Math.round(value * scale);
  };
  const MB = 1024 * 1024;
  return {
    port: Number(flags.port ?? env.CANVAS_RELAY_PORT ?? 4419),
    hostname: flags.host ?? env.CANVAS_RELAY_HOST ?? "0.0.0.0",
    issuers,
    ...(cert && key && { tls: { cert, key } }),
    limits: {
      peersPerRoom: number("CANVAS_RELAY_MAX_PEERS", DEFAULT_LIMITS.peersPerRoom),
      connectionsPerIssuer: number(
        "CANVAS_RELAY_MAX_CONNECTIONS",
        DEFAULT_LIMITS.connectionsPerIssuer,
      ),
      maxMessage: number("CANVAS_RELAY_MAX_MESSAGE_MB", DEFAULT_LIMITS.maxMessage / MB, MB),
      messagesPerSecond: number("CANVAS_RELAY_RATE", DEFAULT_LIMITS.messagesPerSecond),
      bytesPerSecond: number("CANVAS_RELAY_BANDWIDTH_MB", DEFAULT_LIMITS.bytesPerSecond / MB, MB),
    },
  };
}
