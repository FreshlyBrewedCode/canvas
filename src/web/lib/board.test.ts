import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { replaceText } from "./board";

describe("replaceText", () => {
  const cases: Array<[string, string]> = [
    ["hello world", "hello brave world"],
    ["# Plan\n1. a\n2. b\n", "# Plan\n1. a\n2. b\n3. c\n"],
    ["abc", ""],
    ["", "abc"],
    ["aaaa", "aa"],
  ];
  test.each(cases)("%j → %j", (before, after) => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, before);
    replaceText(text, after, "disk");
    expect(text.toString()).toBe(after);
  });

  test("only the changed span is replaced, so positions before it survive", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "keep this. change that.");
    const caret = Y.createRelativePositionFromTypeIndex(text, 4);
    replaceText(text, "keep this. changed it all.", "disk");
    expect(Y.createAbsolutePositionFromRelativePosition(caret, doc)?.index).toBe(4);
  });
});
