/**
 * Markdown artifacts are files in the working dir. The server watches the
 * ones on the board and reports every change (the agent editing a file shows
 * up live); the host's browser writes collaborative edits back.
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export class Files {
  private readonly watchers = new Map<string, FSWatcher>();
  /** Last content seen or written per path, so our own writes don't echo back. */
  private readonly last = new Map<string, string | null>();

  constructor(
    private readonly dir: string,
    private readonly onChange: (path: string, content: string | null) => void,
  ) {}

  /** Resolve a board path inside the working dir, refusing anything outside it. */
  private resolve(path: string): string {
    const absolute = resolve(this.dir, path);
    const rel = relative(this.dir, absolute);
    if (rel.startsWith("..") || resolve(this.dir, rel) !== absolute)
      throw new Error(`path escapes the working dir: ${path}`);
    return absolute;
  }

  private read(path: string): string | null {
    const absolute = this.resolve(path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  }

  watch(path: string): void {
    const content = this.read(path);
    this.last.set(path, content);
    this.onChange(path, content);
    if (this.watchers.has(path)) return;

    const absolute = this.resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    // Watch the directory: editors and agents often replace files rather
    // than write them in place, which a file watcher loses track of.
    const watcher = watch(dirname(absolute), (_, name) => {
      if (name !== null && resolve(dirname(absolute), name) !== absolute) return;
      const next = this.read(path);
      if (next === this.last.get(path)) return;
      this.last.set(path, next);
      this.onChange(path, next);
    });
    this.watchers.set(path, watcher);
  }

  write(path: string, content: string): void {
    const absolute = this.resolve(path);
    if (this.last.get(path) === content) return;
    this.last.set(path, content);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}
