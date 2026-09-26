/**
 * What a browser frame's URL points at, as seen by the viewer (ADR 0004).
 * The URL comes from the board, so from any edit guest: only http(s) loads,
 * and a loopback URL means each viewer's own machine — so only the host,
 * whose machine the board is about, loads it.
 */
export type BrowserTarget =
  | { readonly kind: "web" }
  /** `host` as the URL names it, e.g. `localhost:5173`. */
  | { readonly kind: "loopback"; readonly host: string }
  | { readonly kind: "invalid" };

export function browserTarget(url: string): BrowserTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { kind: "invalid" };
  return isLoopback(parsed.hostname) ? { kind: "loopback", host: parsed.host } : { kind: "web" };
}

/** What someone typed into the address bar: no scheme means https, or http on loopback. */
export function typedUrl(draft: string): string {
  const text = draft.trim();
  if (/^[a-z]+:\/\//i.test(text)) return text;
  const http = `http://${text}`;
  return browserTarget(http).kind === "loopback" ? http : `https://${text}`;
}

/**
 * `URL` already normalizes the host: lowercase, IPv4 shorthands (`127.1`,
 * `2130706433`) spelled out, IPv6 compressed and bracketed.
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "[::]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
  );
}
