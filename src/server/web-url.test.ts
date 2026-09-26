import { expect, test } from "bun:test";
import { DEV_WEB_URL, NEXT_WEB_URL, STABLE_WEB_URL, defaultWebUrl } from "./web-url";

test("a checkout opens the dev server", () => {
  expect(defaultWebUrl(undefined)).toBe(DEV_WEB_URL);
});

test("a stable release opens the stable UI", () => {
  expect(defaultWebUrl("1.2.3")).toBe(STABLE_WEB_URL);
});

test("a pre-release opens the next UI", () => {
  expect(defaultWebUrl("1.3.0-next.4")).toBe(NEXT_WEB_URL);
});
