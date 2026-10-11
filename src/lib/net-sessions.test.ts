import { describe, expect, it } from "vitest";
import { pingStats, speedEstimate } from "./net-sessions";

describe("pingStats", () => {
  it("summarises replies and losses", () => {
    const st = pingStats([10, null, 20, 30, null]);
    expect(st.last).toBeNull();
    expect(st.avg).toBe(20);
    expect(st.min).toBe(10);
    expect(st.max).toBe(30);
    expect(st.jitter).toBe(10);
    expect(st.loss).toBe(40);
    expect(st.sent).toBe(5);
  });

  it("handles no samples", () => {
    const st = pingStats([]);
    expect(st.avg).toBeNull();
    expect(st.loss).toBe(0);
  });
});

describe("speedEstimate", () => {
  it("ignores the warm-up sample and takes the 90th percentile", () => {
    expect(speedEstimate([5, 90, 100, 95])).toBe(100);
    expect(speedEstimate([5, 90, 100, 95, 92, 91, 94, 93, 96, 97, 98])).toBe(100);
  });

  it("uses every sample when there are few", () => {
    expect(speedEstimate([40, 60])).toBe(60);
    expect(speedEstimate([])).toBeNull();
  });
});
