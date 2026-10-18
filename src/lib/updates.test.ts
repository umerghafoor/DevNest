import { describe, expect, it } from "vitest";
import { compareVersions } from "./updates";

describe("compareVersions", () => {
  it("orders x.y.z numerically, ignoring a leading v", () => {
    expect(compareVersions("1.3.1", "1.3.0")).toBe(1);
    expect(compareVersions("v1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.3.0", "2.0.0")).toBe(-1);
    expect(compareVersions("1.4", "1.4.0")).toBe(0);
  });
});
