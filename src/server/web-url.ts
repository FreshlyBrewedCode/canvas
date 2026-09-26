/**
 * The web app a host link opens, when neither `--web-url` nor `CANVAS_WEB_URL`
 * says otherwise. The hosted UI speaks the same `protocol.ts` as the CLI of
 * its release channel, so the default follows the version `canvas serve` runs
 * as: `scripts/build-release.ts` stamps it into the published `package.json`;
 * the repo's own manifest has none, which means a checkout and the Vite dev
 * server.
 */

export const STABLE_WEB_URL = "https://ui.canvas.frebreco.de";
export const NEXT_WEB_URL = `${STABLE_WEB_URL}/next`;
export const DEV_WEB_URL = "http://localhost:4417";

export function defaultWebUrl(version: string | undefined): string {
  if (!version) return DEV_WEB_URL;
  // semver: a pre-release is anything with a `-` suffix, here `X.Y.Z-next.N`.
  return version.includes("-") ? NEXT_WEB_URL : STABLE_WEB_URL;
}
