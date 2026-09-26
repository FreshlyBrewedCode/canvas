import { expect, test } from "bun:test";
import { browserTarget, typedUrl } from "./browser-url";

test("loopback URLs point at the viewer's own machine", () => {
  for (const url of [
    "http://localhost:5173/",
    "http://LOCALHOST:3000",
    "http://app.localhost:8080/x",
    "http://127.0.0.1:4418",
    "http://127.1/",
    "http://2130706433/",
    "http://0.0.0.0:8000",
    "http://[::1]:5173",
    "http://[::]:5173",
    "http://[::ffff:127.0.0.1]/",
  ])
    expect(browserTarget(url)).toEqual({ kind: "loopback", host: new URL(url).host });
});

test("other http(s) URLs are the web", () => {
  for (const url of [
    "https://example.com",
    "http://192.168.1.20:5173",
    "https://localhost.example.com",
    "http://128.0.0.1/",
  ])
    expect(browserTarget(url)).toEqual({ kind: "web" });
});

test("only http(s) URLs load", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://ui.canvas.frebreco.de/1",
    "not a url",
    "",
  ])
    expect(browserTarget(url).kind).toBe("invalid");
});

test("a typed URL without a scheme gets https, or http for loopback", () => {
  expect(typedUrl("example.com")).toBe("https://example.com");
  expect(typedUrl("  localhost:5173 ")).toBe("http://localhost:5173");
  expect(typedUrl("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
  expect(typedUrl("http://example.com")).toBe("http://example.com");
  expect(typedUrl("https://localhost:5173")).toBe("https://localhost:5173");
});
