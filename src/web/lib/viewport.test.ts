import { describe, expect, test } from "bun:test";

import { fitRects, toBoard, zoomAbout } from "./viewport";

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
});
