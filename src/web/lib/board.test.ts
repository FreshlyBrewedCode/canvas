import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { addFrame, framesOf, readFrame } from "./board";

describe("readFrame", () => {
  test("reads a markdown frame from an older board as a file frame", () => {
    const doc = new Y.Doc();
    const id = addFrame(doc, {
      type: "markdown",
      path: "docs/plan.md",
      title: "plan",
      x: 0,
      y: 0,
      w: 480,
      h: 560,
    } as never);
    expect(readFrame(framesOf(doc).get(id)!, id)).toMatchObject({
      id,
      type: "file",
      path: "docs/plan.md",
    });
  });
});
