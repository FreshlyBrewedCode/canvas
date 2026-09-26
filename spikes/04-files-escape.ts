/**
 * Spike 04: what can a board path make `canvas serve` read or write? A guest
 * with `edit` access controls every frame's path, so whatever `Files` accepts
 * is what a guest can reach.
 *
 *   bun spikes/04-files-escape.ts
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "../src/server/files";

const dir = mkdtempSync(join(tmpdir(), "canvas-escape-"));
mkdirSync(join(dir, ".canvas"));
writeFileSync(join(dir, ".canvas/room.json"), '{"token":"SECRET-HOST-TOKEN"}');
writeFileSync(join(dir, ".env"), "API_KEY=sk-live");
symlinkSync("/etc", join(dir, "etc-link"));

const files = new Files(dir, (path, content) =>
  console.log("read ", path, "→", JSON.stringify(content?.slice(0, 40) ?? null)),
);
for (const path of [".canvas/room.json", ".env", "etc-link/hostname"]) {
  try {
    files.watch(path);
  } catch (error) {
    console.log("refused", path, "→", (error as Error).message);
  }
}
try {
  files.write("etc-link/canvas-spike-write", "x");
  console.log("wrote  etc-link/canvas-spike-write");
} catch (error) {
  console.log("write  etc-link/canvas-spike-write →", (error as Error).message);
}
process.exit(0);
