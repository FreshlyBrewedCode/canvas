import { describe, expect, test } from "bun:test";

import { linesOf, quoteOf, relocate } from "./comments";

describe("linesOf", () => {
  test("a final newline ends the last line", () => {
    expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    expect(linesOf("a\nb")).toEqual(["a", "b"]);
    expect(linesOf("")).toEqual([""]);
  });
});

describe("quoteOf", () => {
  test("the lines of a range", () => {
    expect(quoteOf("a\nb\nc\n", 2, 3)).toBe("b\nc");
    expect(quoteOf("a\nb\nc\n", 1, 1)).toBe("a");
  });

  test("null for lines the file hasn't got", () => {
    expect(quoteOf("a\nb\n", 2, 3)).toBeNull();
    expect(quoteOf("a\nb\n", 0, 1)).toBeNull();
    expect(quoteOf("a\nb\n", 2, 1)).toBeNull();
  });
});

describe("relocate", () => {
  const text = "one\ntwo\nthree\nfour\n";

  test("stays where the lines still read the same", () => {
    expect(relocate(text, "two\nthree", 2)).toEqual({ start: 2, end: 3 });
  });

  test("follows lines that moved", () => {
    expect(relocate(`zero\n${text}`, "two\nthree", 2)).toEqual({ start: 3, end: 4 });
    expect(relocate("three\nfour\n", "three", 3)).toEqual({ start: 1, end: 1 });
  });

  test("picks the nearest copy", () => {
    const twice = "x\ny\nx\ny\n\n\n\nx\ny\n";
    expect(relocate(twice, "x\ny", 7)).toEqual({ start: 8, end: 9 });
    expect(relocate(twice, "x\ny", 4)).toEqual({ start: 3, end: 4 });
  });

  test("outdated once the lines are gone", () => {
    expect(relocate(text, "two\n3", 2)).toBeNull();
    expect(relocate("", "two", 2)).toBeNull();
  });

  test("blank lines are never looked for elsewhere", () => {
    expect(relocate("a\n\nb\n", "", 2)).toEqual({ start: 2, end: 2 });
    expect(relocate("a\nb\n\n", "", 2)).toBeNull();
  });
});
