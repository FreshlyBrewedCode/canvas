import { describe, expect, test } from "bun:test";

import { fitRects, inView, toBoard, zoomAbout } from "./viewport";

describe("viewport", () => {
  test("zooming keeps the point under the pointer fixed", () => {
    const before = { scale: 1, x: 100, y: 50 };
    const after = zoomAbout(before, 2, 300, 200);
    expect(toBoard(after, { x: 300, y: 200 })).toEqual(toBoard(before, { x: 300, y: 200 }));
  });

  test("fitting frames centres them without magnifying", () => {
    const t = fitRects([{ x: 0, y: 0, w: 200, h: 100 }], 1000, 800)!;
    expect(t.scale).toBe(1);
    expect(toBoard(t, { x: 500, y: 400 })).toEqual({ x: 100, y: 50 });
  });

  test("a frame is in view when all of it is, at a scale to read it", () => {
    const frame = { x: 100, y: 100, w: 400, h: 300 };
    expect(inView({ scale: 1, x: 0, y: 0 }, frame, 1000, 800)).toBe(true);
    expect(inView({ scale: 1, x: -200, y: 0 }, frame, 1000, 800)).toBe(false);
    expect(inView({ scale: 0.3, x: 0, y: 0 }, frame, 1000, 800)).toBe(false);
  });
});
