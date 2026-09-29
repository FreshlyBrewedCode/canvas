import { describe, expect, test } from "bun:test";

import { currentIn, fullscreenRow, fullscreenTransform, stillFullscreen } from "./fullscreen";
import { toViewport } from "./viewport";

// A row of three (the middle one a few px lower: still the row), a row under
// it, and a frame on its own far away.
const frames = [
  { id: "a", x: 0, y: 0, w: 400, h: 300 },
  { id: "b", x: 424, y: 6, w: 600, h: 300 },
  { id: "c", x: 1048, y: 0, w: 400, h: 300 },
  { id: "d", x: 0, y: 324, w: 400, h: 300 },
  { id: "e", x: 5000, y: 5000, w: 400, h: 300 },
];

describe("full screen", () => {
  test("the row is the frame's row, left to right, with its top", () => {
    expect(fullscreenRow(frames, "b")).toEqual({
      frames: frames.slice(0, 3),
      top: 0,
    });
    expect(fullscreenRow(frames, "d")?.frames.map((f) => f.id)).toEqual(["d"]);
    expect(fullscreenRow(frames, "e")?.frames.map((f) => f.id)).toEqual(["e"]);
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
    const row = fullscreenRow(frames, "a")!.frames;
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
});
