import { Check, Pencil } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FrameShell } from "@/components/frame-shell";
import type { Frame } from "@/lib/board";
import { restingView, useDrawing, visible, type DrawingElement } from "@/lib/drawing";
import { contentBounds, PADDING, renderSvg } from "@/lib/drawing-kit";
import { useRoom } from "@/lib/room-context";

type DrawingFrameData = Extract<Frame, { type: "drawing" }>;

const DrawingEditor = lazy(() => import("@/components/drawing-editor"));

const isDark = () => document.documentElement.classList.contains("dark");

/**
 * An Excalidraw drawing everyone on the board shares (ADR 0008). At rest it
 * is a picture that zooms with the board like any frame; double-click (or
 * Edit) and it becomes Excalidraw for you, at the same view, until you click
 * outside the frame or press Done. Editing is yours: others see your changes
 * live, in their picture or their own editor.
 */
export function DrawingFrame({ frame, readOnly }: { frame: DrawingFrameData; readOnly: boolean }) {
  const room = useRoom();
  const elements = useDrawing(room.doc, frame.id);
  const [editing, setEditing] = useState<ReturnType<typeof restingView> | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const size = useSize(body);
  const [bounds, setBounds] = useState<Awaited<ReturnType<typeof contentBounds>>>(null);
  const view = restingView(bounds, PADDING, size.w, size.h);

  useEffect(() => {
    let live = true;
    void contentBounds(elements).then((b) => live && setBounds(b));
    return () => {
      live = false;
    };
  }, [elements]);

  // Pressing anywhere outside the frame (or Excalidraw's dialogs) ends editing.
  useEffect(() => {
    if (!editing) return;
    const onDown = (event: PointerEvent) => {
      const inside = (event.target as Element).closest(
        `[data-frame="${frame.id}"], .excalidraw-modal-container`,
      );
      if (!inside) setEditing(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [editing, frame.id]);
  if (readOnly && editing) setEditing(null);

  const edit = () => !readOnly && setEditing(view);
  const empty = visible(elements).length === 0;

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      actions={
        !readOnly && (
          <button
            type="button"
            data-drawing-edit={editing ? "done" : "edit"}
            title={editing ? "Done drawing" : "Draw (or double-click)"}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => (editing ? setEditing(null) : edit())}
          >
            {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
            {editing ? "Done" : "Edit"}
          </button>
        )
      }
    >
      <div ref={body} className="absolute inset-0 overflow-hidden" data-drawing={frame.id}>
        {editing ? (
          <Suspense fallback={<Picture elements={elements} view={view} />}>
            <DrawingEditor frameId={frame.id} view={editing} dark={isDark()} />
          </Suspense>
        ) : (
          <div className="absolute inset-0" onDoubleClick={edit}>
            <Picture elements={elements} view={view} />
            {empty && (
              <p className="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-xs">
                {readOnly ? "Nothing drawn yet." : "Double-click to draw."}
              </p>
            )}
          </div>
        )}
      </div>
    </FrameShell>
  );
}

/** The drawing as SVG, where `restingView` puts it. */
function Picture({
  elements,
  view,
}: {
  elements: ReadonlyArray<DrawingElement>;
  view: ReturnType<typeof restingView>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    // Many changes in a row (someone drawing) render once.
    const timer = setTimeout(async () => {
      const svg = await renderSvg(elements, isDark());
      if (!live || !ref.current) return;
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      ref.current.replaceChildren(svg);
    }, 60);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [elements]);
  return (
    <div
      ref={ref}
      data-drawing-picture=""
      className="pointer-events-none absolute"
      style={{ left: view.left, top: view.top, width: view.width, height: view.height }}
    />
  );
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout size, in board units: the board's zoom doesn't change it.
    const read = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
