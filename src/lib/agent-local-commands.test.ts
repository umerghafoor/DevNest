import { describe, expect, it, vi } from "vitest";

vi.mock("./agent-sessions", () => ({
  logout: vi.fn(),
  newConversation: vi.fn(),
  note: vi.fn(),
  setConfig: vi.fn(),
  showSignIn: vi.fn(),
}));

import * as sessions from "./agent-sessions";
import type { AgentSession } from "./agent-sessions";
import { allCommands, runLocalCommand } from "./agent-local-commands";

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    commands: [{ name: "compact", description: "agent" }],
    config: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus 5.5" },
          { value: "sonnet", name: "Sonnet 5.5" },
        ],
      },
      { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
    ],
    authMethods: [],
    canLogout: true,
    ...over,
  } as unknown as AgentSession;
}

describe("DevNest slash commands", () => {
  it("adds clear/help/logout and one command per setting", () => {
    const names = allCommands(session()).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "compact",
        "clear",
        "help",
        "logout",
        "model",
        "fast",
      ]),
    );
    expect(names).not.toContain("login"); // no auth methods
  });

  it("lets the agent's command win on a name clash", () => {
    const s = session({
      commands: [{ name: "model", description: "agent's own" }],
    });
    expect(allCommands(s).filter((c) => c.name === "model")).toHaveLength(1);
    expect(runLocalCommand(s, "/model sonnet")).toBe(false);
  });

  it("sets a select option by value or by name", () => {
    const s = session();
    expect(runLocalCommand(s, "/model sonnet")).toBe(true);
    expect(sessions.setConfig).toHaveBeenLastCalledWith(s, "model", "sonnet");
    runLocalCommand(s, "/model Opus 5.5");
    expect(sessions.setConfig).toHaveBeenLastCalledWith(s, "model", "opus");
  });

  it("toggles boolean options", () => {
    const s = session();
    runLocalCommand(s, "/fast on");
    expect(sessions.setConfig).toHaveBeenLastCalledWith(s, "fast", true);
    runLocalCommand(s, "/fast");
    expect(sessions.setConfig).toHaveBeenLastCalledWith(s, "fast", true);
  });

  it("leaves unknown commands and plain text to the agent", () => {
    expect(runLocalCommand(session(), "/compact")).toBe(false);
    expect(runLocalCommand(session(), "hello")).toBe(false);
    expect(runLocalCommand(session(), "/clear")).toBe(true);
    expect(sessions.newConversation).toHaveBeenCalled();
  });
});
