import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPromptHistory,
  promptHistory,
  pushPrompt,
  stepHistory,
} from "./prompt-history";

describe("prompt history", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    _resetPromptHistory();
  });

  it("dedupes and persists", () => {
    pushPrompt("a");
    pushPrompt("b");
    pushPrompt("a");
    pushPrompt("  ");
    expect(promptHistory()).toEqual(["b", "a"]);
    _resetPromptHistory();
    expect(promptHistory()).toEqual(["b", "a"]);
  });

  it("steps back and forward, restoring the draft", () => {
    const h = ["one", "two", "three"];
    let st = stepHistory(h, null, -1, "draft")!;
    expect(st).toEqual({ index: 2, text: "three" });
    st = stepHistory(h, st.index, -1, "draft")!;
    expect(st.text).toBe("two");
    st = stepHistory(h, st.index, 1, "draft")!;
    expect(st.text).toBe("three");
    st = stepHistory(h, st.index, 1, "draft")!;
    expect(st).toEqual({ index: null, text: "draft" });
    expect(stepHistory(h, null, 1, "draft")).toBeNull();
    expect(stepHistory(h, 0, -1, "draft")).toBeNull();
    expect(stepHistory([], null, -1, "")).toBeNull();
  });
});
