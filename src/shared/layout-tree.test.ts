import { describe, expect, test } from "bun:test";
import { generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";

import {
  alongAt,
  applyChanges,
  BOARD,
  CLUSTER_GAP,
  CLUSTER_REACH,
  DEFAULT_W,
  dropAt,
  GAP,
  insert,
  migrate,
  MIN_H,
  MIN_W,
  move,
  moveCluster,
  prune,
  repair,
  resize,
  resolve,
  slotAt,
  without as lifted,
  type Change,
  type Container,
  type Leaf,
  type Tree,
} from "./layout";

/** Ids n1, n2, … for new containers. */
const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

type Spec = ReadonlyArray<{
  name?: string;
  rows: ReadonlyArray<{ h: number; frames: ReadonlyArray<readonly [string, number]> }>;
}>;

/** A tree from clusters of rows of frames (id, width), each frame its own column: k1, k1r1, k1r1c1… */
function build(spec: Spec): Tree {
  const containers: Container[] = [];
  const frames: Leaf[] = [];
  const keys = (n: number) => generateNKeysBetween(null, null, n);
  const clusterKeys = keys(spec.length);
  spec.forEach((k, i) => {
    const cluster = `k${i + 1}`;
    containers.push({
      id: cluster,
      kind: "cluster",
      parent: BOARD,
      pos: clusterKeys[i]!,
      ...(k.name && { name: k.name }),
    });
    const rowKeys = keys(k.rows.length);
    k.rows.forEach((r, j) => {
      const row = `${cluster}r${j + 1}`;
      containers.push({ id: row, kind: "row", parent: cluster, pos: rowKeys[j]!, h: r.h });
      const columnKeys = keys(r.frames.length);
      r.frames.forEach(([id, w], n) => {
        const column = `${row}c${n + 1}`;
        containers.push({ id: column, kind: "column", parent: row, pos: columnKeys[n]!, w });
        frames.push({ id, parent: column, pos: "a0", cluster });
      });
    });
  });
  return { containers, frames };
}

const rect = (tree: Tree, id: string, context = {}) => resolve(tree, context).frames.get(id)!.frame;
const at = (tree: Tree, id: string) => {
  const { x, y, w, h } = rect(tree, id);
  return { x, y, w, h };
};
/** Each cluster's rows, each row's frames, by id. */
const shape = (tree: Tree) =>
  resolve(tree).clusters.map((k) =>
    k.rows.map((r) => r.columns.flatMap((c) => c.frames.map((f) => f.id))),
  );
const without = (tree: Tree, ...ids: string[]): Tree => ({
  containers: tree.containers.filter((c) => !ids.includes(c.id)),
  frames: tree.frames.filter((f) => !ids.includes(f.id)),
});

describe("resolve", () => {
  test("rows stack in a cluster and columns sit side by side, a gap between", () => {
    const tree = build([
      {
        rows: [
          {
            h: 100,
            frames: [
              ["a", 300],
              ["b", 200],
            ],
          },
          { h: 50, frames: [["c", 400]] },
        ],
      },
    ]);
    expect(at(tree, "a")).toEqual({ x: 0, y: 0, w: 300, h: 100 });
    expect(at(tree, "b")).toEqual({ x: 300 + GAP, y: 0, w: 200, h: 100 });
    expect(at(tree, "c")).toEqual({ x: 0, y: 100 + GAP, w: 400, h: 50 });
    expect(resolve(tree).clusters[0]!.box).toEqual({ x: 0, y: 0, w: 500 + GAP, h: 150 + GAP });
  });

  test("clusters go left to right, top-aligned, and wrap into another row of clusters", () => {
    const tree = build([
      { rows: [{ h: 300, frames: [["a", 2000]] }] },
      { rows: [{ h: 500, frames: [["b", 2000]] }] },
      { rows: [{ h: 100, frames: [["c", 2000]] }] },
    ]);
    expect(at(tree, "a")).toMatchObject({ x: 0, y: 0 });
    expect(at(tree, "b")).toMatchObject({ x: 2000 + CLUSTER_GAP, y: 0 });
    expect(at(tree, "c")).toMatchObject({ x: 0, y: 500 + CLUSTER_GAP });
  });

  test("siblings go by pos, then by id when two have the same", () => {
    const tree = build([
      {
        rows: [
          {
            h: 100,
            frames: [
              ["a", 100],
              ["b", 100],
              ["c", 100],
            ],
          },
        ],
      },
    ]);
    const same = {
      ...tree,
      containers: tree.containers.map((c) => (c.id === "k1r1c3" ? { ...c, pos: "a0" } : c)),
    };
    expect(shape(same)).toEqual([[["a", "c", "b"]]]);
  });

  test("frames of a column share its height by weight", () => {
    const tree: Tree = {
      containers: [
        { id: "k", kind: "cluster", parent: BOARD, pos: "a0" },
        { id: "r", kind: "row", parent: "k", pos: "a0", h: 400 + GAP },
        { id: "c", kind: "column", parent: "r", pos: "a0", w: 300 },
      ],
      frames: [
        { id: "top", parent: "c", pos: "a0", weight: 1 },
        { id: "bottom", parent: "c", pos: "a1", weight: 3 },
      ],
    };
    expect(at(tree, "top")).toEqual({ x: 0, y: 0, w: 300, h: 100 });
    expect(at(tree, "bottom")).toEqual({ x: 0, y: 100 + GAP, w: 300, h: 300 });
  });

  test("full screen: its row as tall as the screen, frames with a height keep it", () => {
    const tree = build([
      {
        rows: [
          {
            h: 100,
            frames: [
              ["a", 300],
              ["term", 300],
            ],
          },
          { h: 100, frames: [["below", 300]] },
        ],
      },
    ]);
    const withHeight = {
      ...tree,
      frames: tree.frames.map((f) => (f.id === "term" ? { ...f, height: 380 } : f)),
    };
    const context = { fullscreen: { row: "k1r1", height: 900 } };
    expect(at(withHeight, "term").h).toBe(100);
    expect(rect(withHeight, "a", context)).toMatchObject({ y: 0, h: 900 });
    expect(rect(withHeight, "term", context)).toMatchObject({ y: 0, h: 380 });
    expect(rect(withHeight, "below", context)).toMatchObject({ h: 100 });
  });

  test("empty containers are left out and reported", () => {
    const tree = without(
      build([
        {
          rows: [
            { h: 100, frames: [["a", 100]] },
            { h: 100, frames: [["b", 100]] },
          ],
        },
        { rows: [{ h: 100, frames: [["c", 100]] }] },
      ]),
      "b",
      "c",
    );
    const layout = resolve(tree);
    expect(shape(tree)).toEqual([[["a"]]]);
    expect([...layout.empty].sort()).toEqual(["k1r2", "k1r2c1", "k2", "k2r1", "k2r1c1"]);
    expect(at(tree, "a")).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    const pruned = applyChanges(tree, prune(tree));
    expect(pruned.containers.map((c) => c.id).sort()).toEqual(["k1", "k1r1", "k1r1c1"]);
  });
});

describe("repair", () => {
  const tree = build([
    {
      rows: [
        {
          h: 100,
          frames: [
            ["a", 100],
            ["b", 200],
          ],
        },
        { h: 50, frames: [["c", 300]] },
      ],
    },
    { rows: [{ h: 100, frames: [["d", 100]] }] },
  ]);

  /** What `resolve` shows stays, in real containers. */
  const repairs = (broken: Tree) => {
    const before = resolve(broken);
    const fixed = applyChanges(broken, repair(broken, counter()));
    const after = resolve(fixed);
    expect(after.orphans).toEqual([]);
    for (const [id, { frame }] of before.frames) expect(after.frames.get(id)!.frame).toEqual(frame);
    expect(repair(fixed, counter())).toEqual([]);
    return fixed;
  };

  test("a frame whose column is gone: a new row at the end of its cluster", () => {
    const broken = without(tree, "k1r1c2");
    expect(shape(broken)).toEqual([[["a"], ["c"], ["b"]], [["d"]]]);
    expect(resolve(broken).orphans).toEqual(["b"]);
    expect(at(broken, "b")).toMatchObject({ y: 100 + GAP + 50 + GAP, w: DEFAULT_W });
    repairs(broken);
  });

  test("a column whose row is gone: a new row at the end of its frames' cluster", () => {
    const broken = without(tree, "k1r2");
    expect(shape(broken)).toEqual([[["a", "b"], ["c"]], [["d"]]]);
    expect(at(broken, "c").w).toBe(300);
    repairs(broken);
  });

  test("a row whose cluster is gone: a cluster of its own at the end, its frames with it", () => {
    const broken = without(tree, "k1");
    expect(shape(broken)).toEqual([[["d"]], [["a", "b"]], [["c"]]]);
    const fixed = repairs(broken);
    const clusterOf = (id: string) => fixed.frames.find((f) => f.id === id)!.cluster;
    expect(clusterOf("a")).toBe(clusterOf("b"));
    expect(resolve(fixed).frames.get("a")!.cluster.id).toBe(clusterOf("a")!);
  });

  test("a frame without a place (from before the tree): a cluster of its own at the end", () => {
    const broken = { ...tree, frames: [...tree.frames, { id: "new" }] };
    expect(shape(broken)).toEqual([[["a", "b"], ["c"]], [["d"]], [["new"]]]);
    repairs(broken);
  });
});

describe("insert", () => {
  const tree = build([
    {
      rows: [
        {
          h: 100,
          frames: [
            ["a", 100],
            ["b", 200],
          ],
        },
        { h: 50, frames: [["c", 300]] },
      ],
    },
    { rows: [{ h: 100, frames: [["d", 100]] }] },
  ]);
  const size = { w: 150, h: 70 };
  const put = (target: Parameters<typeof insert>[2]) =>
    applyChanges(tree, insert(tree, "new", target, size, counter()));

  test("right or left of a frame: a column of its row, as tall as the row", () => {
    let after = put({ anchor: "a", side: "right" });
    expect(shape(after)[0]![0]).toEqual(["a", "new", "b"]);
    expect(at(after, "new")).toEqual({ x: 100 + GAP, y: 0, w: 150, h: 100 });
    expect(at(after, "b").x).toBe(100 + GAP + 150 + GAP);
    after = put({ anchor: "a", side: "left" });
    expect(shape(after)[0]![0]).toEqual(["new", "a", "b"]);
  });

  test("above or below a frame: a new row of the cluster, `size` tall", () => {
    let after = put({ anchor: "a", side: "below" });
    expect(shape(after)[0]).toEqual([["a", "b"], ["new"], ["c"]]);
    expect(at(after, "new")).toEqual({ x: 0, y: 100 + GAP, w: 150, h: 70 });
    after = put({ anchor: "c", side: "above" });
    expect(shape(after)[0]).toEqual([["a", "b"], ["new"], ["c"]]);
  });

  test("a new cluster before another, or at the end", () => {
    expect(shape(put({ before: "k2" }))).toEqual([[["a", "b"], ["c"]], [["new"]], [["d"]]]);
    expect(shape(put({ before: null }))).toEqual([[["a", "b"], ["c"]], [["d"]], [["new"]]]);
  });

  test("the frame knows its cluster, for when its row goes", () => {
    const changes = insert(tree, "new", { anchor: "d", side: "right" }, size, counter());
    expect(changes.at(-1)).toMatchObject({ kind: "frame", id: "new", set: { cluster: "k2" } });
  });

  test("between two siblings with the same key: they get new ones", () => {
    const same = {
      ...tree,
      containers: tree.containers.map((c) => (c.id === "k1r1c2" ? { ...c, pos: "a0" } : c)),
    };
    const after = applyChanges(same, insert(same, "new", { anchor: "a", side: "right" }, size));
    expect(shape(after)[0]![0]).toEqual(["a", "new", "b"]);
  });
});

describe("move", () => {
  const tree = build([
    {
      rows: [
        {
          h: 100,
          frames: [
            ["a", 100],
            ["b", 200],
            ["c", 300],
          ],
        },
        { h: 50, frames: [["d", 400]] },
      ],
    },
    { rows: [{ h: 80, frames: [["e", 100]] }] },
  ]);
  const moved = (frame: string, target: Parameters<typeof move>[2]) =>
    applyChanges(tree, move(tree, frame, target, counter()));

  test("along its row: the row reorders, the frame keeps its width", () => {
    const after = moved("c", { anchor: "a", side: "left" });
    expect(shape(after)[0]![0]).toEqual(["c", "a", "b"]);
    expect(at(after, "c")).toEqual({ x: 0, y: 0, w: 300, h: 100 });
  });

  test("into another row: its width, that row's height; the old row closes up", () => {
    const after = moved("b", { anchor: "d", side: "right" });
    expect(shape(after)[0]).toEqual([
      ["a", "c"],
      ["d", "b"],
    ]);
    expect(at(after, "b")).toMatchObject({ w: 200, h: 50 });
    expect(at(after, "c").x).toBe(100 + GAP);
  });

  test("to a new row: it keeps its size; a row left empty goes", () => {
    const after = moved("d", { anchor: "e", side: "below" });
    expect(shape(after)).toEqual([[["a", "b", "c"]], [["e"], ["d"]]]);
    expect(at(after, "d")).toMatchObject({ w: 400, h: 50 });
    expect([...resolve(after).empty].sort()).toEqual(["k1r2", "k1r2c1"]);
  });

  test("to a new cluster", () => {
    expect(shape(moved("a", { before: "k1" }))).toEqual([[["a"]], [["b", "c"], ["d"]], [["e"]]]);
  });

  test("not next to itself", () => {
    expect(() => move(tree, "a", { anchor: "a", side: "right" })).toThrow();
  });
});

describe("moveCluster", () => {
  const tree = build([
    { rows: [{ h: 100, frames: [["a", 100]] }] },
    { rows: [{ h: 100, frames: [["b", 100]] }] },
    { rows: [{ h: 100, frames: [["c", 100]] }] },
  ]);
  const order = (changes: Change[]) =>
    resolve(applyChanges(tree, changes)).clusters.map((k) => k.id);

  test("before another, or to the end", () => {
    expect(order(moveCluster(tree, "k3", "k1"))).toEqual(["k3", "k1", "k2"]);
    expect(order(moveCluster(tree, "k1", null))).toEqual(["k2", "k3", "k1"]);
    expect(moveCluster(tree, "k2", "k2")).toEqual([]);
  });
});

describe("resize", () => {
  test("a column's width, a row's height, a frame's own height, no smaller than the least", () => {
    expect(resize({ column: "c", w: 500.4 })).toEqual([
      { kind: "container", id: "c", set: { w: 500 } },
    ]);
    expect(resize({ column: "c", w: 10 })[0]).toMatchObject({ set: { w: MIN_W } });
    expect(resize({ row: "r", h: 10 })[0]).toMatchObject({ set: { h: MIN_H } });
    expect(resize({ frame: "t", height: 450 })).toEqual([
      { kind: "frame", id: "t", set: { height: 450 } },
    ]);
  });

  test("a wider column moves the rest of its row along", () => {
    const tree = build([
      {
        rows: [
          {
            h: 100,
            frames: [
              ["a", 300],
              ["b", 300],
            ],
          },
        ],
      },
    ]);
    const after = applyChanges(tree, resize({ column: "k1r1c1", w: 400 }));
    expect(at(after, "b").x).toBe(400 + GAP);
  });
});

// Two peers, each with its own doc, as the board is: `layout` and `frames`, a Y.Map per node.
class Peer {
  readonly doc = new Y.Doc();
  constructor(tree?: Tree) {
    if (tree) this.write(changesFor(tree));
  }
  get tree(): Tree {
    const containers: Container[] = [];
    this.doc
      .getMap<Y.Map<unknown>>("layout")
      .forEach((map, id) => containers.push({ ...(map.toJSON() as Container), id }));
    const frames: Leaf[] = [];
    this.doc
      .getMap<Y.Map<unknown>>("frames")
      .forEach((map, id) => frames.push({ ...(map.toJSON() as Leaf), id }));
    return { containers, frames };
  }
  write(changes: ReadonlyArray<Change>) {
    this.doc.transact(() => {
      for (const change of changes) {
        const maps = this.doc.getMap<Y.Map<unknown>>(change.kind === "frame" ? "frames" : "layout");
        if (change.kind === "remove") {
          maps.delete(change.id);
          continue;
        }
        let map = maps.get(change.id);
        if (!map) maps.set(change.id, (map = new Y.Map()));
        for (const [key, value] of Object.entries(change.set)) map.set(key, value);
        if (change.kind === "frame") for (const key of change.unset ?? []) map.delete(key);
      }
    });
  }
}
const changesFor = (tree: Tree): Change[] => [
  ...tree.containers.map(({ id, ...set }): Change => ({ kind: "container", id, set })),
  ...tree.frames.map(({ id, ...set }): Change => ({ kind: "frame", id, set })),
];
const sync = (...peers: Peer[]) => {
  for (const from of peers)
    for (const to of peers) if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc));
};
/** Every frame once, and both peers showing the same. */
const agree = (a: Peer, b: Peer) => {
  const [la, lb] = [resolve(a.tree), resolve(b.tree)];
  expect(shape(a.tree)).toEqual(shape(b.tree));
  expect([...la.frames.values()].map((p) => p.frame)).toEqual(
    [...lb.frames.values()].map((p) => p.frame),
  );
  const ids = shape(a.tree).flat(2);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(a.tree.frames.length);
};

describe("concurrency", () => {
  const tree = build([
    {
      rows: [
        {
          h: 100,
          frames: [
            ["a", 100],
            ["b", 100],
          ],
        },
        { h: 100, frames: [["g", 100]] },
      ],
    },
    {
      rows: [
        {
          h: 100,
          frames: [
            ["f", 100],
            ["h", 100],
          ],
        },
      ],
    },
  ]);

  test("two peers move one frame: it ends up in one place, the same for both", () => {
    const [host, guest] = [new Peer(tree), new Peer()];
    sync(host, guest);
    host.write(move(host.tree, "a", { anchor: "f", side: "right" }));
    guest.write(move(guest.tree, "a", { anchor: "g", side: "below" }));
    sync(host, guest);
    agree(host, guest);
    const places = shape(host.tree);
    expect(
      JSON.stringify(places) === JSON.stringify([[["b"], ["g"]], [["f", "a", "h"]]]) ||
        JSON.stringify(places) === JSON.stringify([[["b"], ["g"], ["a"]], [["f", "h"]]]),
    ).toBe(true);
  });

  test("two peers put frames in the same slot: both are there, in the same order for both", () => {
    const [host, guest] = [new Peer(tree), new Peer()];
    sync(host, guest);
    const size = { w: 100, h: 100 };
    host.write([
      ...insert(host.tree, "x", { anchor: "a", side: "right" }, size),
      { kind: "frame", id: "x", set: {} },
    ]);
    guest.write(insert(guest.tree, "y", { anchor: "a", side: "right" }, size));
    sync(host, guest);
    agree(host, guest);
    expect(shape(host.tree)[0]![0]!.slice(0, 1)).toEqual(["a"]);
    expect([...shape(host.tree)[0]![0]!].sort()).toEqual(["a", "b", "x", "y"]);
  });

  test("a row removed while a frame moves into it: the frame stays in the cluster", () => {
    const [host, guest] = [new Peer(tree), new Peer()];
    sync(host, guest);
    // The host moves g out of its row, then removes the row, empty now.
    host.write(move(host.tree, "g", { anchor: "b", side: "right" }));
    host.write(prune(host.tree));
    expect(host.tree.containers.some((c) => c.id === "k1r2")).toBe(false);
    // Meanwhile the guest moves f into that row, beside g.
    guest.write(move(guest.tree, "f", { anchor: "g", side: "right" }));
    sync(host, guest);
    agree(host, guest);
    expect(shape(host.tree)).toEqual([[["a", "b", "g"], ["f"]], [["h"]]]);
    expect(resolve(host.tree).orphans).toEqual(["f"]);
    // The host makes it real; nothing lost, nothing twice.
    host.write(repair(host.tree));
    host.write(prune(host.tree));
    sync(host, guest);
    agree(host, guest);
    expect(resolve(guest.tree).orphans).toEqual([]);
    expect(shape(guest.tree)).toEqual([[["a", "b", "g"], ["f"]], [["h"]]]);
  });
});

describe("migrate", () => {
  const r = (id: string, x: number, y: number, w = 600, h = 400) => ({ id, x, y, w, h });
  // A board as it was: a row of three and one under it, a terminal alone, and a frame far off.
  const rects = [
    r("a", 0, 0),
    r("b", 624, 0, 500, 380),
    r("c", 1148, 0),
    r("d", 0, 424, 700, 300),
    r("far", 4000, -200),
    { ...r("term", 0, 2000, 640, 400), keepHeight: true },
  ];

  test("clusters and rows read off positions; each frame a column as wide as it was", () => {
    const peer = new Peer({ containers: [], frames: rects.map(({ id }) => ({ id })) });
    peer.write(migrate(peer.tree, rects, counter()));
    const tree = peer.tree;
    expect(shape(tree)).toEqual([[["far"]], [["a", "b", "c"], ["d"]], [["term"]]]);
    expect(at(tree, "b")).toMatchObject({ w: 500, h: 400 });
    expect(at(tree, "d")).toMatchObject({ w: 700, h: 300 });
    const stored = tree.frames.find((f) => f.id === "term") as unknown as Record<string, unknown>;
    expect(stored).toMatchObject({ height: 400 });
    expect(["x", "y", "w", "h"].filter((key) => key in stored)).toEqual([]);
    expect(resolve(tree).orphans).toEqual([]);
  });

  test("after the clusters there are", () => {
    const tree = build([{ rows: [{ h: 100, frames: [["old", 100]] }] }]);
    const after = applyChanges(tree, migrate(tree, [r("x", 0, 0)], counter()));
    expect(shape(after)).toEqual([[["old"]], [["x"]]]);
  });
});

describe("drop zones", () => {
  // Two clusters side by side: a row a b over c; d. A third, wrapped under them.
  const tree = build([
    {
      rows: [
        {
          h: 200,
          frames: [
            ["a", 400],
            ["b", 400],
          ],
        },
        { h: 200, frames: [["c", 400]] },
      ],
    },
    { rows: [{ h: 200, frames: [["d", 400]] }] },
    { rows: [{ h: 200, frames: [["e", 4000]] }] },
  ]);
  const layout = resolve(tree);
  const box = (id: string) => layout.frames.get(id)!.frame;
  const inside = (id: string, u: number, v: number) => {
    const f = box(id);
    return { x: f.x + f.w * u, y: f.y + f.h * v };
  };

  test("over a frame, the edge the pointer is nearest", () => {
    expect(dropAt(layout, inside("a", 0.1, 0.5))).toEqual({ anchor: "a", side: "left" });
    expect(dropAt(layout, inside("a", 0.9, 0.4))).toEqual({ anchor: "a", side: "right" });
    expect(dropAt(layout, inside("a", 0.5, 0.1))).toEqual({ anchor: "a", side: "above" });
    expect(dropAt(layout, inside("c", 0.4, 0.95))).toEqual({ anchor: "c", side: "below" });
  });

  test("in a gap of the cluster, or just outside it: beside the nearest frame", () => {
    const a = box("a");
    expect(dropAt(layout, { x: a.x + a.w + GAP / 2 - 1, y: a.y + 100 })).toEqual({
      anchor: "a",
      side: "right",
    });
    // Just right of c, under b: the end of c's row.
    expect(dropAt(layout, { x: box("c").x + 430, y: box("c").y + 100 })).toEqual({
      anchor: "c",
      side: "right",
    });
    const d = box("d");
    expect(dropAt(layout, { x: d.x + d.w + CLUSTER_REACH - 1, y: d.y + 100 })).toEqual({
      anchor: "d",
      side: "right",
    });
  });

  test("between clusters or on empty board: a cluster of its own there", () => {
    const k1 = layout.clusters[0]!.box;
    const k2 = layout.clusters[1]!.box;
    expect(dropAt(layout, { x: (k1.x + k1.w + k2.x) / 2, y: 50 })).toEqual({ before: "k2" });
    expect(dropAt(layout, { x: k2.x + k2.w + 500, y: 50 })).toEqual({ before: "k3" });
    expect(dropAt(layout, { x: -500, y: 50 })).toEqual({ before: "k1" });
    expect(dropAt(layout, { x: 0, y: 99999 })).toEqual({ before: null });
  });

  test("a new cluster, even over frames, when asked", () => {
    expect(dropAt(layout, inside("b", 0.2, 0.5), { newCluster: true })).toEqual({ before: "k2" });
    expect(slotAt(layout, inside("b", 0.8, 0.5))).toEqual({ before: "k2" });
  });

  test("hit against the board without the dragged frame: what is under the pointer holds still", () => {
    const rest = resolve(lifted(tree, new Set(["a"])));
    // b takes a's place once a is lifted: the pointer at a's left edge is b's.
    expect(dropAt(rest, inside("a", 0.1, 0.5))).toEqual({ anchor: "b", side: "left" });
  });

  test("along a row: before or after the frame the pointer is over, by its half", () => {
    const a = box("a");
    const b = box("b");
    expect(alongAt(layout, "k1r1", a.x + 100)).toEqual({ anchor: "a", side: "left" });
    expect(alongAt(layout, "k1r1", b.x + 300)).toEqual({ anchor: "b", side: "right" });
    expect(alongAt(layout, "k1r1", b.x + 9000)).toEqual({ anchor: "b", side: "right" });
    expect(alongAt(resolve(lifted(tree, new Set(["c"]))), "k1r2", 0)).toBeNull();
  });
});
