import "@excalidraw/excalidraw/index.css";

import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useRef, useState } from "react";

import { useGo, useLinkBase } from "@/components/board-link";
import { useBoardScale } from "@/hooks/use-board-viewport";
import { parseLink } from "@/lib/board-link";
import {
  drawingOf,
  mergeElements,
  readElements,
  writeElements,
  type DrawingElement,
  type restingView,
} from "@/lib/drawing";
import { loadExcalidraw } from "@/lib/drawing-kit";
import { useRoom } from "@/lib/room-context";

type Elements = Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"];
type Zoom = { value: number & { _brand: "normalizedZoom" } };

// Sets where Excalidraw finds its fonts before it first draws.
void loadExcalidraw();

/**
 * Excalidraw on a drawing frame's elements (ADR 0008), for the person
 * editing it. Excalidraw can't live under a CSS scale (finding 15): pointers
 * land off by the scale and its canvas covers a corner. So the board's zoom
 * is undone here, and Excalidraw zooms instead: at the board's scale, times
 * its own zoom.
 *
 * Its changes go to the board doc as they happen; everyone else's come back
 * into it, without entering its undo history.
 */
export default function DrawingEditor({
  frameId,
  view,
  dark,
}: {
  frameId: string;
  view: ReturnType<typeof restingView>;
  dark: boolean;
}) {
  const room = useRoom();
  const doc = room.doc;
  const scale = useBoardScale();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Our own writes, which the doc must not hand back.
  const origin = useMemo(() => Symbol("drawing-editor"), []);
  /** Excalidraw's zoom over the board's. */
  const own = useRef(view.zoom);
  const boardScale = useRef(scale);
  const go = useGo();
  const base = useLinkBase();

  const [initial] = useState(() => ({
    // Copies: Excalidraw changes elements in place, the doc's values mustn't.
    elements: structuredClone(readElements(doc, frameId)) as unknown as Elements,
    appState: {
      zoom: { value: view.zoom * scale } as Zoom,
      scrollX: view.scrollX,
      scrollY: view.scrollY,
      viewBackgroundColor: "transparent",
    },
  }));

  // Everyone else's changes.
  useEffect(() => {
    const map = drawingOf(doc, frameId);
    const onChange = (event: { transaction: { origin: unknown }; keysChanged: Set<string> }) => {
      const excalidraw = api.current;
      if (event.transaction.origin === origin || !excalidraw) return;
      const theirs = [...event.keysChanged].flatMap((id) => {
        const element = map.get(id);
        return element ? [structuredClone(element)] : [];
      });
      const ours = excalidraw.getSceneElementsIncludingDeleted() as unknown as DrawingElement[];
      const merged = mergeElements(ours, theirs);
      if (merged)
        excalidraw.updateScene({
          elements: merged as unknown as Elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
    };
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [doc, frameId, origin]);

  // The board zoomed: Excalidraw zooms with it.
  useEffect(() => {
    if (boardScale.current === scale) return;
    boardScale.current = scale;
    api.current?.updateScene({
      appState: { zoom: { value: own.current * scale } as Zoom },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.current?.refresh();
  }, [scale]);

  // Excalidraw keeps where it is on screen; the board moves it without
  // telling. Coming back over it, it looks again. ⌘/Ctrl-wheel zooms the
  // drawing, not the board.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onEnter = () => api.current?.refresh();
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.stopPropagation();
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("wheel", onWheel);
    return () => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div ref={box} data-frame-body="" data-drawing-editor="" className="absolute inset-0">
      <div
        className="origin-top-left"
        style={{
          width: `${scale * 100}%`,
          height: `${scale * 100}%`,
          transform: `scale(${1 / scale})`,
        }}
      >
        <Excalidraw
          excalidrawAPI={(instance) => (api.current = instance)}
          initialData={initial}
          theme={dark ? "dark" : "light"}
          onChange={(elements, appState) => {
            writeElements(doc, frameId, elements as unknown as DrawingElement[], origin);
            own.current = appState.zoom.value / boardScale.current;
          }}
          // Embeds would load any URL, around ADR 0004; images don't sync yet.
          validateEmbeddable={false}
          aiEnabled={false}
          onPaste={(data) => !Object.keys(data.files ?? {}).length}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              toggleTheme: null,
              changeViewBackgroundColor: false,
            },
            tools: { image: false },
          }}
          // Links go where the board's links go (ADR 0007); web links to a new tab.
          onLinkOpen={(element, event) => {
            event.preventDefault();
            const link = element.link ? parseLink(element.link, base) : null;
            if (link?.kind === "board") go(link);
            else if (link?.kind === "web") window.open(link.url, "_blank", "noopener,noreferrer");
          }}
        />
      </div>
    </div>
  );
}
