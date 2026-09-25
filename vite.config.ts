import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// `tailscale cert --cert-file .certs/dev.crt --key-file .certs/dev.key
// dev.example.ts.net` — a real, publicly-trusted cert for the tailnet
// MagicDNS name, kept out of git. Absent, Vite serves plain HTTP.
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
    allowedHosts: ["dev.example.ts.net"],
    https,
    fs: { allow: [import.meta.dirname] },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
