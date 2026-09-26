/**
 * Spike 05: can `canvas serve` list the files it would share and notice when
 * they change, cheaply enough to do on every change?
 *
 *   bun spikes/05-files-list-watch.ts <repo dir>
 */
import { mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";

let start = performance.now();
const listed = Bun.spawnSync(
  ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: dir },
);
const paths = listed.stdout.toString().split("\0").filter(Boolean);
const json = JSON.stringify(paths);
console.log(
  `git ls-files: ${paths.length} paths in ${(performance.now() - start).toFixed(0)} ms,`,
  `${(json.length / 1024).toFixed(0)} KiB as JSON,`,
  `${(Bun.gzipSync(json).length / 1024).toFixed(0)} KiB gzipped`,
);

start = performance.now();
const everything = Bun.spawnSync(["find", dir, "-type", "f"]).stdout.toString().split("\n");
console.log(
  `find (incl. ignored): ${everything.length} files in ${(performance.now() - start).toFixed(0)} ms`,
);

// Recursive watch: nested events on Linux, including directories created later?
const events: string[] = [];
start = performance.now();
const watcher = watch(dir, { recursive: true }, (_, name) => events.push(String(name)));
console.log(`recursive watch set up in ${(performance.now() - start).toFixed(0)} ms`);
mkdirSync(join(dir, ".spike-deep/a/b"), { recursive: true });
await Bun.sleep(100);
writeFileSync(join(dir, ".spike-deep/a/b/x.txt"), "1");
await Bun.sleep(300);
console.log("events:", [...new Set(events.filter((name) => name.includes("spike")))]);
watcher.close();
rmSync(join(dir, ".spike-deep"), { recursive: true });
