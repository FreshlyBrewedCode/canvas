/**
 * Where a frame's things are (ADR 0013, decisions 3–7): a runtime — a
 * `canvas serve`, by the id in its `.canvas/runtime.json` — and a root of it.
 * Absent means the board's own runtime and its working dir, the only root
 * there is, so boards from before need nothing: writers leave both absent
 * for those. The own runtime's id written out names the same runtime.
 *
 * Addresses come from the doc and the wire, which guests write: everything
 * here takes unknown values, and a value that is no id names nothing.
 */

/** A runtime's, root's or PTY's id: letters, digits, `-` and `_`, at most 64 (as session ids). */
export const isRuntimeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** A runtime, and a root of it; absent: the board's own runtime, its working dir. */
export interface Address {
  readonly runtime?: string;
  readonly root?: string;
}

/** An address as read from the doc or the wire, its fields not checked yet. */
export interface UncheckedAddress {
  readonly runtime?: unknown;
  readonly root?: unknown;
}

/**
 * Where an address is, for whoever is connected to `own` (null: not known
 * yet, so only absent is own): the own runtime's working dir; another runtime
 * or root, not reachable from here; or nothing at all (a value that is no id).
 */
export type Reach = "own" | "elsewhere" | "nowhere";

export function reach(address: UncheckedAddress, own: string | null | undefined): Reach {
  const { runtime, root } = address;
  if (runtime !== undefined && !isRuntimeId(runtime)) return "nowhere";
  if (root !== undefined && !isRuntimeId(root)) return "nowhere";
  if (root !== undefined) return "elsewhere";
  return runtime === undefined || runtime === own ? "own" : "elsewhere";
}

/**
 * The key a browser mirrors something of `address` under: the bare id for
 * the own runtime's, so the common case reads as it did; the address with
 * it otherwise — two runtimes may have the same session id.
 */
export function addressKey(
  address: UncheckedAddress,
  own: string | null | undefined,
  id: string,
): string {
  if (reach(address, own) === "own") return id;
  const { runtime, root } = canonical(address, own);
  // NUL is in no id and no path.
  return `${JSON.stringify([runtime ?? null, root ?? null])}\0${id}`;
}

/**
 * An address as writers write it — into the doc, a link, a message: the own
 * runtime and the working dir left absent, so the common case looks as it
 * did, and nothing but the address.
 */
export function canonical(address: UncheckedAddress, own: string | null | undefined): Address {
  const { runtime, root } = address as Address;
  return {
    ...(runtime !== undefined && runtime !== own && { runtime }),
    ...(root !== undefined && { root }),
  };
}

/** Do two addresses name the same place? Absent and the own runtime's id do. */
export const sameAddress = (
  a: UncheckedAddress,
  b: UncheckedAddress,
  own: string | null | undefined,
): boolean => addressKey(a, own, "") === addressKey(b, own, "");
