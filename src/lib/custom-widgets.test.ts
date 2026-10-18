import { describe, expect, it } from "vitest";
import {
  formatValue,
  parseOutput,
  pick,
  rowsOf,
  sortRows,
} from "./custom-widgets";

const CLOC = `
1 text file.
{"header":{"cloc_version":"2.00","n_files":3},
 "Python":{"nFiles":2,"blank":10,"comment":5,"code":120},
 "Rust":{"nFiles":1,"blank":4,"comment":1,"code":300},
 "SUM":{"blank":14,"comment":6,"code":420,"nFiles":3}}`;

describe("custom widgets", () => {
  it("parses JSON after a banner", () => {
    const d = parseOutput(CLOC, "json");
    expect(pick(d, "SUM.code")).toBe(420);
  });

  it("parses tables, kv, lines and numbers", () => {
    expect(
      parseOutput(
        "PID CPU COMMAND\n1 0.5 launchd\n42 12 Google Chrome",
        "table",
      ),
    ).toEqual([
      { PID: "1", CPU: "0.5", COMMAND: "launchd" },
      { PID: "42", CPU: "12", COMMAND: "Google Chrome" },
    ]);
    expect(parseOutput("a: 1\nb=two\n", "kv")).toEqual({ a: "1", b: "two" });
    expect(parseOutput("x\n\ny\n", "lines")).toEqual(["x", "y"]);
    expect(parseOutput("  42 files\n", "number")).toBe(42);
    expect(() => parseOutput("nope", "number")).toThrow();
  });

  it("picks paths", () => {
    const d = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(pick(d, "a.b[1].c")).toBe(2);
    expect(pick(d, "a.b.length")).toBe(2);
    expect(pick(d, "")).toBe(d);
    expect(pick(d, "a.x.y")).toBeUndefined();
  });

  it("turns objects into rows and excludes keys", () => {
    const rows = rowsOf(parseOutput(CLOC), {
      items: "",
      exclude: ["header", "SUM"],
    });
    expect(rows.map((r) => r.key)).toEqual(["Python", "Rust"]);
    expect(sortRows(rows, "code")[0].key).toBe("Rust");
    expect(rowsOf({ a: 1 }, {})).toEqual([{ key: "a", value: 1 }]);
    expect(rowsOf(["x"], {})).toEqual([{ key: "x", value: "x" }]);
  });

  it("formats values", () => {
    expect(formatValue(1536, "bytes")).toBe("1.5 KB");
    expect(formatValue(12345, "compact")).toBe("12.3k");
    expect(formatValue(3700, "duration")).toBe("1h 1m");
    expect(formatValue(5.25, "percent")).toBe("5.3%");
    expect(formatValue(null)).toBe("—");
    expect(formatValue("ok")).toBe("ok");
  });
});
