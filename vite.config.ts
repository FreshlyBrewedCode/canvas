import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";

// To reach the dev server from other devices, set `CANVAS_DEV_HOST` (in the
// environment or a gitignored `.env`) to a name they resolve and put a real
// certificate for it in `.certs/dev.{crt,key}` (e.g. `tailscale cert`) — both
// local, neither in git. Absent, Vite serves plain HTTP on localhost names only.
// Only `VITE_`-prefixed variables reach the bundle, so this one stays here.
const devHost = loadEnv("development", import.meta.dirname, "CANVAS_DEV_").CANVAS_DEV_HOST;
const certFile = "./.certs/dev.crt";
const keyFile = "./.certs/dev.key";
const https =
  existsSync(certFile) && existsSync(keyFile)
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

/**
 * The web app is static: it stands in for the publicly hosted UI. It talks to
 * `canvas serve` directly from the browser (URL in the link's fragment) and to
 * other people over trystero, so there is no proxy here.
 */
export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": new URL("./src/web", import.meta.url).pathname },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4417,
    strictPort: true,
    allowedHosts: devHost ? [devHost] : [],
    https,
    fs: { allow: [import.meta.dirname] },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
