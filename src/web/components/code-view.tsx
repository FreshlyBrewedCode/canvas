import type { FileContents, SelectedLineRange } from "@pierre/diffs";
import { File, Virtualizer, type FileOptions } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef } from "react";

import type { Presence } from "@/lib/room";
import { usePeers, useRoom } from "@/lib/room-context";

const BASE: FileOptions<undefined, undefined> = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  disableFileHeader: true,
  enableLineSelection: true,
};

const STYLE = {
  // The frame's colour, not the theme's.
  "--diffs-light-bg": "var(--card)",
  "--diffs-dark-bg": "var(--card)",
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.6",
} as React.CSSProperties;

/**
 * Not flush with the top: the virtualizer anchors scrolling to a file's
 * bottom while its top is at 0 and it has no height yet, so a new file
 * would open scrolled to its end.
 */
const CONTENT = { paddingBlock: 4 };

/** Beyond this many lines a remote selection is drawn up to here. */
const MAX_REMOTE_LINES = 2000;

/**
 * A file's source, read-only: Shiki highlighting (language from the file
 * name), line numbers, and only the visible lines in the DOM. Prose (`wrap`)
 * wraps long lines; code scrolls.
 *
 * Selecting lines (click or drag the line numbers) is presence: everyone
 * else sees them in your colour, with your name on the first line.
 */
export function CodeView({
  frameId,
  path,
  text,
  wrap,
}: {
  frameId: string;
  path: string;
  text: string;
  wrap: boolean;
}) {
  const room = useRoom();
  const peers = usePeers();
  const file = useMemo<FileContents>(() => ({ name: path, contents: text }), [path, text]);

  // Other people's lines, as CSS in a style element of our own inside the
  // view's shadow root: it matches whatever lines are rendered, so it holds
  // across virtualization without re-rendering the file.
  const remote = useMemo(() => remoteLinesCss(peers, frameId, path), [peers, frameId, path]);
  const css = useRef(remote);
  const style = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    css.current = remote;
    if (style.current) style.current.textContent = remote;
  }, [remote]);

  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      ...BASE,
      overflow: wrap ? "wrap" : "scroll",
      onLineSelected: (range: SelectedLineRange | null) =>
        room.setPresence({
          selection: range && {
            kind: "lines",
            frameId,
            path,
            start: Math.min(range.start, range.end),
            end: Math.max(range.start, range.end),
          },
        }),
      onPostRender: (node, _, phase) => {
        if (phase === "unmount" || !node.shadowRoot) return;
        style.current ??= document.createElement("style");
        style.current.textContent = css.current;
        if (style.current.parentNode !== node.shadowRoot) node.shadowRoot.append(style.current);
      },
    }),
    [room, frameId, path, wrap],
  );

  // Our lines go with the file we selected them in.
  useEffect(
    () => () => {
      const mine = (room.awareness.getLocalState() as Presence | null)?.selection;
      if (mine?.kind === "lines" && mine.frameId === frameId && mine.path === path)
        room.setPresence({ selection: null });
    },
    [room, frameId, path],
  );

  return (
    <Virtualizer className="h-full overflow-auto" contentStyle={CONTENT}>
      <File file={file} options={options} style={STYLE} />
    </Virtualizer>
  );
}

function remoteLinesCss(peers: Presence[], frameId: string, path: string): string {
  return peers
    .flatMap((peer) => {
      const selection = peer.selection;
      if (selection?.kind !== "lines" || selection.frameId !== frameId || selection.path !== path)
        return [];
      const { start } = selection;
      const end = Math.min(selection.end, start + MAX_REMOTE_LINES);
      const lines = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      const color = peer.user.color;
      const name = peer.user.name.replace(/["\\\n]/g, "");
      return [
        `:is(${lines.map((n) => `[data-line="${n}"]`).join(",")}) {
          background-color: color-mix(in srgb, ${color} 20%, transparent) !important;
        }`,
        `:is(${lines.map((n) => `[data-column-number="${n}"]`).join(",")}) {
          box-shadow: inset 3px 0 0 ${color};
          color: ${color} !important;
        }`,
        `[data-line="${start}"] { position: relative; }`,
        `[data-line="${start}"]::after {
          content: "${name}";
          position: absolute; top: 0; right: 8px;
          padding: 0 4px; border-radius: 3px;
          font: 600 10px/1.6 var(--font-sans);
          background: ${color}; color: oklch(0.2 0 0);
        }`,
      ];
    })
    .join("\n");
}
