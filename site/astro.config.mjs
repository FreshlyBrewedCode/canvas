// @ts-check
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "vite";

// Same arrangement as the app's `vite.config.ts` one level up, sharing its
// `.env`: `CANVAS_DEV_HOST` names the host other devices reach the dev server
// on, `../.certs/dev.{crt,key}` is a real certificate for it, both local and
// kept out of git. Absent, the dev server falls back to plain HTTP so a fresh
// checkout still runs.
const devHost = loadEnv("development", "..", "CANVAS_DEV_").CANVAS_DEV_HOST;
const certFile = "../.certs/dev.crt";
const keyFile = "../.certs/dev.key";
const httpsOptions =
  existsSync(certFile) && existsSync(keyFile)
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

export default defineConfig({
  site: "https://canvas.frebreco.de",

  // No `redirects` entry for `/docs`. On static hosting Astro can only compile
  // one into a meta-refresh stub, and an unstyled stub paints white before it
  // bounces. `pages/docs/[...slug].astro` renders the entry page at `/docs`
  // instead — same destination, no flash.

  // Expressive Code's own options live in `ec.config.mjs` — see the note there.
  integrations: [expressiveCode()],

  // Bound to all interfaces, not just loopback, so the dev server is shareable.
  server: { host: "0.0.0.0", port: Number(process.env.PORT) || 4419 },

  vite: {
    plugins: [tailwind()],
    server: {
      // Vite rejects host headers that aren't localhost or an IP by default
      // (CVE-2025-30208 hardening); the dev host name needs an explicit allow.
      allowedHosts: devHost ? [devHost] : [],
      https: httpsOptions,
    },
  },
});
