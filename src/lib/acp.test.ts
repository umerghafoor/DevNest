import { describe, expect, it, vi } from "vitest";
import {
  AcpConnection,
  AcpError,
  isInside,
  sliceLines,
  type AcpClientHandlers,
} from "./acp";

function setup(overrides: Partial<AcpClientHandlers> = {}) {
  const sent: Record<string, unknown>[] = [];
  const handlers: AcpClientHandlers = {
    onSessionUpdate: vi.fn(),
    requestPermission: vi.fn(async () => ({
      outcome: "selected" as const,
      optionId: "allow",
    })),
    readTextFile: vi.fn(async () => "a\nb\nc\nd"),
    writeTextFile: vi.fn(async () => {}),
    elicit: vi.fn(async () => ({
      action: "accept" as const,
      content: { question_0: "B" },
    })),
    ...overrides,
  };
  const conn = new AcpConnection(async (line) => {
    sent.push(JSON.parse(line) as Record<string, unknown>);
  }, handlers);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { conn, sent, handlers, flush };
}

describe("AcpConnection", () => {
  it("matches responses to requests by id", async () => {
    const { conn, sent } = setup();
    const p = conn.newSession("/repo");
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/repo", mcpServers: [] },
    });
    conn.feed(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } }),
    );
    await expect(p).resolves.toEqual({ sessionId: "s1" });
  });

  it("rejects with AcpError carrying the code", async () => {
    const { conn } = setup();
    const p = conn.newSession("/repo");
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "Authentication required" },
      }),
    );
    await expect(p).rejects.toMatchObject({ code: -32000 });
    await expect(p).rejects.toBeInstanceOf(AcpError);
  });

  it("ignores non-JSON banner lines", () => {
    const { conn } = setup();
    expect(() => conn.feed("Downloading adapter…")).not.toThrow();
  });

  it("dispatches session/update notifications", () => {
    const { conn, handlers } = setup();
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    };
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update },
      }),
    );
    expect(handlers.onSessionUpdate).toHaveBeenCalledWith("s1", update);
  });

  it("answers permission requests with the chosen outcome", async () => {
    const { conn, sent, flush } = setup();
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t1" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      }),
    );
    await flush();
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  it("serves fs/read_text_file with line/limit", async () => {
    const { conn, sent, flush } = setup();
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "r1",
        method: "fs/read_text_file",
        params: { sessionId: "s1", path: "/repo/x", line: 2, limit: 2 },
      }),
    );
    await flush();
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: "r1",
      result: { content: "b\nc" },
    });
  });

  it("returns handler errors as JSON-RPC errors", async () => {
    const { conn, sent, flush } = setup({
      writeTextFile: async () => {
        throw new AcpError("refused", -32602);
      },
    });
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "fs/write_text_file",
        params: { sessionId: "s1", path: "/etc/passwd", content: "" },
      }),
    );
    await flush();
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "refused" },
    });
  });

  it("advertises form elicitation and answers elicitation/create", async () => {
    const { conn, sent, flush } = setup();
    void conn.initialize();
    expect(sent[0]).toMatchObject({
      params: { clientCapabilities: { elicitation: { form: {} } } },
    });
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "elicitation/create",
        params: {
          sessionId: "s1",
          mode: "form",
          message: "Pick one",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    );
    await flush();
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { action: "accept", content: { question_0: "B" } },
    });
  });

  it("sends an API key in authenticate _meta", () => {
    const { conn, sent } = setup();
    void conn.authenticate("gemini-api-key", "k-123");
    void conn.authenticate("oauth-personal");
    expect(sent[0]).toMatchObject({
      method: "authenticate",
      params: { methodId: "gemini-api-key", _meta: { "api-key": "k-123" } },
    });
    expect(sent[1].params).toEqual({ methodId: "oauth-personal" });
  });

  it("declines url-mode elicitation", async () => {
    const { conn, sent, flush } = setup();
    conn.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "elicitation/create",
        params: { sessionId: "s1", mode: "url", message: "", url: "x" },
      }),
    );
    await flush();
    expect(sent[0]).toMatchObject({ id: 6, result: { action: "decline" } });
  });

  it("rejects unknown agent→client methods", async () => {
    const { conn, sent, flush } = setup();
    conn.feed(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "terminal/create" }),
    );
    await flush();
    expect(sent[0]).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it("fails pending requests when the agent exits", async () => {
    const { conn } = setup();
    const p = conn.prompt("s1", "hello");
    conn.close();
    await expect(p).rejects.toThrow("agent exited");
    await expect(conn.initialize()).rejects.toThrow("agent exited");
  });
});

describe("helpers", () => {
  it("sliceLines", () => {
    expect(sliceLines("a\nb\nc")).toBe("a\nb\nc");
    expect(sliceLines("a\nb\nc", 2)).toBe("b\nc");
    expect(sliceLines("a\nb\nc", undefined, 1)).toBe("a");
  });

  it("isInside", () => {
    expect(isInside("/repo", "/repo/src/a.ts")).toBe(true);
    expect(isInside("/repo/", "/repo")).toBe(true);
    expect(isInside("/repo", "/repository/a")).toBe(false);
    expect(isInside("/repo", "/repo/../etc/passwd")).toBe(false);
    expect(isInside("/repo", "/etc/passwd")).toBe(false);
  });
});
