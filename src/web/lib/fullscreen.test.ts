import { describe, expect, test } from "bun:test";

import {
  currentIn,
  fullscreenRow,
  fullscreenTransform,
  edgeScroll,
  scrollsFurther,
  standIn,
  stillFullscreen,
} from "./fullscreen";
import { toViewport } from "./viewport";

// A row of three, a row under it, and a frame on its own far away.
const frames = [
  { id: "a", row: "r1", x: 0, y: 0, w: 400, h: 300 },
  { id: "b", row: "r1", x: 424, y: 0, w: 600, h: 300 },
  { id: "c", row: "r1", x: 1048, y: 0, w: 400, h: 300 },
  { id: "d", row: "r2", x: 0, y: 324, w: 400, h: 300 },
  { id: "e", row: "r3", x: 5000, y: 5000, w: 400, h: 300 },
];

describe("full screen", () => {
  test("the row is the tree's, by its id, left to right, with its top", () => {
    expect(fullscreenRow(frames, "r1")).toEqual({
      frames: frames.slice(0, 3),
      top: 0,
    });
    expect(fullscreenRow(frames, "r2")?.frames.map((f) => f.id)).toEqual(["d"]);
    // Reordered: still the row, in its new order.
    const moved = frames.map((f) => (f.id === "a" ? { ...f, x: 2000 } : f));
    expect(fullscreenRow(moved, "r1")?.frames.map((f) => f.id)).toEqual(["b", "c", "a"]);
    expect(fullscreenRow(frames, "gone")).toBeNull();
  });

  test("a frame is shown at 100%, its row's top at the top, centred", () => {
    const t = fullscreenTransform(frames[1]!, 0, 1400);
    expect(t.scale).toBe(1);
    expect(toViewport(t, { x: 424 + 300, y: 0 })).toEqual({ x: 700, y: 0 });
  });

  test("a frame wider than the screen starts at its left edge", () => {
    const t = fullscreenTransform(frames[1]!, 0, 500);
    expect(toViewport(t, { x: 424, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  test("the current frame is the one nearest the middle of the screen", () => {
    const row = fullscreenRow(frames, "r1")!.frames;
    expect(currentIn(row, fullscreenTransform(frames[2]!, 0, 1400), 1400)).toBe("c");
    // Panned a little right of a: still a; most of the way to b: b.
    const t = fullscreenTransform(frames[0]!, 0, 1400);
    expect(currentIn(row, { ...t, x: t.x - 100 }, 1400)).toBe("a");
    expect(currentIn(row, { ...t, x: t.x - 400 }, 1400)).toBe("b");
  });

  test("zooming or leaving the row's top ends it; panning along it doesn't", () => {
    const t = fullscreenTransform(frames[0]!, 0, 1400);
    expect(stillFullscreen({ ...t, x: t.x - 800 }, 0)).toBe(true);
    expect(stillFullscreen({ ...t, scale: 1.1 }, 0)).toBe(false);
    expect(stillFullscreen({ ...t, y: t.y - 40 }, 0)).toBe(false);
  });

  test("a frame gone hands over to the next of the row, else the one before", () => {
    const order = ["a", "b", "c"];
    expect(standIn(order, "b", new Set(["a", "c"]))).toBe("c");
    expect(standIn(order, "c", new Set(["a", "b"]))).toBe("b");
    expect(standIn(order, "a", new Set(["c"]))).toBe("c");
    expect(standIn(order, "a", new Set(["d"]))).toBeNull();
  });

  test("a drag near the board's side scrolls, faster the deeper, most at and past it", () => {
    expect(edgeScroll(700, 0, 1400)).toBe(0);
    expect(edgeScroll(40, 0, 1400)).toBe(-12);
    expect(edgeScroll(0, 0, 1400)).toBe(-24);
    expect(edgeScroll(-300, 0, 1400)).toBe(-24);
    expect(edgeScroll(1380, 0, 1400)).toBe(18);
    expect(edgeScroll(1500, 0, 1400)).toBe(24);
  });

  test("scrolling stops once the frame is past the row's end", () => {
    const row = fullscreenRow(frames, "r1")!.frames;
    const a = frames[0]!;
    expect(scrollsFurther(row, { ...a, x: 1000 }, 10)).toBe(true);
    expect(scrollsFurther(row, { ...a, x: 1448 }, 10)).toBe(false);
    expect(scrollsFurther(row, { ...a, x: 100 }, -10)).toBe(true);
    expect(scrollsFurther(row, { ...a, x: 24 }, -10)).toBe(false);
    expect(scrollsFurther(row, a, 0)).toBe(false);
    expect(scrollsFurther([a], a, 10)).toBe(false);
  });
});
