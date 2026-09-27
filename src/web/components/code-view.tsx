import type { FileContents, LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { File, Virtualizer, type FileOptions } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { domSurface, useFollowScroll } from "@/hooks/use-follow-scroll";
import type { LineRange } from "@/lib/board";
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

/** One line in `scroll` mode: the font size times the line height above. */
const LINE_PX = 12 * 1.6;
/** Lines of context kept above a range scrolled to. */
const CONTEXT_LINES = 3;

/** Beyond this many lines a remote selection is drawn up to here. */
const MAX_REMOTE_LINES = 2000;

/**
 * A file's source, read-only: Shiki highlighting (language from the file
 * name), line numbers, and only the visible lines in the DOM. Prose (`wrap`)
 * wraps long lines; code scrolls.
 *
 * Selecting lines (click or drag the line numbers) is presence: everyone
 * else sees them in your colour, with your name on the first line.
 *
 * `lines` is the frame's own range (an agent pointed it there): highlighted
 * for everyone and scrolled to whenever it, or the file, changes.
 *
 * `notes` go below lines (0: above the first) — comments. With `onGutter`,
 * hovering a line shows a "+" that asks for a note on it, or on the lines
 * selected.
 */
export function CodeView({
  frameId,
  path,
  text,
  wrap,
  lines,
  notes,
  renderNote,
  onGutter,
}: {
  frameId: string;
  path: string;
  text: string;
  wrap: boolean;
  lines?: LineRange | null;
  notes?: ReadonlyArray<number>;
  renderNote?: (line: number) => ReactNode;
  onGutter?: (range: LineRange) => void;
}) {
  const room = useRoom();
  const peers = usePeers();
  const file = useMemo<FileContents>(() => ({ name: path, contents: text }), [path, text]);

  // Other people's lines, as CSS in a style element of our own inside the
  // view's shadow root: it matches whatever lines are rendered, so it holds
  // across virtualization without re-rendering the file.
  const start = lines?.start;
  const end = lines?.end;
  const remote = useMemo(
    () =>
      remoteLinesCss(peers, frameId, path) +
      (start && end ? focusCss(start, Math.min(end, start + MAX_REMOTE_LINES)) : ""),
    [peers, frameId, path, start, end],
  );
  const css = useRef(remote);
  const style = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    css.current = remote;
    if (style.current) style.current.textContent = remote;
  }, [remote]);

  // A new list re-renders the file, dropping the "+" mid-hover: keep it while the lines are the same.
  const noteKey = notes?.join(",") ?? "";
  const annotations = useMemo<LineAnnotation[]>(
    () => (noteKey ? noteKey.split(",").map((line) => ({ lineNumber: Number(line) })) : []),
    [noteKey],
  );
  const gutter = useRef(onGutter);
  useEffect(() => {
    gutter.current = onGutter;
  });
  const commenting = !!onGutter;

  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      ...BASE,
      overflow: wrap ? "wrap" : "scroll",
      ...(commenting && {
        enableGutterUtility: true,
        onGutterUtilityClick: (range: SelectedLineRange) =>
          gutter.current?.({
            start: Math.min(range.start, range.end),
            end: Math.max(range.start, range.end),
          }),
      }),
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
    [room, frameId, path, wrap, commenting],
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

  // Scroll to the frame's range: roughly by line height first, so the
  // virtualizer renders it, then exactly by the rendered line.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = box.current?.firstElementChild;
    if (!start || !(scroller instanceof HTMLElement)) return;
    const top = Math.max(0, start - 1 - CONTEXT_LINES);
    scroller.scrollTop = CONTENT.paddingBlock + top * LINE_PX;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const root = scroller.querySelector("diffs-container")?.shadowRoot;
        const line = root?.querySelector(`[data-line="${start}"]`);
        if (!line) return;
        const offset = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const scale = scroller.getBoundingClientRect().height / scroller.offsetHeight || 1;
        scroller.scrollTop += offset / scale - CONTEXT_LINES * LINE_PX;
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [start, end, path, text.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whoever occupies the frame scrolls it for everyone following them.
  useFollowScroll(
    frameId,
    `source:${path}`,
    () => {
      const scroller = box.current?.firstElementChild;
      return scroller instanceof HTMLElement ? domSurface(scroller) : null;
    },
    text,
  );

  return (
    <div ref={box} className="h-full">
      <Virtualizer className="h-full overflow-auto" contentStyle={CONTENT}>
        <File
          file={file}
          options={options}
          style={STYLE}
          lineAnnotations={annotations}
          renderAnnotation={renderNote && ((note) => renderNote(note.lineNumber))}
        />
      </Virtualizer>
    </div>
  );
}

/** The frame's own range: a quiet highlight, the same for everyone. */
function focusCss(start: number, end: number): string {
  const lines = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  return `
    :is(${lines.map((n) => `[data-line="${n}"]`).join(",")}) {
      background-color: color-mix(in srgb, var(--status-ready, #eab308) 14%, transparent);
    }
    :is(${lines.map((n) => `[data-column-number="${n}"]`).join(",")}) {
      box-shadow: inset 3px 0 0 var(--status-ready, #eab308);
    }`;
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
