/**
 * Links in markdown and HTML on the board, read as places on it (ADR 0007).
 *
 * A link names a frame, a file, or both, and optionally a place inside:
 *
 *   #frame=<id>[&path=<file>][&lines=10-20][&heading=<slug>][&comment=<id>]
 *   src/auth/session.ts, src/auth/session.ts#L10-L20, /abs/cwd/src/a.ts:42
 *   docs/setup.md#install, #install (a heading of the file the link is in)
 *   canvas:scratch/overview.md
 *
 * The board form is the fragment's own `key=value` form, so a page URL with
 * it (`…#k=…&pk=…&frame=abc`) is a deep link. File paths are read the way
 * GitHub, editors and agents write them. Everything here is text: whether a
 * path is in the shared set, or a frame on the board, is for the caller.
 */

import { SCRATCH_PREFIX } from "../../shared/board-tools";
import type { LineRange } from "./board";

/** A place on the board. Without `frame`: wherever `path` shows, or a new frame. */
export interface LinkTarget {
  readonly frame?: string;
  /** Working-dir-relative, or a scratch file. */
  readonly path?: string;
  readonly lines?: LineRange;
  /** A markdown heading, by its slug (`slug`). */
  readonly heading?: string;
  /** A comment of `frame` (ADR 0006). */
  readonly comment?: string;
}

export type Link =
  | { readonly kind: "board"; readonly target: LinkTarget }
  | { readonly kind: "web"; readonly url: string };

/** Where a link sits, to read relative paths against. */
export interface LinkBase {
  /** The working dir: absolute paths under it are project files. */
  readonly cwd?: string | null;
  /** The file the link is in; none for an agent's reply or a comment (the working dir). */
  readonly file?: string | null;
}

const BOARD_KEYS = ["frame", "path", "lines", "heading", "comment"] as const;

/** A link's `href`, or null for one that goes nowhere canvas can follow. */
export function parseLink(href: string, base: LinkBase = {}): Link | null {
  const text = href.trim();
  if (!text) return null;
  if (text.startsWith("#")) {
    const target = readHash(text);
    if (target) return { kind: "board", target };
    // A heading of this file; elsewhere there is nothing to scroll.
    const heading = headingOf(text.slice(1));
    return base.file && heading ? { kind: "board", target: { path: base.file, heading } } : null;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto")
    return { kind: "web", url: text };
  if (text.startsWith("//") || (scheme && !text.startsWith(SCRATCH_PREFIX))) return null;
  const target = fileTarget(text, base);
  return target && { kind: "board", target };
}

/**
 * Inline code that reads as a file reference — `src/a.ts`, `src/a.ts:42`,
 * `src/a.ts:10-20` — as agents write them. Anything could look like one
 * (`foo.bar`): the caller keeps only paths that exist.
 */
export function parseCodeRef(code: string, base: LinkBase = {}): LinkTarget | null {
  const text = code.trim();
  if (!text || text.length > 300 || /[\s`'"<>|*?(){}[\]\\,;]/.test(text)) return null;
  if (!/[./]/.test(text) || /^[-.]+$/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    return null;
  return fileTarget(text, { cwd: base.cwd });
}

/** The board part of a fragment (`#k=…&frame=…`), if it has one. */
export function readHash(fragment: string): LinkTarget | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const frame = params.get("frame") || undefined;
  const path = params.get("path") || undefined;
  if (!frame && !path) return null;
  const lines = linesOf(params.get("lines") ?? "");
  const heading = params.get("heading") || undefined;
  const comment = (frame && params.get("comment")) || undefined;
  return {
    ...(frame && { frame }),
    ...(path && { path: normalize(path) ?? path }),
    ...(lines && { lines }),
    ...(heading && { heading }),
    ...(comment && { comment }),
  };
}

/** A target as fragment parameters, e.g. `frame=abc&lines=10-20`. */
export function formatHash(target: LinkTarget): string {
  const params = new URLSearchParams();
  if (target.frame) params.set("frame", target.frame);
  if (target.path) params.set("path", target.path);
  if (target.lines)
    params.set(
      "lines",
      target.lines.start === target.lines.end
        ? `${target.lines.start}`
        : `${target.lines.start}-${target.lines.end}`,
    );
  if (target.heading) params.set("heading", target.heading);
  if (target.comment) params.set("comment", target.comment);
  return params.toString();
}

/** A page fragment with its board part replaced by `target` (or removed); the rest kept. */
export function withTarget(fragment: string, target: LinkTarget | null): string {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  for (const key of BOARD_KEYS) params.delete(key);
  const rest = params.toString();
  const board = target ? formatHash(target) : "";
  return [rest, board].filter(Boolean).join("&");
}

/**
 * A heading's slug, as GitHub makes them: lowercase, punctuation dropped,
 * spaces to dashes. Repeats get `-1`, `-2`… (`Slugger`).
 */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

export class Slugger {
  private readonly seen = new Map<string, number>();
  slug(text: string): string {
    const base = slug(text);
    const n = this.seen.get(base);
    this.seen.set(base, (n ?? -1) + 1);
    return n === undefined ? base : `${base}-${n + 1}`;
  }
}

/** A path with an optional `#L10-L20`, `#heading` or `:10-20`. */
function fileTarget(text: string, base: LinkBase): LinkTarget | null {
  let [raw = "", fragment = ""] = splitOnce(text.replace(/\?[^#]*/, ""), "#");
  let lines = fragment ? lineFragment(fragment) : null;
  const heading = fragment && !lines ? headingOf(fragment) : null;
  if (!fragment) {
    const suffix = /^(.+?):(\d+)(?:[-–](\d+)|:\d+)?$/.exec(raw);
    if (suffix) {
      raw = suffix[1]!;
      lines = range(Number(suffix[2]), Number(suffix[3] ?? suffix[2]));
    }
  }
  const path = resolve(decode(raw), base);
  if (!path) return null;
  return { path, ...(lines && { lines }), ...(heading && { heading }) };
}

function resolve(raw: string, base: LinkBase): string | null {
  if (!raw) return null;
  if (raw.startsWith(SCRATCH_PREFIX)) return scratch(raw.slice(SCRATCH_PREFIX.length));
  if (raw.startsWith("/")) {
    const cwd = base.cwd?.replace(/\/+$/, "");
    if (!cwd || !raw.startsWith(`${cwd}/`)) return null;
    return normalize(raw.slice(cwd.length + 1));
  }
  const file = base.file ?? "";
  // A scratch file's links stay among scratch files: there is no project path to climb to.
  if (file.startsWith(SCRATCH_PREFIX)) return scratch(raw);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  return normalize(dir ? `${dir}/${raw}` : raw);
}

function scratch(name: string): string | null {
  const path = normalize(name);
  return path && !path.includes("/") ? SCRATCH_PREFIX + path : null;
}

/** `a/./b/../c` → `a/c`; null for one that climbs out of the working dir. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** `L10`, `L10-L20`, `L10-20`, `L10C3-L12C8`. */
function lineFragment(fragment: string): LineRange | null {
  const match = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(fragment);
  return match ? range(Number(match[1]), Number(match[2] ?? match[1])) : null;
}

/** `10` or `10-20`. */
function linesOf(text: string): LineRange | null {
  const match = /^(\d+)(?:[-–](\d+))?$/.exec(text.trim());
  return match ? range(Number(match[1]), Number(match[2] ?? match[1])) : null;
}

function range(a: number, b: number): LineRange | null {
  if (!a || !b) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function headingOf(fragment: string): string | null {
  const text = decode(fragment).trim().toLowerCase();
  return text && !text.includes("=") ? text : null;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
}
