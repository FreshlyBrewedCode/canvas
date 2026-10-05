/**
 * A drawing frame's elements (ADR 0009), in the board doc:
 *
 *   drawing:<frameId>  Y.Map<elementId, DrawingElement>
 *
 * An element is Excalidraw's, as plain JSON: a map of them syncs like any
 * other board change. Excalidraw numbers every change to an element
 * (`version`), so the rule is its own collaboration's: an element is written
 * when ours is newer than the doc's, and taken from the doc unless ours is
 * newer (a change of ours on its way). Removed elements stay, marked
 * `isDeleted`, so a removal is a newer version like any other change.
 *
 * Nothing here loads Excalidraw; what needs it is `drawing-kit.ts`.
 */

import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";

export interface DrawingElement {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly versionNonce: number;
  /** Stacking order: a fractional index, lowest at the bottom. */
  readonly index?: string | null;
  readonly isDeleted?: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text?: string;
  /** A label's shape. */
  readonly containerId?: string | null;
  readonly boundElements?: ReadonlyArray<{ readonly id: string; readonly type: string }> | null;
  readonly startBinding?: { readonly elementId: string } | null;
  readonly endBinding?: { readonly elementId: string } | null;
  readonly link?: string | null;
  readonly [key: string]: unknown;
}

/** Elements that never sync: an image's file isn't in the doc (not yet). */
const LOCAL_ONLY = new Set(["image"]);

export const drawingOf = (doc: Y.Doc, frameId: string) =>
  doc.getMap<DrawingElement>(`drawing:${frameId}`);

/** In stacking order: by index, then id, so every peer stacks them alike. */
export function sortElements<T extends DrawingElement>(elements: Iterable<T>): T[] {
  const key = (e: DrawingElement) => e.index ?? "";
  return [...elements].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** A frame's elements, removed ones too (the editor needs them to merge). */
export function readElements(doc: Y.Doc, frameId: string): DrawingElement[] {
  return sortElements(drawingOf(doc, frameId).values());
}

export const visible = (elements: ReadonlyArray<DrawingElement>) =>
  elements.filter((e) => !e.isDeleted);

/**
 * Write the elements that are newer than the doc's, as copies: Excalidraw
 * changes its elements in place, and the doc must keep what was sent.
 * Returns how many were written.
 */
export function writeElements(
  doc: Y.Doc,
  frameId: string,
  elements: ReadonlyArray<DrawingElement>,
  origin?: unknown,
): number {
  const map = drawingOf(doc, frameId);
  const changed = elements.filter(
    (e) => !LOCAL_ONLY.has(e.type) && e.version > (map.get(e.id)?.version ?? -1),
  );
  if (changed.length)
    doc.transact(() => {
      for (const element of changed) map.set(element.id, structuredClone(element));
    }, origin);
  return changed.length;
}

/**
 * Ours, with the doc's changes in: the doc's element wins unless ours is
 * newer. Equal versions from different peers are settled by the doc, which
 * every peer agrees on. Null when nothing changes.
 */
export function mergeElements(
  ours: ReadonlyArray<DrawingElement>,
  theirs: Iterable<DrawingElement>,
): DrawingElement[] | null {
  const byId = new Map(ours.map((e) => [e.id, e]));
  let changed = false;
  for (const element of theirs) {
    const mine = byId.get(element.id);
    if (
      !mine ||
      element.version > mine.version ||
      (element.version === mine.version && element.versionNonce !== mine.versionNonce)
    ) {
      byId.set(element.id, element);
      changed = true;
    }
  }
  return changed ? sortElements(byId.values()) : null;
}

export function clearDrawing(doc: Y.Doc, frameId: string): void {
  const map = drawingOf(doc, frameId);
  for (const id of [...map.keys()]) map.delete(id);
}

// ---------------------------------------------------------------------------
// Agents' changes (the `draw` tool)

/** What an agent may draw; everything else is people's (images, embeds) or Excalidraw's own. */
export const SKELETON_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line"] as const;

/** Numbers an element may carry; models sometimes send them as strings. */
const NUMBERS = ["x", "y", "width", "height", "fontSize", "strokeWidth", "opacity", "roughness"];

/** JSON a model sent as a string, parsed; anything else as it is. */
function unstring(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Elements an agent described, as Excalidraw's element skeletons: checked
 * before Excalidraw turns them into elements. Throws with a message for the
 * agent, saying what it sent.
 */
export function checkSkeletons(value: unknown): Array<Record<string, unknown>> {
  const list = unstring(value);
  if (!Array.isArray(list)) throw new Error("elements must be a list of elements");
  return list.map((item: unknown, i) => {
    const element = unstring(item) as Record<string, unknown>;
    if (typeof element !== "object" || element === null || Array.isArray(element))
      throw new Error(`element ${i} isn't an object: ${JSON.stringify(item)}`);
    const type = element.type;
    if (!SKELETON_TYPES.includes(type as (typeof SKELETON_TYPES)[number]))
      throw new Error(`element ${i}: type must be one of ${SKELETON_TYPES.join(", ")}`);
    const fixed = { ...element };
    for (const key of NUMBERS)
      if (typeof fixed[key] === "string" && Number.isFinite(Number(fixed[key])))
        fixed[key] = Number(fixed[key]);
    for (const key of ["label", "start", "end", "points", "roundness"])
      if (fixed[key] !== undefined) fixed[key] = unstring(fixed[key]);
    // An arrow between two shapes is routed between them (`route`).
    const between =
      (type === "arrow" || type === "line") &&
      typeof (fixed.start as { id?: unknown } | undefined)?.id === "string" &&
      typeof (fixed.end as { id?: unknown } | undefined)?.id === "string";
    if (between) {
      fixed.x ??= 0;
      fixed.y ??= 0;
    }
    if (typeof fixed.x !== "number" || typeof fixed.y !== "number")
      throw new Error(
        `element ${i} (${String(type)}) needs numbers x and y, got x ${JSON.stringify(element.x)}, ` +
          `y ${JSON.stringify(element.y)}`,
      );
    if (type === "text" && typeof fixed.text !== "string")
      throw new Error(`element ${i}: a text element needs text`);
    for (const end of ["start", "end"] as const) {
      const bound = fixed[end] as Record<string, unknown> | undefined;
      if (bound !== undefined && (typeof bound !== "object" || bound === null))
        throw new Error(`element ${i}: ${end} is {id} of a shape, or a shape to create`);
      if (bound?.type !== undefined && !SKELETON_TYPES.includes(bound.type as never))
        throw new Error(`element ${i}: ${end}.type must be one of ${SKELETON_TYPES.join(", ")}`);
    }
    return fixed;
  });
}

/** A shape's box, for routing arrows to it. */
export interface Shape {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Room between an arrow's ends and its shapes. */
const ARROW_GAP = 8;

/** Where the line from a shape's centre towards `to` leaves its outline. */
function edge(shape: Shape, to: { x: number; y: number }) {
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  const c = { x: shape.x + hw, y: shape.y + hh };
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const t =
    shape.type === "ellipse"
      ? 1 / Math.hypot(dx / hw, dy / hh)
      : shape.type === "diamond"
        ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
        : Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t + (dx / len) * ARROW_GAP, y: c.y + dy * t + (dy / len) * ARROW_GAP };
}

/**
 * An arrow from one shape to another: straight, between their outlines.
 * Excalidraw binds an arrow to its shapes but leaves it where it was given.
 */
export function route(from: Shape, to: Shape): { x: number; y: number; points: number[][] } {
  const centre = (s: Shape) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  const a = edge(from, centre(to));
  const b = edge(to, centre(from));
  return {
    x: a.x,
    y: a.y,
    points: [
      [0, 0],
      [b.x - a.x, b.y - a.y],
    ],
  };
}

/**
 * Skeletons with their arrows between two shapes routed, unless they came
 * with points. `shapes` are the shapes already drawn.
 */
export function routeArrows(
  skeletons: ReadonlyArray<Record<string, unknown>>,
  shapes: ReadonlyArray<DrawingElement>,
): Array<Record<string, unknown>> {
  const boxes = new Map<string, Shape>(shapes.map((e) => [e.id, e]));
  for (const s of skeletons)
    if (typeof s.id === "string" && typeof s.width === "number" && typeof s.height === "number")
      boxes.set(s.id, s as unknown as Shape);
  return skeletons.map((s) => {
    if ((s.type !== "arrow" && s.type !== "line") || s.points !== undefined) return s;
    const from = boxes.get((s.start as { id?: string } | undefined)?.id ?? "");
    const to = boxes.get((s.end as { id?: string } | undefined)?.id ?? "");
    return from && to ? { ...s, ...route(from, to) } : s;
  });
}

/** Ids of existing elements that arrows of the skeletons bind to. */
export function boundIds(skeletons: ReadonlyArray<Record<string, unknown>>): string[] {
  const own = new Set(skeletons.map((s) => s.id).filter((id) => typeof id === "string"));
  const ids = skeletons.flatMap((s) =>
    (["start", "end"] as const).flatMap((end) => {
      const id = (s[end] as { id?: unknown } | undefined)?.id;
      return typeof id === "string" && !own.has(id) ? [id] : [];
    }),
  );
  return [...new Set(ids)];
}

/**
 * The elements a `draw` call leaves: `add` goes on top, or replaces the
 * element of its id (a newer version, where it stacked); `remove` and
 * `clear` mark elements removed, with their labels. Returns what to write.
 */
export function drawChanges(
  current: ReadonlyArray<DrawingElement>,
  change: {
    readonly add?: ReadonlyArray<DrawingElement>;
    readonly remove?: ReadonlyArray<string>;
    readonly clear?: boolean;
  },
): { write: DrawingElement[]; added: number; replaced: number; removed: number } {
  const byId = new Map(current.map((e) => [e.id, e]));
  const write = new Map<string, DrawingElement>();
  const bump = (e: DrawingElement, patch: Partial<DrawingElement> = {}): DrawingElement => ({
    ...e,
    ...patch,
    version: Math.max(e.version, byId.get(e.id)?.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  });

  const live = visible(current);
  const gone = new Set(change.clear ? live.map((e) => e.id) : []);
  for (const id of change.remove ?? []) {
    const element = byId.get(id);
    if (!element || element.isDeleted) throw new Error(`no element ${id} — view_frame lists them`);
    gone.add(id);
  }
  // A shape's label goes with it.
  for (const e of live) if (e.containerId && gone.has(e.containerId)) gone.add(e.id);
  for (const id of gone) write.set(id, bump(byId.get(id)!, { isDeleted: true }));

  let added = 0;
  let replaced = 0;
  const top = sortElements(current).at(-1)?.index ?? null;
  const fresh = (change.add ?? []).filter((e) => !byId.has(e.id));
  const indices = generateNKeysBetween(top, null, fresh.length);
  for (const element of change.add ?? []) {
    const old = byId.get(element.id);
    if (old) {
      replaced++;
      // An existing shape an arrow binds to keeps its other arrows.
      const bound = [...(old.boundElements ?? []), ...(element.boundElements ?? [])];
      const boundElements = bound.filter((b, i) => bound.findIndex((c) => c.id === b.id) === i);
      write.set(element.id, bump(element, { index: old.index, isDeleted: false, boundElements }));
    } else {
      added++;
      write.set(element.id, { ...element, index: indices[fresh.indexOf(element)]! });
    }
  }
  return { write: [...write.values()], added, replaced, removed: gone.size };
}

// ---------------------------------------------------------------------------
// For agents: a drawing as text

const round = (n: number) => Math.round(n);

/**
 * What a drawing holds, one line per shape: its id, kind, label, place and
 * size, and what each arrow connects. Freehand strokes only show in the image.
 */
export function describeDrawing(elements: ReadonlyArray<DrawingElement>): string[] {
  const live = sortElements(visible(elements));
  if (!live.length) return ["The drawing is empty."];
  const byId = new Map(live.map((e) => [e.id, e]));
  const label = (e: DrawingElement) => {
    const text = live.find((t) => t.containerId === e.id && t.type === "text")?.text;
    return text ? ` ${JSON.stringify(text)}` : "";
  };
  const name = (id: string | undefined) => {
    const e = id ? byId.get(id) : undefined;
    return e ? `${e.id}${label(e)}` : "nothing";
  };
  const xs = live.flatMap((e) => [e.x, e.x + e.width]);
  const ys = live.flatMap((e) => [e.y, e.y + e.height]);
  const lines = [
    `${live.length} elements, within x ${round(Math.min(...xs))}…${round(Math.max(...xs))}, ` +
      `y ${round(Math.min(...ys))}…${round(Math.max(...ys))} (bottom to top):`,
  ];
  let freehand = 0;
  for (const e of live) {
    if (e.type === "text" && e.containerId && byId.has(e.containerId)) continue;
    if (e.type === "freedraw") {
      freehand++;
      continue;
    }
    const at = `at ${round(e.x)},${round(e.y)}`;
    const link = e.link ? ` link ${e.link}` : "";
    if (e.type === "arrow" || e.type === "line") {
      const from = e.startBinding?.elementId;
      const to = e.endBinding?.elementId;
      const ends = from || to ? ` from ${name(from)} to ${name(to)}` : "";
      lines.push(`- ${e.type} ${e.id}${label(e)}${ends} ${at}${link}`);
    } else if (e.type === "text") {
      lines.push(`- text ${e.id} ${JSON.stringify(e.text ?? "")} ${at}${link}`);
    } else {
      const size = `${round(e.width)}×${round(e.height)}`;
      lines.push(`- ${e.type} ${e.id}${label(e)} ${at} ${size}${link}`);
    }
  }
  if (freehand) lines.push(`- ${freehand} freehand stroke${freehand === 1 ? "" : "s"}`);
  return lines;
}

// ---------------------------------------------------------------------------

/** An immutable snapshot per frame, rebuilt only when its elements change. */
export class DrawingStore {
  private snapshot: DrawingElement[];
  constructor(
    private readonly doc: Y.Doc,
    private readonly frameId: string,
  ) {
    this.snapshot = readElements(doc, frameId);
    drawingOf(doc, frameId).observe(() => (this.snapshot = readElements(doc, frameId)));
  }
  subscribe = (onChange: () => void) => {
    const map = drawingOf(this.doc, this.frameId);
    map.observe(onChange);
    return () => map.unobserve(onChange);
  };
  get = () => this.snapshot;
}
const stores = new WeakMap<Y.Doc, Map<string, DrawingStore>>();

/** A frame's elements' snapshot store, one per frame (`useDrawing`, `hooks/use-doc.ts`). */
export function drawingStore(doc: Y.Doc, frameId: string): DrawingStore {
  let perDoc = stores.get(doc);
  if (!perDoc) stores.set(doc, (perDoc = new Map()));
  let store = perDoc.get(frameId);
  if (!store) perDoc.set(frameId, (store = new DrawingStore(doc, frameId)));
  return store;
}

// ---------------------------------------------------------------------------

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * How a drawing sits in a frame body of `width`×`height` at rest: its content
 * and `padding` around it fitted, never enlarged, centred. `zoom` and `scroll`
 * are Excalidraw's for the same view (at a board scale of 1), so the editor
 * opens where the picture was.
 */
export function restingView(bounds: Bounds | null, padding: number, width: number, height: number) {
  if (!bounds) return { zoom: 1, scrollX: 0, scrollY: 0, left: 0, top: 0, width: 0, height: 0 };
  const w = bounds.w + 2 * padding;
  const h = bounds.h + 2 * padding;
  const zoom = Math.min(1, width / w, height / h);
  const left = (width - w * zoom) / 2;
  const top = (height - h * zoom) / 2;
  return {
    zoom,
    // Excalidraw draws a point at (point + scroll) × zoom.
    scrollX: left / zoom - (bounds.x - padding),
    scrollY: top / zoom - (bounds.y - padding),
    left,
    top,
    width: w * zoom,
    height: h * zoom,
  };
}
