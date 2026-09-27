/**
 * The web app and `canvas serve` are released together and speak the same
 * `protocol.ts`, but a browser can hold on to an older page (a tab open
 * across a release, a cached `index.html`) and a host can run an older CLI.
 * Neither fails loudly — newer fields are just ignored — so the board says
 * when the two differ.
 *
 * `ui.yml` stamps the release into the build as `VITE_CANVAS_VERSION`; the
 * dev server has none.
 */

export const PAGE_VERSION: string | null = import.meta.env.VITE_CANVAS_VERSION || null;

export type VersionSkew = "page-older" | "serve-older";

export function versionSkew(
  page: string | null,
  serve: string | null | undefined,
): VersionSkew | null {
  if (!page || !serve) return null;
  const order = compareVersions(page, serve);
  return order < 0 ? "page-older" : order > 0 ? "serve-older" : null;
}

/** Semver precedence of `X.Y.Z[-pre.release]`; build metadata is not used here. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const order = (Number(coreA[i]) || 0) - (Number(coreB[i]) || 0);
    if (order) return Math.sign(order);
  }
  // A pre-release comes before its release.
  if (!preA.length || !preB.length) return preB.length - preA.length;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Math.sign(Number(x) - Number(y));
    // Numeric identifiers come before alphanumeric ones.
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function split(version: string): [string[], string[]] {
  const dash = version.indexOf("-");
  const core = dash < 0 ? version : version.slice(0, dash);
  const pre = dash < 0 ? "" : version.slice(dash + 1);
  return [core.split("."), pre ? pre.split(".") : []];
}
