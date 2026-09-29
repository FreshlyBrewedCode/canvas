import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import {
  fitRects,
  fitView,
  inView,
  stepZoom,
  toBoard,
  wheelZoomFactor,
  zoomAbout,
  type Point,
  type Rect,
  type Transform,
} from "@/lib/viewport";

/** The board's zoom, for frames that must undo it (a drawing being edited). */
const BoardScaleContext = createContext(1);
export const BoardScale = BoardScaleContext.Provider;
export const useBoardScale = () => useContext(BoardScaleContext);

/** Must match the `background-size` in the `.bg-dot-grid` CSS class. */
const DOT_GRID_SIZE = 22;
const DOT_GRID_MIN_SCALE = 0.4;
/** How long following eases between someone's views; about how often they send them. */
const FOLLOW_EASE_MS = 100;

/** Whether Space typed here types a space: then it isn't the board's. */
const typesText = (target: Element) =>
  (target as HTMLElement).isContentEditable || !!target.closest("input, textarea, select");

export interface BoardViewport {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  transform: () => Transform;
  /** The transform and the viewport's size; a new object whenever either changes. */
  screen: () => Screen;
  /** Called on every change of `screen()`. */
  subscribe: (listener: () => void) => () => void;
  /** Called when we pan or zoom ourselves: anything but `follow`. */
  onOwnMove: (listener: () => void) => () => void;
  /** Show someone else's view, easing over from where we are. */
  follow: (view: Rect) => void;
  /** Viewport client coordinates → board coordinates. */
  toBoard: (clientX: number, clientY: number) => Point;
  /** One press of the zoom buttons: in (1) or out (-1). */
  zoomStep: (direction: 1 | -1) => void;
  zoomTo: (scale: number) => void;
  fit: (rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>) => void;
  /** Bring a rectangle into view: fit it, unless it is there to read already. */
  show: (rect: { x: number; y: number; w: number; h: number }) => void;
  centre: () => Point;
  /** Pan so a board point is at the centre, keeping the zoom. */
  centreOn: (point: Point) => void;
}

export interface Screen {
  readonly transform: Transform;
  readonly width: number;
  readonly height: number;
}

/**
 * A transform-based pan/zoom viewport (after wayful's graph viewport): drag
 * the background to pan, wheel or pinch to zoom about the pointer, trackpad
 * swipes pan. Frames own their own pointer interactions and scrolling, but
 * for the middle button and Space + drag, which pan from anywhere.
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
  const screenRef = useRef<Screen>({ transform: initial, width: 0, height: 0 });
  const listeners = useRef(new Set<() => void>());
  const changed = useCallback(() => {
    const wrap = wrapRef.current;
    screenRef.current = {
      transform: transformRef.current,
      width: wrap?.clientWidth ?? 0,
      height: wrap?.clientHeight ?? 0,
    };
    for (const listener of listeners.current) listener();
  }, []);
  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  const screen = useCallback(() => screenRef.current, []);
  const ownMoveListeners = useRef(new Set<() => void>());
  const onOwnMove = useCallback((listener: () => void) => {
    ownMoveListeners.current.add(listener);
    return () => ownMoveListeners.current.delete(listener);
  }, []);

  const apply = useCallback(
    (next: Transform, followed = false) => {
      transformRef.current = next;
      // Someone else's view comes a few times a second: ease between them. Our own moves are instant.
      const ease = followed ? `${FOLLOW_EASE_MS}ms linear` : "";
      if (canvasRef.current) {
        canvasRef.current.style.transition = ease && `transform ${ease}`;
        canvasRef.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
      }
      const wrap = wrapRef.current;
      if (wrap) {
        // The dot grid lives on the wrap so it always covers the viewport;
        // its phase and size follow the transform so it reads as world space.
        wrap.style.transition = ease && `background-position ${ease}, background-size ${ease}`;
        wrap.style.backgroundPosition = `${next.x}px ${next.y}px`;
        const size = DOT_GRID_SIZE * next.scale;
        wrap.style.backgroundSize = `${size}px ${size}px`;
        wrap.style.backgroundImage = next.scale < DOT_GRID_MIN_SCALE ? "none" : "";
        wrap.style.setProperty("--board-scale", String(next.scale));
      }
      setScale(next.scale);
      localStorage.setItem(storageKey, JSON.stringify(next));
      changed();
      if (!followed) for (const listener of ownMoveListeners.current) listener();
    },
    [storageKey, changed],
  );

  useEffect(() => apply(transformRef.current), [apply]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(changed);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [changed]);

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

  const follow = useCallback(
    (view: Rect) => {
      const wrap = wrapRef.current;
      if (wrap?.clientWidth && wrap.clientHeight)
        apply(fitView(view, wrap.clientWidth, wrap.clientHeight), true);
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
          transformRef.current.scale * wheelZoomFactor(event.deltaY, event.deltaMode),
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

  // --- pointers: one drags the background, two pinch it. The middle button,
  // or the left one with Space held, drags from anywhere: over a frame too.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; scale: number; px: number; py: number } | null = null;
    // A press the board took from a frame: its click is the board's too.
    let took = false;

    let spaceHeld = false;
    const hold = (on: boolean) => {
      spaceHeld = on;
      if (on) wrap.dataset.panReady = "true";
      else delete wrap.dataset.panReady;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || typesText(target)) return;
      // Outside the board (its top bar), Space presses buttons. In a drawing
      // being edited, Space is Excalidraw's own pan.
      if (target !== document.body && !wrap.contains(target)) return;
      if (target.closest("[data-drawing-editor]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!spaceHeld) hold(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHeld) return;
      event.preventDefault();
      event.stopPropagation();
      hold(false);
    };
    const letGo = () => hold(false);
    const onVisibility = () => document.hidden && letGo();

    const onDown = (event: PointerEvent) => {
      took = false;
      const target = event.target as Element;
      if (!wrap.contains(target)) return;
      const anywhere =
        event.pointerType !== "touch" &&
        ((event.button === 1 && !target.closest("[data-drawing-editor]")) ||
          (event.button === 0 && spaceHeld));
      if (anywhere) {
        // Before any frame hears of it (React's capture handlers included): no
        // focus, no raise, no Linux middle-click paste, no autoscroll.
        event.preventDefault();
        event.stopPropagation();
        took = true;
      } else {
        if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
        if (target.closest("[data-frame], [data-hud]")) return;
      }
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
      if (!anywhere) (document.activeElement as HTMLElement | null)?.blur();
    };
    const onClick = (event: MouseEvent) => {
      if (!took) return;
      took = false;
      event.preventDefault();
      event.stopPropagation();
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
    const capture = { capture: true };
    window.addEventListener("keydown", onKeyDown, capture);
    window.addEventListener("keyup", onKeyUp, capture);
    window.addEventListener("blur", letGo);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onDown, capture);
    window.addEventListener("click", onClick, capture);
    window.addEventListener("auxclick", onClick, capture);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown, capture);
      window.removeEventListener("keyup", onKeyUp, capture);
      window.removeEventListener("blur", letGo);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", onDown, capture);
      window.removeEventListener("click", onClick, capture);
      window.removeEventListener("auxclick", onClick, capture);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
      hold(false);
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
    screen,
    subscribe,
    onOwnMove,
    follow,
    toBoard: (clientX, clientY) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      return toBoard(transformRef.current, {
        x: clientX - (rect?.left ?? 0),
        y: clientY - (rect?.top ?? 0),
      });
    },
    zoomStep: (direction) => {
      const { width, height } = size();
      zoom(stepZoom(transformRef.current.scale, direction), width / 2, height / 2);
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
    show: (rect) => {
      const { width, height } = size();
      if (inView(transformRef.current, rect, width, height)) return;
      const fitted = fitRects([rect], width, height);
      if (fitted) apply(fitted);
    },
    centre: () => {
      const { width, height } = size();
      return toBoard(transformRef.current, { x: width / 2, y: height / 2 });
    },
    centreOn: (point) => {
      const { width, height } = size();
      const t = transformRef.current;
      apply({ ...t, x: width / 2 - point.x * t.scale, y: height / 2 - point.y * t.scale });
    },
  };
}
