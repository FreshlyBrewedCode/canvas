import { describe, expect, test } from "bun:test";

import { bridgedLink, withLinkBridge } from "./link-bridge";

describe("withLinkBridge", () => {
  test("goes into the head, never before the doctype", () => {
    const page = withLinkBridge("<!doctype html><html><head><title>x</title></head></html>", "T");
    expect(page.startsWith("<!doctype html><html><head><script>")).toBe(true);
    expect(withLinkBridge("<!DOCTYPE html>\n<p>hi</p>", "T")).toMatch(/^<!DOCTYPE html><script>/);
    expect(withLinkBridge('<html lang="en"><body><header>', "T")).toMatch(
      /^<html lang="en"><script>/,
    );
    expect(withLinkBridge("<p>hi</p>", "T")).toMatch(/^<script>.*<\/script><p>hi<\/p>$/);
  });

  test("only posts with the page's token count", () => {
    expect(bridgedLink({ canvasLink: "a.html", token: "T" }, "T")).toBe("a.html");
    expect(bridgedLink({ canvasLink: "a.html", token: "guess" }, "T")).toBeNull();
    expect(bridgedLink({ canvasLink: "a.html" }, "T")).toBeNull();
    expect(bridgedLink("a.html", "T")).toBeNull();
  });
});
