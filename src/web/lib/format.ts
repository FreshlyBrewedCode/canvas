/** Short human forms of durations and token counts, for the agent thread. */

/** `12s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `950`, `19.2k`, `200k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const [value, unit] = n < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"];
  return `${value < 100 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
}

/** `$0.12`, `€3.40`, `1.50 XYZ`. */
export function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
