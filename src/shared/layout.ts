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

/** Space between frames in a cluster. */
export const GAP = 24;
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
//   board → cluster (name) → row (h) → column (w) → frame (weight)
//
// Containers are `{ kind, parent, pos, …size }`; frames carry `parent` (their
// column), `pos` and `cluster` (where they go if their column or row is gone).
// `pos` is a fractional index among siblings, ties broken by id: a move is a
// few field writes on one node, so concurrent moves resolve last-writer-wins
// and nothing is duplicated. Only frames and clusters move: a frame moving
// gets a new column, so rows and columns keep their parents for good.
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
/** Clusters are arranged in rows, left to right; a row wraps once it gets wider than this. */
export const BOARD_WIDTH = 4800;
/** The smallest a column is wide, and a row tall. */
export const MIN_W = 280;
export const MIN_H = 180;
/** A column's width and a row's height when nothing says: a frame repaired into new ones. */
export const DEFAULT_W = 640;
export const DEFAULT_H = 480;

export type ContainerKind = "cluster" | "row" | "column";

export interface Container {
  readonly id: string;
  readonly kind: ContainerKind;
  /** A cluster's is the board, a row's its cluster, a column's its row. */
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
 * new row above or below its row — or a new cluster before another (null: at
 * the end).
 */
export type Target = Beside | NewCluster;
export interface NewCluster {
  readonly before: string | null;
}

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
  readonly name?: string;
  readonly rows: ERow[];
}
interface Effective {
  /** In order, empty ones left out; each's rows and columns too. */
  readonly clusters: ECluster[];
  /** Real containers with nothing in them. */
  readonly empty: string[];
  /** Real nodes that lost their place, and the virtual container that holds each. */
  readonly rehomed: ReadonlyArray<{ readonly id: string; readonly parent: string }>;
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
  const rehomed: Array<{ id: string; parent: string }> = [];
  /** Virtual containers per parent, to key after the real ones. */
  const pending = new Map<string, Array<Omit<Container, "pos">>>();
  const make = (c: Omit<Container, "pos">) => {
    if (!pending.has(c.parent)) pending.set(c.parent, []);
    if (!pending.get(c.parent)!.some((p) => p.id === c.id)) pending.get(c.parent)!.push(c);
  };
  /** A virtual row (and cluster, if `cluster` is gone too) at the end, holding `id`. */
  const newRow = (id: string, cluster: string | undefined) => {
    const home = is(cluster, "cluster") ? cluster! : `~k${id}`;
    if (home !== cluster) make({ id: home, kind: "cluster", parent: BOARD });
    make({ id: `~r${id}`, kind: "row", parent: home, h: DEFAULT_H });
    return `~r${id}`;
  };

  for (const c of tree.containers) {
    if (c.kind === "cluster") add(BOARD, c);
    else if (c.kind === "row") {
      if (is(c.parent, "cluster")) add(c.parent, c);
      else {
        make({ id: `~k${c.id}`, kind: "cluster", parent: BOARD });
        rehomed.push({ id: c.id, parent: `~k${c.id}` });
      }
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
  // Keys after the real siblings, parents before children.
  for (const kind of ["cluster", "row", "column"] as const)
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
  for (const { id, parent } of rehomed) {
    const node = byId.get(id) ?? tree.frames.find((f) => f.id === id)!;
    add(parent, node);
  }

  const empty: string[] = [];
  const isVirtual = new Set(virtual.map((c) => c.id));
  const sorted = (parent: string) => [...(children.get(parent) ?? [])].sort(byPos);
  const keep = <T extends Node>(node: T, full: boolean): T | null => {
    if (full) return node;
    if (!node.virtual) empty.push(node.id);
    return null;
  };
  const clusters: ECluster[] = [];
  for (const k of sorted(BOARD) as Container[]) {
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
        rows,
        ...(k.name !== undefined && { name: k.name }),
      },
      rows.length > 0,
    );
    if (cluster) clusters.push(cluster);
  }
  return { clusters, empty, rehomed, virtual };
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
export interface Placement {
  readonly cluster: ResolvedCluster;
  readonly row: ResolvedRow;
  readonly column: ResolvedColumn;
  readonly frame: Rect;
}
export interface Layout {
  /** In order: left to right, then the next row of clusters. */
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
  const clusters: ResolvedCluster[] = [];
  let x = 0;
  let y = 0;
  let lineH = 0;
  for (const k of e.clusters) {
    const shaped = shape(k, context);
    if (x > 0 && x + shaped.w > BOARD_WIDTH) {
      x = 0;
      y += lineH + CLUSTER_GAP;
      lineH = 0;
    }
    const cluster = place(shaped.cluster, x, y);
    clusters.push(cluster);
    for (const row of cluster.rows)
      for (const column of row.columns)
        for (const frame of column.frames) {
          frames.set(frame.id, { cluster, row, column, frame });
          if (inVirtual.has(k.id) || inVirtual.has(row.id) || inVirtual.has(column.id))
            orphans.push(frame.id);
        }
    x += shaped.w + CLUSTER_GAP;
    lineH = Math.max(lineH, shaped.h);
  }
  return { clusters, frames, empty: e.empty, orphans };
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
  if (!e.virtual.length) return [];
  const real = new Map(e.virtual.map((c) => [c.id, ids()]));
  const as = (id: string) => real.get(id) ?? id;
  const changes: Change[] = e.virtual.map(({ id, ...c }) => ({
    kind: "container",
    id: as(id),
    set: { ...c, parent: as(c.parent) },
  }));
  const frames = new Set(tree.frames.map((f) => f.id));
  for (const { id, parent } of e.rehomed)
    changes.push(
      frames.has(id)
        ? { kind: "frame", id, set: { parent: as(parent), pos: FIRST } }
        : { kind: "container", id, set: { parent: as(parent) } },
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

/** Move a cluster before another (null: to the end). */
export function moveCluster(tree: Tree, cluster: string, before: string | null): Change[] {
  if (before === cluster) return [];
  const others = effective(tree).clusters.filter((k) => k.id !== cluster);
  const index = before === null ? others.length : others.findIndex((k) => k.id === before);
  if (index < 0) throw new Error(`no cluster ${before}`);
  const { pos, rekey } = slot(others, index, "container");
  return [...rekey, { kind: "container", id: cluster, set: { pos } }];
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
    const index =
      target.before === null
        ? e.clusters.length
        : e.clusters.findIndex((k) => k.id === target.before);
    if (index < 0) throw new Error(`no cluster ${target.before}`);
    const { pos, rekey } = slot(e.clusters, index, "container");
    changes.push(...rekey);
    cluster = container({ kind: "cluster", parent: BOARD, pos });
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

/** The tree without some frames: the board a drag of them is hit against. */
export function without(tree: Tree, frames: ReadonlySet<string>): Tree {
  return { ...tree, frames: tree.frames.filter((f) => !frames.has(f.id)) };
}

/**
 * Where a drop at `point` goes. Over a cluster (or just outside it), beside
 * its frame nearest the pointer, by the edge the pointer is nearest: left or
 * right, before or after it in its row; top or bottom, a new row above or
 * below. Elsewhere, or with `newCluster`, a cluster of its own there
 * (`slotAt`).
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
  const edges: Array<[Side, number]> = [
    ["left", u],
    ["right", 1 - u],
    ["above", v],
    ["below", 1 - v],
  ];
  const [side] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { anchor: f.id, side };
}

/**
 * A new cluster where `point` is, reading the board as clusters do: in the
 * row of clusters the point is at or below, before the first whose middle
 * it is left of; past a row's last, before the next row's first; under
 * the last row, at the end.
 */
export function slotAt(layout: Layout, point: Point): NewCluster {
  const tops = [...new Set(layout.clusters.map((k) => k.box.y))];
  const line = tops.filter((y) => y <= point.y).at(-1) ?? tops[0];
  const last = layout.clusters.filter((k) => k.box.y === tops.at(-1));
  if (point.y > Math.max(...last.map((k) => k.box.y + k.box.h))) return { before: null };
  const index = layout.clusters.findIndex(
    ({ box }) => box.y > line! || (box.y === line && point.x < box.x + box.w / 2),
  );
  return { before: index < 0 ? null : layout.clusters[index]!.id };
}

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
