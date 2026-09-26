/**
 * Files of the working dir, read-only (ADR 0002). The host's browser opens
 * the paths its file frames show; the server sends each one now and again on
 * every change (an agent writing a file shows up live), and the list of all
 * shared files whenever it changes. Board paths come from guests, so every
 * read goes through the shared set.
 *
 * One recursive watcher covers the working dir: editors and agents often
 * replace files rather than write them in place, and a frame may wait for a
 * file (or its directory) that does not exist yet.
 */

import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { FileContent } from "../shared/protocol";
import { SharedSet } from "./shared-set";

export const MAX_FILE_BYTES = 1024 * 1024;
const SETTLE_MS = 150;

export class Files {
  private readonly shared: SharedSet;
  /** Open paths → the clients that opened them. */
  private readonly subscribers = new Map<string, Set<unknown>>();
  /** What each open path last looked like, to only report real changes. */
  private readonly last = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private treeWatched = false;
  private lastTree = "";
  private changed = new Set<string>();
  private everything = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    dir: string,
    private readonly onFile: (path: string, file: FileContent) => void,
    private readonly onTree: (paths: ReadonlyArray<string>) => void,
  ) {
    this.shared = new SharedSet(dir);
  }

  read(path: string): FileContent {
    let absolute: string;
    try {
      absolute = this.shared.resolve(path);
    } catch (error) {
      return { kind: "denied", reason: (error as Error).message };
    }
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat) return { kind: "missing" };
    if (!stat.isFile()) return { kind: "denied", reason: `${path} is not a file` };
    if (stat.size > MAX_FILE_BYTES) return { kind: "too-large", size: stat.size };
    const bytes = readFileSync(absolute);
    if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary", size: stat.size };
    return { kind: "text", text: bytes.toString("utf8") };
  }

  open(path: string, client: unknown): void {
    let set = this.subscribers.get(path);
    if (!set) this.subscribers.set(path, (set = new Set()));
    set.add(client);
    this.send(path);
    this.ensureWatcher();
  }

  close(path: string, client: unknown): void {
    const set = this.subscribers.get(path);
    set?.delete(client);
    if (set?.size) return;
    this.subscribers.delete(path);
    this.last.delete(path);
  }

  /** A client went away: close everything it had open. */
  drop(client: unknown): void {
    for (const path of [...this.subscribers.keys()]) this.close(path, client);
  }

  watchTree(): void {
    this.treeWatched = true;
    this.lastTree = "";
    this.sendTree();
    this.ensureWatcher();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }

  private send(path: string) {
    const file = this.read(path);
    const key = JSON.stringify(file);
    if (this.last.get(path) === key) return;
    this.last.set(path, key);
    this.onFile(path, file);
  }

  private sendTree() {
    const paths = this.shared.list();
    const key = paths.join("\0");
    if (key === this.lastTree) return;
    this.lastTree = key;
    this.onTree(paths);
  }

  private ensureWatcher() {
    if (this.watcher) return;
    this.watcher = watch(this.shared.dir, { recursive: true }, (_, name) => {
      if (name === null) this.everything = true;
      else {
        const path = name.split(sep).join("/");
        // Our own state (the board is saved every few hundred ms).
        if (path === ".canvas" || path.startsWith(".canvas/")) return;
        this.changed.add(path);
      }
      if (!this.timer) this.timer = setTimeout(() => this.settle(), SETTLE_MS);
    });
  }

  /** A burst of changes is over: re-read what it touched. */
  private settle() {
    this.timer = null;
    const changed = this.changed;
    const everything = this.everything;
    this.changed = new Set();
    this.everything = false;
    for (const path of this.subscribers.keys()) {
      // The file itself, or a directory above it (renamed, created, removed).
      const touched =
        everything || changed.has(path) || [...changed].some((name) => path.startsWith(`${name}/`));
      if (touched) this.send(path);
    }
    if (this.treeWatched) this.sendTree();
  }
}
