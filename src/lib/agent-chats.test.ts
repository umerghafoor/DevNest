import { describe, expect, it } from "vitest";
import {
  chatsFor,
  chatTitle,
  compactItems,
  relativeTime,
  type ChatRecord,
} from "./agent-chats";
import type { TranscriptItem } from "./agent-sessions";

const items: TranscriptItem[] = [
  { kind: "system", id: "s", text: "ready" },
  { kind: "user", id: "u", text: "  show my\nstats please  " },
  { kind: "thought", id: "t", text: "hmm" },
  {
    kind: "tool",
    id: "c1",
    call: {
      toolCallId: "c1",
      title: "Read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "big" } }],
      rawInput: { path: "/x" },
    },
  },
  { kind: "agent", id: "a", text: "x".repeat(30_000) },
];

describe("saved chats", () => {
  it("titles a chat by its first prompt", () => {
    expect(chatTitle(items)).toBe("show my stats please");
    expect(
      chatTitle([{ kind: "user", id: "u", text: "y".repeat(80) }]),
    ).toHaveLength(58);
    expect(chatTitle([])).toBe("Untitled chat");
  });

  it("drops thinking and tool output, cuts long text", () => {
    const out = compactItems(items);
    expect(out.map((i) => i.kind)).toEqual(["system", "user", "tool", "agent"]);
    const tool = out[2] as Extract<TranscriptItem, { kind: "tool" }>;
    expect(tool.call).toEqual({
      toolCallId: "c1",
      title: "Read",
      kind: undefined,
      status: "completed",
    });
    const agent = out[3] as Extract<TranscriptItem, { kind: "agent" }>;
    expect(agent.text.length).toBeLessThan(21_000);
  });

  it("filters by scope, agent and device", () => {
    const base = {
      cwd: "",
      sessionId: null,
      title: "",
      createdAt: 0,
      updatedAt: 0,
      items: [],
    };
    const chats: ChatRecord[] = [
      { ...base, id: "1", scope: "pane", agentId: "claude", deviceId: "d1" },
      {
        ...base,
        id: "2",
        scope: "__master__",
        agentId: "claude",
        deviceId: "d1",
      },
      { ...base, id: "3", scope: "pane", agentId: "codex", deviceId: "d1" },
      { ...base, id: "4", scope: "pane", agentId: "claude", deviceId: "d2" },
    ];
    expect(chatsFor(chats, "pane", "claude", "d1").map((c) => c.id)).toEqual([
      "1",
    ]);
    expect(
      chatsFor(chats, "__master__", "claude", "d1").map((c) => c.id),
    ).toEqual(["2"]);
  });

  it("formats relative times", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});
