import { describe, expect, test } from "bun:test";

import { browse } from "./prompt-history";

describe("prompt history", () => {
  const history = ["first", "second", "third"];

  test("↑ on an empty draft shows the last prompt, then older ones", () => {
    expect(browse(history, null, "", "older")).toEqual({ at: 2, text: "third" });
    expect(browse(history, 2, "third", "older")).toEqual({ at: 1, text: "second" });
    expect(browse(history, 0, "first", "older")).toEqual({ at: 0, text: "first" });
  });

  test("↓ goes back to newer ones, then to an empty draft", () => {
    expect(browse(history, 1, "second", "newer")).toEqual({ at: 2, text: "third" });
    expect(browse(history, 2, "third", "newer")).toEqual({ at: null, text: "" });
  });

  test("never over a draft someone wrote", () => {
    expect(browse(history, null, "my own words", "older")).toBeNull();
    // It showed "second", then someone typed.
    expect(browse(history, 1, "second, edited", "older")).toBeNull();
    expect(browse(history, 1, "second, edited", "newer")).toBeNull();
    expect(browse(history, null, "", "newer")).toBeNull();
  });

  test("nothing to browse without prompts", () => {
    expect(browse([], null, "", "older")).toBeNull();
  });
});
