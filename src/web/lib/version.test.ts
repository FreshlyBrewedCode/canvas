import { describe, expect, test } from "bun:test";

import { compareVersions, versionSkew } from "./version";

describe("compareVersions", () => {
  test("orders releases and pre-releases as semver does", () => {
    const ordered = [
      "0.2.0-next.1",
      "0.2.0",
      "0.3.0-next.1",
      "0.3.0-next.2",
      "0.3.0-next.10",
      "0.3.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions("0.3.0-next.2", "0.3.0-next.2")).toBe(0);
  });
});

describe("versionSkew", () => {
  test("says which side is behind", () => {
    expect(versionSkew("0.3.0-next.1", "0.3.0-next.2")).toBe("page-older");
    expect(versionSkew("0.3.0", "0.3.0-next.2")).toBe("serve-older");
    expect(versionSkew("0.3.0-next.2", "0.3.0-next.2")).toBeNull();
  });

  test("stays quiet when a side has no version: a checkout, the dev server, an old host", () => {
    expect(versionSkew(null, "0.3.0")).toBeNull();
    expect(versionSkew("0.3.0", null)).toBeNull();
    expect(versionSkew("0.3.0", undefined)).toBeNull();
  });
});
