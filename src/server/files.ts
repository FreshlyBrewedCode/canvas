/**
 * Markdown artifacts are files in the working dir. The server watches the
 * ones on the board and reports every change (the agent editing a file shows
 * up live); the host's browser writes collaborative edits back. Board paths
 * come from guests, so every path goes through the shared set (ADR 0002).
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import { SharedSet } from "./shared-set";

export class Files {
  private readonly shared: SharedSet;
  private readonly watchers = new Map<string, FSWatcher>();
  /** Last content seen or written per path, so our own writes don't echo back. */
  private readonly last = new Map<string, string | null>();

  constructor(
    dir: string,
    private readonly onChange: (path: string, content: string | null) => void,
  ) {
    this.shared = new SharedSet(dir);
  }

  private read(path: string): string | null {
    const absolute = this.shared.resolve(path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  }

  watch(path: string): void {
    const content = this.read(path);
    this.last.set(path, content);
    this.onChange(path, content);
    if (this.watchers.has(path)) return;

    const absolute = this.shared.resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    // Watch the directory: editors and agents often replace files rather
    // than write them in place, which a file watcher loses track of.
    const watcher = watch(dirname(absolute), (_, name) => {
      if (name !== null && resolve(dirname(absolute), name) !== absolute) return;
      let next: string | null;
      try {
        next = this.read(path);
      } catch {
        next = null; // replaced by something no longer shared, e.g. a symlink out
      }
      if (next === this.last.get(path)) return;
      this.last.set(path, next);
      this.onChange(path, next);
    });
    this.watchers.set(path, watcher);
  }

  write(path: string, content: string): void {
    const absolute = this.shared.resolve(path);
    if (this.last.get(path) === content) return;
    this.last.set(path, content);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}
