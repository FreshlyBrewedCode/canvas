import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";

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
 * Excalidraw's fonts (drawing frames, ADR 0009), served by the app at
 * `excalidraw/fonts/` rather than fetched from Excalidraw's CDN
 * (`web/lib/drawing-kit.ts` points it here).
 */
function excalidrawFonts(): Plugin {
  const fonts = join(import.meta.dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  return {
    name: "canvas:excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use("/excalidraw/fonts", (req, res, next) => {
        const file = join(fonts, decodeURIComponent((req.url ?? "").split("?")[0]!));
        if (!file.startsWith(fonts + sep) || !existsSync(file) || !statSync(file).isFile())
          return next();
        res.setHeader("content-type", "font/woff2");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      cpSync(fonts, join(options.dir!, "excalidraw/fonts"), { recursive: true });
    },
  };
}

/**
 * The web app is static: it stands in for the publicly hosted UI. It talks to
 * `canvas serve` directly from the browser (URL in the link's fragment) and to
 * other people over trystero, so there is no proxy here.
 */
export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss(), excalidrawFonts()],
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
