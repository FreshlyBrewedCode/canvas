import { useRef } from "react";

import type { FullscreenRow } from "@/lib/fullscreen";
import { resizeLayout, type Frame } from "@/lib/board";
import { useRoom } from "@/lib/room-context";
import { cn } from "@/lib/utils";
import type { Layout } from "../../shared/layout";

/**
 * Frames in a cluster share their borders (ADR 0010, decision 4), and every
 * edge resizes, one handle where two frames or two rows meet: a vertical edge
 * sets the width of the column left of it (the rest of the row moves along), a
 * horizontal edge the height of the row above it (the rows below move), and
 * where they meet, a corner does both. A cluster's left and top edges are
 * where the arrangement puts it: they don't resize.
 *
 * In full screen only widths change, along the row it shows; a terminal's
 * bottom edge sets its own height, which everyone's full screen shows.
 */
export function Edges({
  layout,
  fullscreen,
}: {
  layout: Layout;
  fullscreen: { row: FullscreenRow<Frame>; height: number } | null;
}) {
  if (fullscreen) {
    const { row, height } = fullscreen;
    return (
      <>
        {row.frames.map((f) => (
          <Handle
            key={f.column}
            edge="vertical"
            box={{ x: f.x + f.w, y: row.top, w: 0, h: height }}
            sizes={{ column: { id: f.column, w: f.w } }}
          />
        ))}
        {row.frames
          .filter((f) => f.type === "terminal")
          .map((f) => {
            const h = f.height ?? f.h;
            return (
              <Handle
                key={`${f.id}-height`}
                edge="horizontal"
                box={{ x: f.x, y: row.top + h, w: f.w, h: 0 }}
                sizes={{ frame: { id: f.id, height: h } }}
              />
            );
          })}
      </>
    );
  }
  return (
    <>
      {layout.clusters.flatMap((cluster) =>
        cluster.rows.flatMap((row) => [
          ...row.columns.map((c) => (
            <Handle
              key={c.id}
              edge="vertical"
              box={{ x: c.box.x + c.box.w, y: row.box.y, w: 0, h: row.box.h }}
              sizes={{ column: { id: c.id, w: c.box.w } }}
            />
          )),
          <Handle
            key={row.id}
            edge="horizontal"
            box={{ x: row.box.x, y: row.box.y + row.box.h, w: row.box.w, h: 0 }}
            sizes={{ row: { id: row.id, h: row.box.h } }}
          />,
          ...row.columns.map((c) => (
            <Handle
              key={`${c.id}-corner`}
              edge="corner"
              box={{ x: c.box.x + c.box.w, y: row.box.y + row.box.h, w: 0, h: 0 }}
              sizes={{ column: { id: c.id, w: c.box.w }, row: { id: row.id, h: row.box.h } }}
            />
          )),
        ]),
      )}
    </>
  );
}

/** How thick a handle is on screen, in px, at any zoom. */
const THICK = 8;
const CURSOR = {
  vertical: "cursor-col-resize",
  horizontal: "cursor-row-resize",
  corner: "cursor-nwse-resize",
};

function Handle({
  edge,
  box,
  sizes,
}: {
  edge: "vertical" | "horizontal" | "corner";
  /** The edge on the board: a line, or a point for a corner. */
  box: { x: number; y: number; w: number; h: number };
  /** What dragging it sets, from what it is. */
  sizes: {
    column?: { id: string; w: number };
    row?: { id: string; h: number };
    frame?: { id: string; height: number };
  };
}) {
  const room = useRoom();
  /** Where the press was, and the sizes then: moves are from those. */
  const start = useRef<{ px: number; py: number; scale: number; from: typeof sizes } | null>(null);
  const request = useRef(0);
  const thick = `calc(${THICK}px / var(--board-scale, 1))`;
  const half = `calc(${THICK / 2}px / var(--board-scale, 1))`;
  return (
    <div
      data-hud=""
      data-edge={edge}
      className={cn(
        "hover:bg-primary/60 active:bg-primary/80 absolute z-[99960] touch-none transition-colors",
        CURSOR[edge],
        edge === "corner" && "z-[99961] rounded-full",
      )}
      style={{
        left: `calc(${box.x}px - ${edge === "horizontal" ? "0px" : half})`,
        top: `calc(${box.y}px - ${edge === "vertical" ? "0px" : half})`,
        width: edge === "horizontal" ? box.w : thick,
        height: edge === "vertical" ? box.h : thick,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const board = event.currentTarget.closest<HTMLElement>("[data-board]");
        const scale = Number(board?.style.getPropertyValue("--board-scale") || 1);
        start.current = { px: event.clientX, py: event.clientY, scale, from: sizes };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const s = start.current;
        if (!s) return;
        const dx = (event.clientX - s.px) / s.scale;
        const dy = (event.clientY - s.py) / s.scale;
        cancelAnimationFrame(request.current);
        request.current = requestAnimationFrame(() =>
          room.doc.transact(() => {
            const { column, row, frame } = s.from;
            if (column) resizeLayout(room.doc, { column: column.id, w: column.w + dx });
            if (row) resizeLayout(room.doc, { row: row.id, h: row.h + dy });
            if (frame) resizeLayout(room.doc, { frame: frame.id, height: frame.height + dy });
          }),
        );
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    />
  );
}
