/**
 * The board's layout rules, as pure code.
 *
 * The tree (ADR 0010), below: the board is clusters of rows of columns of
 * frames, stored as structure; `resolve` derives every frame's rect from it,
 * the same on every peer, and operations change it by structural targets.
 *
 * Before the tree, positions were the truth, and structure was read off
 * them — still how boards from then are migrated (`migrate`):
 *
 *   cluster  frames within `NEAR` of each other, transitively
 *   row      frames of a cluster whose top edges line up, left to right
 */

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export interface Rect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type Box = Omit<Rect, "id">;
export type Size = Pick<Rect, "w" | "h">;
export type Side = "left" | "right" | "above" | "below";
export interface Point {
  readonly x: number;
  readonly y: number;
}
/** Beside a frame: left or right of it in its row, or a new row above or below its row. */
export interface Beside {
  readonly anchor: string;
  readonly side: Side;
}

export interface Cluster<R extends Rect = Rect> {
  /** The smallest frame id in it: stable while that frame stays. */
  readonly id: string;
  readonly frames: ReadonlyArray<R>;
  /** Top to bottom; each left to right. */
  readonly rows: ReadonlyArray<ReadonlyArray<R>>;
  readonly bounds: Box;
}

/** Space between frames in a cluster: none, they share their borders (ADR 0010). */
export const GAP = 0;
/** Frames this close (or closer) are one cluster. */
export const NEAR = 48;
/** Top edges this close are one row. */
const ROW_TOLERANCE = 16;

/** Empty space between two rects along each axis (0 when they overlap on it). */
function gaps(a: Box, b: Box) {
  return {
    x: Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)),
    y: Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)),
  };
}

const near = (a: Box, b: Box) => {
  const g = gaps(a, b);
  return g.x <= NEAR && g.y <= NEAR;
};

export function clusters<R extends Rect>(rects: ReadonlyArray<R>): Cluster<R>[] {
  const seen = new Set<string>();
  const found: Cluster<R>[] = [];
  for (const start of rects) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const members = [start];
    for (let i = 0; i < members.length; i++)
      for (const other of rects)
        if (!seen.has(other.id) && near(members[i]!, other)) {
          seen.add(other.id);
          members.push(other);
        }
    found.push(cluster(members));
  }
  return found.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function cluster<R extends Rect>(members: R[]): Cluster<R> {
  const rows: R[][] = [];
  for (const frame of [...members].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(frame.y - row[0]!.y) <= ROW_TOLERANCE) row.push(frame);
    else rows.push([frame]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  const x = Math.min(...members.map((f) => f.x));
  const y = Math.min(...members.map((f) => f.y));
  return {
    id: members.map((f) => f.id).sort()[0]!,
    frames: members,
    rows,
    bounds: {
      x,
      y,
      w: Math.max(...members.map((f) => f.x + f.w)) - x,
      h: Math.max(...members.map((f) => f.y + f.h)) - y,
    },
  };
}

// ===========================================================================
// The tree (ADR 0010)
//
//   board → line → cluster (name) → row (h) → column (w) → frame (weight)
//
// Containers are `{ kind, parent, pos, …size }`; frames carry `parent` (their
// column), `pos` and `cluster` (where they go if their column or row is gone).
// `pos` is a fractional index among siblings, ties broken by id: a move is a
// few field writes on one node, so concurrent moves resolve last-writer-wins
// and nothing is duplicated. Only frames and clusters move: a frame moving
// gets a new column, a cluster another line or place in its line, so rows and
// columns keep their parents for good.
//
// Lines of clusters go top to bottom, a cluster's left to right. Boards from
// before lines have their clusters on the board itself, wrapping into another
// line once one got wider than `BOARD_WIDTH`: they show in virtual lines as
// they wrapped, which `repair` makes real.
//
// What concurrency leaves is repaired where it is read: a node whose parent is
// gone goes, in containers of its own, to the end of the nearest ancestor that
// is left (`effective`). Those containers are virtual, with ids made from the
// node's, so every peer shows the same until the host makes them real
// (`repair`). Empty containers are ignored, and the host removes them
// (`prune`).
// ===========================================================================

/** The parent of every cluster. */
export const BOARD = "board";
/** Space between clusters. */
export const CLUSTER_GAP = 120;
/** Boards from before lines: their clusters wrapped into another line once one got wider than this. */
export const BOARD_WIDTH = 4800;
/** The smallest a column is wide, and a row tall. */
export const MIN_W = 280;
export const MIN_H = 180;
/** A column's width and a row's height when nothing says: a frame repaired into new ones. */
export const DEFAULT_W = 640;
export const DEFAULT_H = 480;

export type ContainerKind = "line" | "cluster" | "row" | "column";

export interface Container {
  readonly id: string;
  readonly kind: ContainerKind;
  /** A line's is the board, a cluster's its line, a row's its cluster, a column's its row. */
  readonly parent: string;
  readonly pos: string;
  /** A column's width. */
  readonly w?: number;
  /** A row's height. */
  readonly h?: number;
  /** A cluster's name. */
  readonly name?: string;
}

export interface Leaf {
  readonly id: string;
  /** Its column; none for frames from before the tree, which the host migrates. */
  readonly parent?: string;
  readonly pos?: string;
  /** Its cluster, as last placed: where it goes if its column or row is gone. */
  readonly cluster?: string;
  /** Its share of its column's height; 1 if unset. */
  readonly weight?: number;
  /** A height of its own, in px, kept in full screen (terminals: the host's sizes the PTY). */
  readonly height?: number;
}

export interface Tree {
  readonly containers: ReadonlyArray<Container>;
  readonly frames: ReadonlyArray<Leaf>;
}

/** A change to the board doc; operations return them, to apply as one transaction. */
export type Change =
  /** Create a container, or set some of its fields. */
  | {
      readonly kind: "container";
      readonly id: string;
      readonly set: Partial<Omit<Container, "id">>;
    }
  /** Remove a container. */
  | { readonly kind: "remove"; readonly id: string }
  /** Set where a frame is; `unset` removes fields (a migrated frame's x, y, w, h). */
  | {
      readonly kind: "frame";
      readonly id: string;
      readonly set: Partial<Omit<Leaf, "id">>;
      readonly unset?: ReadonlyArray<string>;
    };

/**
 * Where a frame goes: beside a frame — left or right of it in its row, or a
 * new row above or below its row — or a new cluster (`NewCluster`).
 */
export type Target = Beside | NewCluster;
/** A place for a cluster: a new one, or one moving (`moveCluster`). */
export type NewCluster =
  /**
   * In a line, before one of its clusters (null: at its end). Without the
   * line: `before`'s, or, with neither, the end of the last line.
   */
  | { readonly line?: string; readonly before: string | null }
  /** In a line of its own, before a line (null: under the last). */
  | { readonly lineBefore: string | null };

/** New container ids. */
export type Ids = () => string;
const newId: Ids = () => crypto.randomUUID().slice(0, 8);

// --- The tree as it stands ----------------------------------------------------

interface Node {
  readonly id: string;
  readonly pos: string;
  /** Made up to hold what lost its place; `repair` makes it real. */
  readonly virtual: boolean;
}
interface EColumn extends Node {
  readonly row: string;
  readonly w: number;
  readonly frames: Leaf[];
}
interface ERow extends Node {
  readonly cluster: string;
  readonly h: number;
  readonly columns: EColumn[];
}
interface ECluster extends Node {
  readonly line: string;
  readonly name?: string;
  readonly rows: ERow[];
}
interface ELine extends Node {
  readonly clusters: ECluster[];
}
interface Effective {
  /** In order, empty ones left out; each's clusters, rows and columns too. */
  readonly lines: ELine[];
  /** Every line's clusters, in order. */
  readonly clusters: ECluster[];
  /** Real containers with nothing in them. */
  readonly empty: string[];
  /** Real nodes that lost their place, and the virtual container that holds each. */
  readonly rehomed: ReadonlyArray<{
    readonly id: string;
    readonly parent: string;
    /** A key of its own there, after the rest: joining a real line. */
    readonly pos?: string;
  }>;
  /** Virtual containers, parents first. */
  readonly virtual: ReadonlyArray<Container>;
}

const byPos = <T extends { readonly id: string; readonly pos?: string }>(a: T, b: T) => {
  const [p, q] = [a.pos ?? "", b.pos ?? ""];
  return p < q ? -1 : p > q ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const isKey = (key: unknown): key is string => {
  if (typeof key !== "string") return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
};

/** `n` keys after all of `siblings`. */
function keysAfter(siblings: ReadonlyArray<{ readonly pos?: string }>, n: number): string[] {
  const keys = siblings.map((s) => s.pos).filter(isKey);
  const last = keys.length ? keys.reduce((a, b) => (a > b ? a : b)) : null;
  return generateNKeysBetween(last, null, n);
}

/** The tree with everything in a place: lost nodes in virtual containers, empty ones left out. */
function effective(tree: Tree): Effective {
  const byId = new Map(tree.containers.map((c) => [c.id, c]));
  const is = (id: string | undefined, kind: ContainerKind) =>
    id !== undefined && byId.get(id)?.kind === kind;
  const children = new Map<string, Array<Container | Leaf>>();
  const add = (parent: string, child: Container | Leaf) =>
    children.set(parent, [...(children.get(parent) ?? []), child]);

  const virtual: Container[] = [];
  const rehomed: Array<{ id: string; parent: string; pos?: string }> = [];
  /** Virtual containers per parent, to key after the real ones. */
  const pending = new Map<string, Array<Omit<Container, "pos">>>();
  const make = (c: Omit<Container, "pos">) => {
    if (!pending.has(c.parent)) pending.set(c.parent, []);
    if (!pending.get(c.parent)!.some((p) => p.id === c.id)) pending.get(c.parent)!.push(c);
  };
  /** A virtual line at the end, holding `id`. */
  const newLine = (id: string) => {
    make({ id: `~l${id}`, kind: "line", parent: BOARD });
    return `~l${id}`;
  };
  /** A virtual cluster, in a line of its own at the end. */
  const newCluster = (id: string) => {
    make({ id, kind: "cluster", parent: newLine(id) });
    return id;
  };
  /** A virtual row (and cluster, if `cluster` is gone too) at the end, holding `id`. */
  const newRow = (id: string, cluster: string | undefined) => {
    const home = is(cluster, "cluster") ? cluster! : newCluster(`~k${id}`);
    make({ id: `~r${id}`, kind: "row", parent: home, h: DEFAULT_H });
    return `~r${id}`;
  };

  /** Clusters from before lines, on the board itself. */
  const unlined: Container[] = [];
  for (const c of tree.containers) {
    if (c.kind === "line") add(BOARD, c);
    else if (c.kind === "cluster") {
      if (is(c.parent, "line")) add(c.parent, c);
      else if (c.parent === BOARD) unlined.push(c);
      else rehomed.push({ id: c.id, parent: newLine(c.id) });
    } else if (c.kind === "row") {
      if (is(c.parent, "cluster")) add(c.parent, c);
      else rehomed.push({ id: c.id, parent: newCluster(`~k${c.id}`) });
    } else if (c.kind === "column") {
      if (is(c.parent, "row")) add(c.parent, c);
      else {
        const first = tree.frames
          .filter((f) => f.parent === c.id && is(f.cluster, "cluster"))
          .sort(byPos)[0];
        const row = newRow(c.id, first?.cluster);
        rehomed.push({ id: c.id, parent: row });
      }
    }
  }
  for (const f of tree.frames) {
    if (is(f.parent, "column")) add(f.parent!, f);
    else {
      const row = newRow(f.id, f.cluster);
      make({ id: `~c${f.id}`, kind: "column", parent: row, w: DEFAULT_W });
      rehomed.push({ id: f.id, parent: `~c${f.id}` });
    }
  }
  // Clusters from before lines: at the end of the last line, wrapping into
  // lines of their own as they wrapped then (`BOARD_WIDTH`).
  const last = (children.get(BOARD) ?? []).sort(byPos).at(-1);
  const inLast = last ? (children.get(last.id) ?? []) : [];
  let x = inLast.reduce((sum, k) => {
    const w = widthOf(tree, k.id);
    return w ? sum + w + CLUSTER_GAP : sum;
  }, 0);
  let line = last?.id ?? "";
  const joining: string[] = [];
  for (const k of unlined.sort(byPos)) {
    const w = widthOf(tree, k.id);
    if (!w) continue;
    if (!line || (x > 0 && x + w > BOARD_WIDTH)) {
      line = newLine(k.id);
      x = 0;
    }
    if (line === last?.id) joining.push(k.id);
    else rehomed.push({ id: k.id, parent: line });
    x += w + CLUSTER_GAP;
  }
  const joined = keysAfter(inLast, joining.length);
  joining.forEach((id, i) => rehomed.push({ id, parent: last!.id, pos: joined[i]! }));
  // Keys after the real siblings, parents before children.
  for (const kind of ["line", "cluster", "row", "column"] as const)
    for (const [parent, made] of pending) {
      const ofKind = made.filter((c) => c.kind === kind).sort((a, b) => (a.id < b.id ? -1 : 1));
      if (!ofKind.length) continue;
      const keys = keysAfter(children.get(parent) ?? [], ofKind.length);
      ofKind.forEach((c, i) => {
        const container = { ...c, pos: keys[i]! };
        virtual.push(container);
        add(parent, container);
      });
    }
  for (const { id, parent, pos } of rehomed) {
    const node = byId.get(id) ?? tree.frames.find((f) => f.id === id)!;
    add(parent, pos ? { ...node, pos } : node);
  }

  const empty: string[] = [];
  const isVirtual = new Set(virtual.map((c) => c.id));
  const sorted = (parent: string) => [...(children.get(parent) ?? [])].sort(byPos);
  const keep = <T extends Node>(node: T, full: boolean): T | null => {
    if (full) return node;
    if (!node.virtual) empty.push(node.id);
    return null;
  };
  const lines: ELine[] = [];
  for (const l of sorted(BOARD) as Container[]) {
    const clusters: ECluster[] = [];
    for (const k of sorted(l.id) as Container[]) {
      const rows: ERow[] = [];
      for (const r of sorted(k.id) as Container[]) {
        const columns: EColumn[] = [];
        for (const c of sorted(r.id) as Container[]) {
          const frames = sorted(c.id) as Leaf[];
          const column = keep(
            {
              id: c.id,
              pos: c.pos,
              virtual: isVirtual.has(c.id),
              row: r.id,
              w: c.w ?? DEFAULT_W,
              frames,
            },
            frames.length > 0,
          );
          if (column) columns.push(column);
        }
        const row = keep(
          {
            id: r.id,
            pos: r.pos,
            virtual: isVirtual.has(r.id),
            cluster: k.id,
            h: r.h ?? DEFAULT_H,
            columns,
          },
          columns.length > 0,
        );
        if (row) rows.push(row);
      }
      const cluster = keep(
        {
          id: k.id,
          pos: k.pos,
          virtual: isVirtual.has(k.id),
          line: l.id,
          rows,
          ...(k.name !== undefined && { name: k.name }),
        },
        rows.length > 0,
      );
      if (cluster) clusters.push(cluster);
    }
    const kept = keep(
      { id: l.id, pos: l.pos, virtual: isVirtual.has(l.id), clusters },
      clusters.length > 0,
    );
    if (kept) lines.push(kept);
  }
  return { lines, clusters: lines.flatMap((l) => l.clusters), empty, rehomed, virtual };
}

/** How wide a cluster is, by its rows' columns that hold frames: 0 if none. */
function widthOf(tree: Tree, cluster: string): number {
  const held = new Set(tree.frames.map((f) => f.parent));
  const rows = tree.containers.filter((c) => c.kind === "row" && c.parent === cluster);
  return Math.max(
    0,
    ...rows.map((r) =>
      tree.containers
        .filter((c) => c.kind === "column" && c.parent === r.id && held.has(c.id))
        .reduce((w, c) => w + (c.w ?? DEFAULT_W) + GAP, -GAP),
    ),
  );
}

// --- Positions ------------------------------------------------------------------

export interface ResolvedColumn {
  readonly id: string;
  readonly box: Box;
  /** Top to bottom. */
  readonly frames: ReadonlyArray<Rect>;
}
export interface ResolvedRow {
  readonly id: string;
  readonly box: Box;
  /** Left to right. */
  readonly columns: ReadonlyArray<ResolvedColumn>;
}
export interface ResolvedCluster {
  readonly id: string;
  readonly name?: string;
  readonly box: Box;
  /** Top to bottom. */
  readonly rows: ReadonlyArray<ResolvedRow>;
}
export interface ResolvedLine {
  readonly id: string;
  /** From the board's left edge to its last cluster's right, as tall as its tallest. */
  readonly box: Box;
  /** Left to right. */
  readonly clusters: ReadonlyArray<ResolvedCluster>;
}
export interface Placement {
  readonly cluster: ResolvedCluster;
  readonly row: ResolvedRow;
  readonly column: ResolvedColumn;
  readonly frame: Rect;
}
export interface Layout {
  /** Top to bottom. */
  readonly lines: ReadonlyArray<ResolvedLine>;
  /** Every line's clusters, in order: left to right, then the next line's. */
  readonly clusters: ReadonlyArray<ResolvedCluster>;
  readonly frames: ReadonlyMap<string, Placement>;
  /** Containers with nothing in them: the host removes them (`prune`). */
  readonly empty: ReadonlyArray<string>;
  /** Frames shown away from where the doc has them: the host puts them there (`repair`). */
  readonly orphans: ReadonlyArray<string>;
}

/** What differs between views of one board. */
export interface ResolveContext {
  /** Full screen: the row it shows is as tall as the screen; frames with a height keep it. */
  readonly fullscreen?: { readonly row: string; readonly height: number } | null;
}

/** Every frame's rect, from the tree: the same on every peer for the same context. */
export function resolve(tree: Tree, context: ResolveContext = {}): Layout {
  const e = effective(tree);
  const frames = new Map<string, Placement>();
  const inVirtual = new Set(e.virtual.map((c) => c.id));
  const orphans: string[] = [];
  const lines: ResolvedLine[] = [];
  let y = 0;
  for (const l of e.lines) {
    const clusters: ResolvedCluster[] = [];
    let x = 0;
    let h = 0;
    for (const k of l.clusters) {
      const shaped = shape(k, context);
      const cluster = place(shaped.cluster, x, y);
      clusters.push(cluster);
      for (const row of cluster.rows)
        for (const column of row.columns)
          for (const frame of column.frames) {
            frames.set(frame.id, { cluster, row, column, frame });
            if ([l.id, k.id, row.id, column.id].some((id) => inVirtual.has(id)))
              orphans.push(frame.id);
          }
      x += shaped.w + CLUSTER_GAP;
      h = Math.max(h, shaped.h);
    }
    lines.push({ id: l.id, box: { x: 0, y, w: x - CLUSTER_GAP, h }, clusters });
    y += h + CLUSTER_GAP;
  }
  return { lines, clusters: lines.flatMap((l) => l.clusters), frames, empty: e.empty, orphans };
}

/** A cluster laid out from (0, 0), and its size. */
function shape(k: ECluster, context: ResolveContext) {
  let top = 0;
  const rows = k.rows.map((r): ResolvedRow => {
    const full = context.fullscreen?.row === r.id ? context.fullscreen.height : null;
    const h = full ?? r.h;
    let left = 0;
    const columns = r.columns.map((c): ResolvedColumn => {
      const heights = split(c.frames, h, full !== null);
      let at = top;
      const frames = c.frames.map((f, i) => {
        const rect = { id: f.id, x: left, y: at, w: c.w, h: heights[i]! };
        at += rect.h + GAP;
        return rect;
      });
      const column = { id: c.id, box: { x: left, y: top, w: c.w, h }, frames };
      left += c.w + GAP;
      return column;
    });
    const row = { id: r.id, box: { x: 0, y: top, w: left - GAP, h }, columns };
    top += h + GAP;
    return row;
  });
  const w = Math.max(...rows.map((r) => r.box.w));
  const cluster: ResolvedCluster = {
    id: k.id,
    ...(k.name !== undefined && { name: k.name }),
    box: { x: 0, y: 0, w, h: top - GAP },
    rows,
  };
  return { cluster, w, h: top - GAP };
}

/** A column's height shared by its frames' weights; in full screen, frames with a height keep it. */
function split(frames: ReadonlyArray<Leaf>, h: number, fullscreen: boolean): number[] {
  const own = (f: Leaf) => (fullscreen && f.height !== undefined ? f.height : null);
  const room = h - GAP * (frames.length - 1);
  const fixed = frames.reduce((sum, f) => sum + (own(f) ?? 0), 0);
  const weights = frames.reduce((sum, f) => sum + (own(f) === null ? weight(f) : 0), 0);
  const rest = Math.max(0, room - fixed);
  return frames.map((f) => own(f) ?? (weights ? (rest * weight(f)) / weights : 0));
}
const weight = (f: Leaf) => (f.weight !== undefined && f.weight > 0 ? f.weight : 1);

/** A cluster shaped at (0, 0), moved to (x, y). */
function place(k: ResolvedCluster, x: number, y: number): ResolvedCluster {
  const move = <B extends Box>(b: B): B => ({ ...b, x: b.x + x, y: b.y + y });
  return {
    ...k,
    box: move(k.box),
    rows: k.rows.map((r) => ({
      ...r,
      box: move(r.box),
      columns: r.columns.map((c) => ({ ...c, box: move(c.box), frames: c.frames.map(move) })),
    })),
  };
}

// --- Operations -----------------------------------------------------------------

/** The changes that put what lost its place where `resolve` shows it, in real containers. */
export function repair(tree: Tree, ids: Ids = newId): Change[] {
  const e = effective(tree);
  if (!e.virtual.length && !e.rehomed.length) return [];
  const real = new Map(e.virtual.map((c) => [c.id, ids()]));
  const as = (id: string) => real.get(id) ?? id;
  const changes: Change[] = e.virtual.map(({ id, ...c }) => ({
    kind: "container",
    id: as(id),
    set: { ...c, parent: as(c.parent) },
  }));
  const frames = new Set(tree.frames.map((f) => f.id));
  for (const { id, parent, pos } of e.rehomed)
    changes.push(
      frames.has(id)
        ? { kind: "frame", id, set: { parent: as(parent), pos: FIRST } }
        : { kind: "container", id, set: { parent: as(parent), ...(pos && { pos }) } },
    );
  // Frames that moved with their column or row take their cluster along.
  for (const k of e.clusters)
    for (const r of k.rows)
      for (const c of r.columns)
        for (const f of c.frames)
          if ((k.virtual || r.virtual || c.virtual) && f.cluster !== as(k.id)) {
            const at = changes.find((ch) => ch.kind === "frame" && ch.id === f.id);
            if (at?.kind === "frame") Object.assign(at, { set: { ...at.set, cluster: as(k.id) } });
            else changes.push({ kind: "frame", id: f.id, set: { cluster: as(k.id) } });
          }
  return changes;
}

/** Remove the containers with nothing in them. */
export function prune(tree: Tree): Change[] {
  return effective(tree).empty.map((id) => ({ kind: "remove", id }));
}

/** The first key among no siblings. */
const FIRST = generateKeyBetween(null, null);

/** Put a frame that isn't on the board yet at `target`, `size` its column's width and a new row's height. */
export function insert(
  tree: Tree,
  frame: string,
  target: Target,
  size: Size,
  ids: Ids = newId,
): Change[] {
  const fixed = repaired(tree, ids);
  return [...fixed.changes, ...put(effective(fixed.tree), frame, target, size, ids)];
}

/** Move a frame to `target`: it keeps its column's width, and in a new row its row's height. */
export function move(tree: Tree, frame: string, target: Target, ids: Ids = newId): Change[] {
  if ("anchor" in target && target.anchor === frame)
    throw new Error("a frame can't go next to itself");
  const fixed = repaired(tree, ids);
  const e = effective(fixed.tree);
  const at = find(e, frame);
  if (!at) throw new Error(`no frame ${frame}`);
  return [...fixed.changes, ...put(e, frame, target, { w: at.column.w, h: at.row.h }, ids)];
}

/** Move a cluster to another place: in a line, or a line of its own. */
export function moveCluster(
  tree: Tree,
  cluster: string,
  to: NewCluster,
  ids: Ids = newId,
): Change[] {
  if ("before" in to && to.before === cluster) return [];
  const fixed = repaired(tree, ids);
  const e = effective(fixed.tree);
  if (!e.clusters.some((k) => k.id === cluster)) throw new Error(`no cluster ${cluster}`);
  const { changes, line, pos } = lineUp(e, to, ids, cluster);
  return [
    ...fixed.changes,
    ...changes,
    { kind: "container", id: cluster, set: { parent: line, pos } },
  ];
}

/**
 * Where a cluster goes (`NewCluster`): its line and its key in it, and the
 * changes that make room — a new line, or new keys. `moving` is left out of
 * its line's siblings.
 */
function lineUp(
  e: Effective,
  to: NewCluster,
  ids: Ids,
  moving?: string,
): { changes: Change[]; line: string; pos: string } {
  const newLine = (index: number) => {
    const { pos, rekey } = slot(e.lines, index, "container");
    const line = ids();
    const set = { kind: "line", parent: BOARD, pos } as const;
    return {
      changes: [...rekey, { kind: "container", id: line, set } as Change],
      line,
      pos: FIRST,
    };
  };
  if ("lineBefore" in to) {
    const index =
      to.lineBefore === null ? e.lines.length : e.lines.findIndex((l) => l.id === to.lineBefore);
    if (index < 0) throw new Error(`no line ${to.lineBefore}`);
    return newLine(index);
  }
  const line = to.line
    ? e.lines.find((l) => l.id === to.line)
    : to.before
      ? e.lines.find((l) => l.clusters.some((k) => k.id === to.before))
      : e.lines.at(-1);
  if (!line) {
    if (to.line || to.before) throw new Error(`no line ${to.line ?? `of ${to.before}`}`);
    return newLine(0);
  }
  const clusters = line.clusters.filter((k) => k.id !== moving);
  const index =
    to.before === null ? clusters.length : clusters.findIndex((k) => k.id === to.before);
  if (index < 0) throw new Error(`no cluster ${to.before} in line ${line.id}`);
  const { pos, rekey } = slot(clusters, index, "container");
  return { changes: rekey, line: line.id, pos };
}

/** A column's width, a row's height, or a frame's own height — no smaller than the least. */
export function resize(
  what:
    | { readonly column: string; readonly w: number }
    | { readonly row: string; readonly h: number }
    | { readonly frame: string; readonly height: number },
): Change[] {
  if ("column" in what)
    return [
      { kind: "container", id: what.column, set: { w: Math.max(MIN_W, Math.round(what.w)) } },
    ];
  if ("row" in what)
    return [{ kind: "container", id: what.row, set: { h: Math.max(MIN_H, Math.round(what.h)) } }];
  return [
    { kind: "frame", id: what.frame, set: { height: Math.max(MIN_H, Math.round(what.height)) } },
  ];
}

/**
 * The tree for boards from before it: `rects`, frames placed by position,
 * read as clusters and rows (`clusters`) — each frame a column as wide as it
 * was, each row as tall as its tallest — after the clusters there are.
 * `keepHeight` frames keep theirs as their own (terminals).
 */
export function migrate(
  tree: Tree,
  rects: ReadonlyArray<Rect & { readonly keepHeight?: boolean }>,
  ids: Ids = newId,
): Change[] {
  if (!rects.length) return [];
  const found = clusters(rects);
  const keys = keysAfter(
    tree.containers.filter((c) => c.kind === "cluster"),
    found.length,
  );
  const changes: Change[] = [];
  found.forEach((k, i) => {
    const cluster = ids();
    changes.push({
      kind: "container",
      id: cluster,
      set: { kind: "cluster", parent: BOARD, pos: keys[i]! },
    });
    const rowKeys = generateNKeysBetween(null, null, k.rows.length);
    k.rows.forEach((frames, j) => {
      const row = ids();
      const h = Math.max(...frames.map((f) => f.h));
      changes.push({
        kind: "container",
        id: row,
        set: { kind: "row", parent: cluster, pos: rowKeys[j]!, h },
      });
      const columnKeys = generateNKeysBetween(null, null, frames.length);
      frames.forEach((f, n) => {
        const column = ids();
        changes.push({
          kind: "container",
          id: column,
          set: { kind: "column", parent: row, pos: columnKeys[n]!, w: f.w },
        });
        changes.push({
          kind: "frame",
          id: f.id,
          set: { parent: column, pos: FIRST, cluster, ...(f.keepHeight && { height: f.h }) },
          unset: ["x", "y", "w", "h"],
        });
      });
    });
  });
  return changes;
}

/** The tree after `changes`: for previews, and for operations building on others. */
export function applyChanges(tree: Tree, changes: ReadonlyArray<Change>): Tree {
  const containers = new Map(tree.containers.map((c) => [c.id, c]));
  const frames = new Map(tree.frames.map((f) => [f.id, f]));
  for (const change of changes)
    if (change.kind === "remove") containers.delete(change.id);
    else if (change.kind === "container")
      containers.set(change.id, {
        ...containers.get(change.id),
        ...change.set,
        id: change.id,
      } as Container);
    else {
      const next: Record<string, unknown> = {
        ...frames.get(change.id),
        ...change.set,
        id: change.id,
      };
      for (const key of change.unset ?? []) delete next[key];
      frames.set(change.id, next as unknown as Leaf);
    }
  return { containers: [...containers.values()], frames: [...frames.values()] };
}

/** The tree with what lost its place made real first, if anything did: operations build on it. */
function repaired(tree: Tree, ids: Ids) {
  const changes = repair(tree, ids);
  return { tree: changes.length ? applyChanges(tree, changes) : tree, changes };
}

function find(e: Effective, frame: string) {
  for (const cluster of e.clusters)
    for (const row of cluster.rows)
      for (const column of row.columns)
        if (column.frames.some((f) => f.id === frame)) return { cluster, row, column };
  return null;
}

/** The changes that put `frame` at `target`, in new containers. */
function put(e: Effective, frame: string, target: Target, size: Size, ids: Ids): Change[] {
  const changes: Change[] = [];
  const container = (set: Omit<Container, "id">) => {
    const id = ids();
    changes.push({ kind: "container", id, set });
    return id;
  };
  let cluster: string;
  let row: string;
  if ("anchor" in target) {
    const at = find(e, target.anchor);
    if (!at) throw new Error(`no frame ${target.anchor}`);
    cluster = at.cluster.id;
    if (target.side === "left" || target.side === "right") {
      row = at.row.id;
      const i = at.row.columns.indexOf(at.column) + (target.side === "right" ? 1 : 0);
      const { pos, rekey } = slot(at.row.columns, i, "container");
      changes.push(...rekey);
      const column = container({ kind: "column", parent: row, pos, w: size.w });
      changes.push({ kind: "frame", id: frame, set: { parent: column, pos: FIRST, cluster } });
      return changes;
    }
    const i = at.cluster.rows.indexOf(at.row) + (target.side === "below" ? 1 : 0);
    const { pos, rekey } = slot(at.cluster.rows, i, "container");
    changes.push(...rekey);
    row = container({ kind: "row", parent: cluster, pos, h: size.h });
  } else {
    const at = lineUp(e, target, ids);
    changes.push(...at.changes);
    cluster = container({ kind: "cluster", parent: at.line, pos: at.pos });
    row = container({ kind: "row", parent: cluster, pos: FIRST, h: size.h });
  }
  const column = container({ kind: "column", parent: row, pos: FIRST, w: size.w });
  changes.push({ kind: "frame", id: frame, set: { parent: column, pos: FIRST, cluster } });
  return changes;
}

/**
 * A key for a new sibling at `index` of `siblings`. Where there is none
 * between its neighbours (two peers took the same key), they get new keys.
 */
function slot(
  siblings: ReadonlyArray<{ readonly id: string; readonly pos: string }>,
  index: number,
  kind: "container" | "frame",
): { pos: string; rekey: Change[] } {
  try {
    const pos = generateKeyBetween(siblings[index - 1]?.pos ?? null, siblings[index]?.pos ?? null);
    return { pos, rekey: [] };
  } catch {
    const keys = generateNKeysBetween(null, null, siblings.length + 1);
    const rekey = siblings.map((s, i): Change => ({
      kind,
      id: s.id,
      set: { pos: keys[i < index ? i : i + 1]! },
    }));
    return { pos: keys[index]!, rekey };
  }
}

// --- Drop zones ----------------------------------------------------------------
//
// A drag goes by the pointer, not by the dragged frame's geometry, and is hit
// against the board laid out without what is dragged (`without`): what the
// pointer is over doesn't change as the others make room.

/** How far outside a cluster a drop still goes beside its frames. */
export const CLUSTER_REACH = CLUSTER_GAP / 3;
/** How much of a frame's height, at its top and bottom, drops into a row above or below. */
export const ROW_BAND = 0.2;

/** The tree without some frames: the board a drag of them is hit against. */
export function without(tree: Tree, frames: ReadonlySet<string>): Tree {
  return { ...tree, frames: tree.frames.filter((f) => !frames.has(f.id)) };
}

/**
 * Where a drop at `point` goes. Over a cluster (or just outside it), beside
 * its frame nearest the point: in its top or bottom `ROW_BAND`, a new row
 * above or below; else by its half, before or after it in its row. Elsewhere,
 * or with `newCluster`, a cluster of its own there (`slotAt`).
 *
 * A drag hits with the pointer's x and the dragged frame's middle's y
 * (`dropPoint`): held by its header, the pointer is at its top.
 */
export function dropAt(
  layout: Layout,
  point: Point,
  { newCluster = false }: { readonly newCluster?: boolean } = {},
): Target {
  const cluster = newCluster
    ? undefined
    : layout.clusters.find(({ box }) => distance(box, point) <= CLUSTER_REACH);
  if (!cluster) return slotAt(layout, point);
  let nearest: Rect | null = null;
  for (const row of cluster.rows)
    for (const column of row.columns)
      for (const frame of column.frames)
        if (!nearest || distance(frame, point) < distance(nearest, point)) nearest = frame;
  const f = nearest!;
  const u = Math.min(Math.max((point.x - f.x) / f.w, 0), 1);
  const v = Math.min(Math.max((point.y - f.y) / f.h, 0), 1);
  const side = v < ROW_BAND ? "above" : v > 1 - ROW_BAND ? "below" : u < 0.5 ? "left" : "right";
  return { anchor: f.id, side };
}

/** Where a dragged frame hits: the pointer's x, its middle's y (`dropAt`). */
export const dropPoint = (pointer: Point, grab: Point, h: number): Point => ({
  x: pointer.x,
  y: pointer.y - grab.y + h / 2,
});

/**
 * The layout with its clusters where they are in `at`, as a drag of frames
 * shows the board and hits it: what changes inside clusters shows, but no
 * cluster moves away from the pointer. Clusters new to it stay where they are.
 */
export function pin(layout: Layout, at: Layout): Layout {
  const origins = new Map(at.clusters.map((k) => [k.id, k.box]));
  const boxes = new Map(at.lines.map((l) => [l.id, l.box]));
  const frames = new Map<string, Placement>();
  const lines = layout.lines.map((l) => ({
    ...l,
    box: boxes.get(l.id) ?? l.box,
    clusters: l.clusters.map((k) => {
      const to = origins.get(k.id);
      const cluster = to ? place(k, to.x - k.box.x, to.y - k.box.y) : k;
      for (const row of cluster.rows)
        for (const column of row.columns)
          for (const frame of column.frames) frames.set(frame.id, { cluster, row, column, frame });
      return cluster;
    }),
  }));
  return { ...layout, lines, clusters: lines.flatMap((l) => l.clusters), frames };
}

/**
 * A cluster's place where `point` is: in the line it is over, before the
 * first cluster whose middle it is left of (or at the line's end); above a
 * line, in the gap or over the board's top, a line of its own before it;
 * under the last, a line of its own there.
 */
export function slotAt(layout: Layout, point: Point): NewCluster {
  if (!layout.lines.length) return { before: null };
  const line = layout.lines.find(({ box }) => point.y < box.y + box.h);
  if (!line) return { lineBefore: null };
  if (point.y < line.box.y) return { lineBefore: line.id };
  const next = line.clusters.find(({ box }) => point.x < box.x + box.w / 2);
  return { line: line.id, before: next?.id ?? null };
}

/**
 * Where a dragged cluster hits: the pointer's x, and, up and down, a little
 * under its top — in a line when its top is about level with the line's.
 */
export const clusterPoint = (pointer: Point, grab: Point): Point => ({
  x: pointer.x,
  y: pointer.y - grab.y + CLUSTER_GAP / 2,
});

/**
 * Along a row, as full screen moves frames: before or after the frame the
 * pointer is over (or nearest), by its half; null when the row has none.
 */
export function alongAt(layout: Layout, row: string, x: number): Beside | null {
  const columns = layout.clusters.flatMap((k) => k.rows).find((r) => r.id === row)?.columns;
  if (!columns?.length) return null;
  const at = (c: ResolvedColumn) => Math.max(c.box.x - x, 0, x - c.box.x - c.box.w);
  const column = columns.reduce((a, b) => (at(b) < at(a) ? b : a));
  const side = x < column.box.x + column.box.w / 2 ? "left" : "right";
  return { anchor: column.frames[0]!.id, side };
}

/** How far a point is from a box; 0 inside it. */
function distance(box: Box, point: Point): number {
  const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.w);
  const dy = Math.max(box.y - point.y, 0, point.y - box.y - box.h);
  return Math.hypot(dx, dy);
}

// --- The keyboard (decision 9) -------------------------------------------------

export type Direction = "left" | "right" | "up" | "down";

/**
 * The frame next to `id` that way: the column beside it in its row, or, up
 * and down, the frame of the row above or below under its middle. Past its
 * row's or cluster's end, the nearest frame that way on the board.
 */
export function neighbour(layout: Layout, id: string, direction: Direction): string | null {
  const at = layout.frames.get(id);
  if (!at) return null;
  const { cluster, row, column, frame } = at;
  const step = direction === "left" || direction === "up" ? -1 : 1;
  if (direction === "left" || direction === "right") {
    const next = row.columns[row.columns.findIndex((c) => c.id === column.id) + step];
    if (next) return next.frames[0]!.id;
  } else {
    const next = cluster.rows[cluster.rows.findIndex((r) => r.id === row.id) + step];
    if (next) return under(next, frame.x + frame.w / 2).frames[0]!.id;
  }
  return nearestThatWay(layout, frame, direction);
}

/**
 * Where the keyboard moves a frame that way: before or after its neighbour
 * in its row; up or down, into the row beside, by the frame under its middle,
 * or, with none, into a new row of its own there. Null where it can't go.
 */
export function nudge(layout: Layout, id: string, direction: Direction): Beside | null {
  const at = layout.frames.get(id);
  if (!at) return null;
  const { cluster, row, column, frame } = at;
  if (direction === "left" || direction === "right") {
    const i = row.columns.findIndex((c) => c.id === column.id);
    const next = row.columns[i + (direction === "left" ? -1 : 1)];
    return next ? { anchor: next.frames[0]!.id, side: direction } : null;
  }
  const r = cluster.rows.findIndex((x) => x.id === row.id);
  const next = cluster.rows[r + (direction === "up" ? -1 : 1)];
  const middle = frame.x + frame.w / 2;
  if (next) {
    const c = under(next, middle);
    const side = middle < c.box.x + c.box.w / 2 ? "left" : "right";
    return { anchor: c.frames[0]!.id, side };
  }
  // A row of its own, above or below the one it leaves: not if it is alone there.
  const other = row.columns.find((c) => c.id !== column.id);
  return other
    ? { anchor: other.frames[0]!.id, side: direction === "up" ? "above" : "below" }
    : null;
}

/** The column of a row under `x`, or the nearest to it. */
function under(row: ResolvedRow, x: number): ResolvedColumn {
  const off = (c: ResolvedColumn) => Math.max(c.box.x - x, 0, x - c.box.x - c.box.w);
  return row.columns.reduce((a, b) => (off(b) < off(a) ? b : a));
}

/** The nearest frame wholly that way of `from`, going straight counting over going aside. */
function nearestThatWay(layout: Layout, from: Rect, direction: Direction): string | null {
  const [cx, cy] = [from.x + from.w / 2, from.y + from.h / 2];
  let best: { id: string; score: number } | null = null;
  for (const { frame: f } of layout.frames.values()) {
    if (f.id === from.id) continue;
    const ahead = {
      left: from.x - (f.x + f.w),
      right: f.x - (from.x + from.w),
      up: from.y - (f.y + f.h),
      down: f.y - (from.y + from.h),
    }[direction];
    if (ahead < -1) continue;
    const aside =
      direction === "left" || direction === "right"
        ? Math.max(f.y - cy, 0, cy - f.y - f.h)
        : Math.max(f.x - cx, 0, cx - f.x - f.w);
    const score = Math.max(ahead, 0) + 2 * aside;
    if (!best || score < best.score) best = { id: f.id, score };
  }
  return best?.id ?? null;
}
