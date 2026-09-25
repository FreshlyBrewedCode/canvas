import { useCallback, useEffect, useRef, useState } from "react";

import { fitRects, toBoard, zoomAbout, type Point, type Transform } from "@/lib/viewport";

/** Must match the `background-size` in the `.bg-dot-grid` CSS class. */
const DOT_GRID_SIZE = 22;
const DOT_GRID_MIN_SCALE = 0.4;

export interface BoardViewport {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  transform: () => Transform;
  /** Viewport client coordinates → board coordinates. */
  toBoard: (clientX: number, clientY: number) => Point;
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
  fit: (rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>) => void;
  centre: () => Point;
}

/**
 * A transform-based pan/zoom viewport (after wayful's graph viewport): drag
 * the background to pan, wheel or pinch to zoom about the pointer, trackpad
 * swipes pan. Frames own their own pointer interactions and scrolling.
 */
export function useBoardViewport(storageKey: string): BoardViewport {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [initial] = useState<Transform>(
    () =>
      (JSON.parse(localStorage.getItem(storageKey) ?? "null") as Transform | null) ?? {
        scale: 1,
        x: 40,
        y: 40,
      },
  );
  const transformRef = useRef<Transform>(initial);
  const [scale, setScale] = useState(initial.scale);

  const apply = useCallback(
    (next: Transform) => {
      transformRef.current = next;
      if (canvasRef.current) {
        canvasRef.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
      }
      const wrap = wrapRef.current;
      if (wrap) {
        // The dot grid lives on the wrap so it always covers the viewport;
        // its phase and size follow the transform so it reads as world space.
        wrap.style.backgroundPosition = `${next.x}px ${next.y}px`;
        const size = DOT_GRID_SIZE * next.scale;
        wrap.style.backgroundSize = `${size}px ${size}px`;
        wrap.style.backgroundImage = next.scale < DOT_GRID_MIN_SCALE ? "none" : "";
        wrap.style.setProperty("--board-scale", String(next.scale));
      }
      setScale(next.scale);
      localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [storageKey],
  );

  useEffect(() => apply(transformRef.current), [apply]);

  const zoom = useCallback(
    (next: number, px: number, py: number) => {
      const zoomed = zoomAbout(transformRef.current, next, px, py);
      if (zoomed !== transformRef.current) apply(zoomed);
    },
    [apply],
  );

  const pan = useCallback(
    (dx: number, dy: number) => {
      const t = transformRef.current;
      apply({ ...t, x: t.x + dx, y: t.y + dy });
    },
    [apply],
  );

  // --- wheel: ctrl/⌘ (and pinch, which browsers report as ctrl+wheel) zooms;
  // anything else pans — unless it is over a scrollable frame body.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      const zooming = event.ctrlKey || event.metaKey;
      if (!zooming && (event.target as Element).closest("[data-frame-body]")) return;
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      if (zooming) {
        zoom(
          transformRef.current.scale * Math.exp(-event.deltaY * 0.004),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      } else {
        pan(-event.deltaX, -event.deltaY);
      }
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [pan, zoom]);

  // --- pointers on the background: one drags, two pinch.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; scale: number; px: number; py: number } | null = null;

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
      const target = event.target as Element;
      if (target.closest("[data-frame], [data-hud]")) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const rect = wrap.getBoundingClientRect();
        if (a && b)
          pinch = {
            distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            scale: transformRef.current.scale,
            px: (a.x + b.x) / 2 - rect.left,
            py: (a.y + b.y) / 2 - rect.top,
          };
      }
      wrap.setPointerCapture(event.pointerId);
      wrap.dataset.grabbing = "true";
      (document.activeElement as HTMLElement | null)?.blur();
    };
    const onMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        if (a && b)
          zoom(
            (Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance) * pinch.scale,
            pinch.px,
            pinch.py,
          );
        return;
      }
      pan(event.clientX - previous.x, event.clientY - previous.y);
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) delete wrap.dataset.grabbing;
    };
    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
    return () => {
      wrap.removeEventListener("pointerdown", onDown);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
    };
  }, [pan, zoom]);

  const size = () => ({
    width: wrapRef.current?.clientWidth ?? 0,
    height: wrapRef.current?.clientHeight ?? 0,
  });

  return {
    wrapRef,
    canvasRef,
    scale,
    transform: () => transformRef.current,
    toBoard: (clientX, clientY) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      return toBoard(transformRef.current, {
        x: clientX - (rect?.left ?? 0),
        y: clientY - (rect?.top ?? 0),
      });
    },
    zoomBy: (factor) => {
      const { width, height } = size();
      zoom(transformRef.current.scale * factor, width / 2, height / 2);
    },
    zoomTo: (next) => {
      const { width, height } = size();
      zoom(next, width / 2, height / 2);
    },
    fit: (rects) => {
      const { width, height } = size();
      const fitted = fitRects(rects, width, height);
      if (fitted) apply(fitted);
    },
    centre: () => {
      const { width, height } = size();
      return toBoard(transformRef.current, { x: width / 2, y: height / 2 });
    },
  };
}
