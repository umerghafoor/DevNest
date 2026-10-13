import { describe, expect, it } from "vitest";
import { agentTerminalCommand, type AgentSession } from "./agent-sessions";
import { BUILTIN_AGENTS } from "../store/agents-store";

const claude = BUILTIN_AGENTS.find((a) => a.id === "claude-code")!;

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: claude,
    cwd: "/home/me/my repo",
    sessionId: "abc-123",
    items: [],
    ...over,
  } as unknown as AgentSession;
}

describe("agentTerminalCommand", () => {
  it("opens a fresh CLI before the first turn", () => {
    expect(agentTerminalCommand(session())).toBe(
      "cd '/home/me/my repo' && npx -y @agentclientprotocol/claude-agent-acp --cli",
    );
  });

  it("resumes a fork of the conversation and passes the command", () => {
    const s = session({ items: [{ kind: "user", id: "1", text: "hi" }] });
    expect(agentTerminalCommand(s, "/btw what's left?")).toBe(
      "cd '/home/me/my repo' && npx -y @agentclientprotocol/claude-agent-acp --cli --resume abc-123 --fork-session '/btw what'\\''s left?'",
    );
  });

  it("returns null for agents without a terminal UI", () => {
    const codex = BUILTIN_AGENTS.find((a) => a.id === "codex")!;
    expect(agentTerminalCommand(session({ agent: codex }))).toBeNull();
  });
});
