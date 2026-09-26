/**
 * The files `canvas serve` is willing to show anyone (ADR 0002). Board paths
 * are chosen by guests, so this is the ceiling of what a frame can reach:
 *
 *  - inside the working dir, after resolving symlinks;
 *  - not in `.git/` or `.canvas/`, and not a well-known secret file;
 *  - in a git repo: not ignored by git (tracked files count as not ignored);
 *    outside git: not under `node_modules/` or a dot-directory.
 *
 * The tree lists the same set. The server cannot tell the host's own requests
 * from a guest's, so the host sees the same set.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HIDDEN_DIRS = new Set([".git", ".canvas"]);
const SECRET_NAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "id_dsa",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const HARMLESS_ENV = /\.(example|sample|template)$/;
/** A walk outside git stops here rather than stream a whole disk. */
const WALK_LIMIT = 50_000;

/** Why a working-dir-relative path is never shared, whatever git says; null if it may be. */
export function refusal(path: string): string | null {
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => HIDDEN_DIRS.has(segment)))
    return "canvas never shares .git or .canvas";
  const name = segments.at(-1) ?? "";
  if (
    SECRET_NAMES.has(name) ||
    (name.startsWith(".env.") && !HARMLESS_ENV.test(name)) ||
    SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))
  )
    return "looks like a secret";
  return null;
}

export class SharedSet {
  readonly dir: string;
  readonly git: boolean;

  constructor(dir: string) {
    this.dir = realpathSync(dir);
    this.git = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: this.dir })
      .stdout.toString()
      .startsWith("true");
  }

  /**
   * The absolute path behind a board path, if it is shared; throws why not.
   * The file need not exist yet — an agent may be about to write it.
   */
  resolve(path: string): string {
    if (!path || isAbsolute(path) || path.includes("\0"))
      throw new Error(`not a file path: ${path}`);
    const absolute = resolve(this.dir, path);
    const rel = relative(this.dir, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`${path} is outside the working dir`);
    this.check(rel, path);

    // Symlinks: what the path really points at must pass the same rules.
    let real: string;
    try {
      real = realpathOfNearest(absolute);
    } catch {
      throw new Error(`${path} is a broken link`);
    }
    const realRel = relative(this.dir, real);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel))
      throw new Error(`${path} links outside the working dir`);
    if (realRel && realRel !== rel) this.check(realRel, path);
    return absolute;
  }

  private check(rel: string, path: string) {
    const refused = refusal(rel);
    if (refused) throw new Error(`${path} is not shared: ${refused}`);
    if (this.git) {
      // 0: ignored, 1: not ignored, 128: git refuses (e.g. beyond a symlink).
      const { exitCode } = Bun.spawnSync(["git", "check-ignore", "-q", "--", rel], {
        cwd: this.dir,
      });
      if (exitCode !== 1) throw new Error(`${path} is not shared: ignored by git`);
    } else if (
      rel
        .split(sep)
        .some((s, i, all) => s === "node_modules" || (s.startsWith(".") && i < all.length - 1))
    )
      throw new Error(`${path} is not shared: in a hidden or dependency dir`);
  }

  /** Every shared file, as working-dir-relative paths with `/` separators. */
  list(): string[] {
    if (!this.git) return this.walk();
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "ls-files", "-z", ...args], { cwd: this.dir })
        .stdout.toString()
        .split("\0")
        .filter(Boolean);
    const deleted = new Set(git("--deleted"));
    return [...new Set(git("--cached", "--others", "--exclude-standard"))]
      .filter((path) => !deleted.has(path) && !refusal(path))
      .sort();
  }

  private walk(): string[] {
    const paths: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (paths.length >= WALK_LIMIT) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          visit(path);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const rel = relative(this.dir, path).split(sep).join("/");
          if (!refusal(rel)) paths.push(rel);
        }
      }
    };
    visit(this.dir);
    return paths.sort();
  }
}

/**
 * realpath of the path, or of its nearest ancestor that exists (plus the
 * rest). A dangling symlink counts as existing, so it throws rather than let
 * a later write follow it.
 */
function realpathOfNearest(absolute: string): string {
  let existing = absolute;
  while (!lstatSync(existing, { throwIfNoEntry: false }) && dirname(existing) !== existing)
    existing = dirname(existing);
  return join(realpathSync(existing), relative(existing, absolute));
}
