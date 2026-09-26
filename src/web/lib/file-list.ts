/**
 * A file frame's list (ADR 0005): the files an agent picked, each at a
 * display path of its choosing, so folders, names and order are the
 * agent's. Every display path translates back to the real path it shows —
 * a file of the shared set or a scratch file — and the real path is all
 * that is ever read.
 */

import type { FileEntry, LineRange } from "./board";

/** A display path as the tree takes it; throws why it can't be one. */
export function displayPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("each list entry needs a display path");
  const display = value.trim().replace(/^(\.?\/)+/, "");
  const segments = display.split("/");
  if (!display || segments.some((s) => !s.trim() || s === "." || s === ".."))
    throw new Error(`not a display path: ${JSON.stringify(value)} (e.g. "Auth/session.ts")`);
  return display;
}

/** Display paths are unique, and none is a folder of another. */
export function checkDisplays(displays: ReadonlyArray<string>): void {
  const seen = new Set<string>();
  for (const display of displays) {
    if (seen.has(display)) throw new Error(`display path ${display} is in the list twice`);
    seen.add(display);
  }
  for (const display of displays)
    for (const folder of folders(display))
      if (seen.has(folder)) throw new Error(`${folder} can't be a file and a folder`);
}

/**
 * The tree's order for a list: the agent's. A folder sorts where its first
 * entry is, so the tree reads top to bottom in the order the list was given.
 */
export function listOrder(displays: ReadonlyArray<string>) {
  const rank = new Map<string, number>();
  displays.forEach((display, i) => {
    for (const key of [...folders(display), display]) if (!rank.has(key)) rank.set(key, i);
  });
  return (
    left: { readonly segments: readonly string[] },
    right: { readonly segments: readonly string[] },
  ): number => {
    const a = left.segments;
    const b = right.segments;
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k === a.length || k === b.length) return a.length - b.length;
    const key = (segments: readonly string[]) => segments.slice(0, k + 1).join("/");
    return (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity);
  };
}

/**
 * The entry a frame shows: the one for its path and lines, else the first
 * for its path. Undefined when the frame shows a file off the list.
 */
export function entryFor(
  list: ReadonlyArray<FileEntry>,
  path: string,
  lines: LineRange | null | undefined,
): FileEntry | undefined {
  const same = (a?: LineRange | null, b?: LineRange | null) =>
    a?.start === b?.start && a?.end === b?.end;
  return (
    list.find((entry) => entry.path === path && same(entry.lines, lines)) ??
    list.find((entry) => entry.path === path)
  );
}

/** Every folder above a display path, without the trailing slash. */
function folders(display: string): string[] {
  const parts = display.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
