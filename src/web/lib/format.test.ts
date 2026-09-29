import { describe, expect, test } from "bun:test";

import { formatCost, formatDuration, formatTokens } from "./format";

describe("format", () => {
  test("durations", () => {
    expect(formatDuration(400)).toBe("0s");
    expect(formatDuration(12_300)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });

  test("token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(19_162)).toBe("19.2k");
    expect(formatTokens(20_000)).toBe("20k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  test("costs", () => {
    expect(formatCost(0.1234, "USD")).toBe("$0.12");
    expect(formatCost(1.5, "nope")).toBe("1.50 nope");
  });
});
