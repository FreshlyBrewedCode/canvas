import { describe, expect, test } from "bun:test";

import { edgeMarker, fitRects, inView, toBoard, toViewport, viewRect, zoomAbout } from "./viewport";

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

  test("the view is the board rectangle the viewport shows", () => {
    const t = { scale: 2, x: -200, y: 100 };
    const view = viewRect(t, 1000, 800);
    expect(view).toEqual({ x: 100, y: -50, w: 500, h: 400 });
    expect(toViewport(t, { x: view.x, y: view.y })).toEqual({ x: 0, y: 0 });
    expect(toBoard(t, toViewport(t, { x: 7, y: 9 }))).toEqual({ x: 7, y: 9 });
  });

  describe("edge markers", () => {
    const inset = { top: 60, right: 20, bottom: 20, left: 20 };

    test("none for a point in view, margins included", () => {
      expect(edgeMarker({ x: 500, y: 400 }, 1000, 800, inset)).toBeNull();
      expect(edgeMarker({ x: 5, y: 5 }, 1000, 800, inset)).toBeNull();
    });

    test("a point off to one side lands on that edge, pointing there", () => {
      expect(edgeMarker({ x: 3000, y: 400 }, 1000, 800, inset)).toEqual({
        x: 980,
        y: 400,
        angle: Math.PI / 2,
      });
      expect(edgeMarker({ x: 500, y: -1000 }, 1000, 800, inset)).toEqual({
        x: 500,
        y: 60,
        angle: 0,
      });
    });

    test("a point off a corner lands on the nearer edge, along the line to it", () => {
      // 1500 right and 1000 down of the centre (500, 400): the right edge (x 980) comes first.
      const marker = edgeMarker({ x: 2000, y: 1400 }, 1000, 800, inset)!;
      expect(marker.x).toBe(980);
      expect(marker.y).toBeCloseTo(400 + (480 * 1000) / 1500);
      expect(marker.angle).toBeCloseTo(Math.atan2(1500, -1000));
    });
  });
});
