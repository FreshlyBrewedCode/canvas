/**
 * What `tsconfig.authority.json` adds to Bun's globals: the Web Crypto types
 * TypeScript keeps in its DOM lib, though Bun has them too. Nothing else of
 * the DOM: the board's authority must run without one (ADR 0013, #110).
 */

type JsonWebKey = import("node:crypto").webcrypto.JsonWebKey;
type BufferSource = import("node:crypto").webcrypto.BufferSource;
