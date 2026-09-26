/**
 * Scratch files (ADR 0005): content an agent writes for the board only —
 * a write-up, an HTML visualisation — kept in `<dir>/.canvas/scratch/`, out
 * of the project. Board paths name them `canvas:scratch/<name>`; they are
 * read like the shared set's files and mirrored the same way.
 *
 * Only agents write them, through their board tools: nothing a browser
 * sends reaches `create` or `write`. One flat namespace; a name is never
 * taken twice, so creating one never overwrites another agent's file.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SCRATCH_PREFIX } from "../shared/board-tools";
import type { FileContent } from "../shared/protocol";

export const MAX_SCRATCH_BYTES = 1024 * 1024;

export const isScratchPath = (path: string) => path.startsWith(SCRATCH_PREFIX);

/** A name as agents may give it: one plain segment, e.g. `auth-overview.md`. */
const NAME = /^[\w][\w.-]*$/;

export class Scratch {
  private readonly dir: string;

  constructor(
    root: string,
    /** A scratch file was written: `canvas:scratch/<name>`. */
    private readonly onChange: (path: string) => void = () => {},
  ) {
    this.dir = join(root, ".canvas", "scratch");
  }

  /** A new file, under `name` or, if that is taken, `name-2`, `name-3`…; its path. */
  create(name: string, text: string): string {
    checkName(name);
    checkSize(text);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let free = name;
    for (let n = 2; existsSync(join(this.dir, free)); n++) free = `${stem}-${n}${ext}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, free), text);
    const path = SCRATCH_PREFIX + free;
    this.onChange(path);
    return path;
  }

  /** Overwrite an existing scratch file. */
  write(path: string, text: string): void {
    const name = this.name(path);
    if (!existsSync(join(this.dir, name)))
      throw new Error(`${path} doesn't exist; give a name to create it`);
    checkSize(text);
    writeFileSync(join(this.dir, name), text);
    this.onChange(path);
  }

  /** Undo a `create` whose board call failed. */
  remove(path: string): void {
    rmSync(join(this.dir, this.name(path)), { force: true });
    this.onChange(path);
  }

  read(path: string): FileContent {
    let name: string;
    try {
      name = this.name(path);
    } catch (error) {
      return { kind: "denied", reason: (error as Error).message };
    }
    const file = join(this.dir, name);
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return { kind: "missing" };
    if (stat.size > MAX_SCRATCH_BYTES) return { kind: "too-large", size: stat.size };
    return { kind: "text", text: readFileSync(file, "utf8") };
  }

  /** Every scratch file's path, sorted. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && NAME.test(entry.name))
      .map((entry) => SCRATCH_PREFIX + entry.name)
      .sort();
  }

  private name(path: string): string {
    if (!isScratchPath(path)) throw new Error(`not a scratch file: ${path}`);
    const name = path.slice(SCRATCH_PREFIX.length);
    checkName(name);
    return name;
  }
}

function checkName(name: string) {
  if (!NAME.test(name) || name.length > 120)
    throw new Error(
      `scratch file names are one plain segment of letters, digits, '.', '_' and '-' (got ${JSON.stringify(name)})`,
    );
}

function checkSize(text: string) {
  if (Buffer.byteLength(text) > MAX_SCRATCH_BYTES)
    throw new Error("scratch files are at most 1 MiB");
}
