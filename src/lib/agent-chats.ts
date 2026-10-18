import { create } from "zustand";
import type { TranscriptItem } from "./agent-sessions";

/**
 * Saved agent conversations. DevNest keeps its own list (title, transcript,
 * the agent's session id) so every agent gets a chat history, even ones
 * without a session-listing API. Opening a chat resumes the agent's own
 * session with ACP `session/load` where the agent supports it.
 */
export interface ChatRecord {
  id: string;
  /** "pane" for agent panes, or the session key (e.g. "__master__"). */
  scope: string;
  agentId: string;
  deviceId: string;
  cwd: string;
  /** The agent's session id, for `session/load`. */
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
}

const KEY = "devnest.agent.chats";
const MAX_CHATS = 150;
const MAX_ITEMS = 400;
const MAX_TEXT = 20_000;

function load(): ChatRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ChatRecord[]) : [];
  } catch {
    return [];
  }
}

function save(chats: ChatRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats));
  } catch {
    // Quota: drop the oldest half and try once more.
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify(chats.slice(0, Math.ceil(chats.length / 2))),
      );
    } catch {
      // History just won't persist.
    }
  }
}

interface ChatsState {
  /** Newest first. */
  chats: ChatRecord[];
  upsert: (c: ChatRecord) => void;
  remove: (id: string) => void;
}

export const useChatsStore = create<ChatsState>((set, get) => ({
  chats: load(),
  upsert: (c) => {
    const rest = get().chats.filter((x) => x.id !== c.id);
    const chats = [c, ...rest]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS);
    set({ chats });
    save(chats);
  },
  remove: (id) => {
    const chats = get().chats.filter((x) => x.id !== id);
    set({ chats });
    save(chats);
  },
}));

/** Chats on one device in one scope, newest first — for one agent, or for
 *  every agent when `agentId` is null. */
export function chatsFor(
  chats: ChatRecord[],
  scope: string,
  agentId: string | null,
  deviceId: string,
) {
  return chats.filter(
    (c) =>
      c.scope === scope &&
      (agentId === null || c.agentId === agentId) &&
      c.deviceId === deviceId,
  );
}

/** First prompt, one line, trimmed for a list. */
export function chatTitle(items: TranscriptItem[]) {
  const first = items.find((i) => i.kind === "user");
  const text = first && "text" in first ? first.text : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled chat";
}

/**
 * Keep what's worth re-reading and small enough for localStorage: no
 * thinking, tool calls without their output, long texts cut.
 */
export function compactItems(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .filter((i) => i.kind !== "thought")
    .map((i): TranscriptItem => {
      if (i.kind === "tool") {
        const { toolCallId, title, kind, status } = i.call;
        return { ...i, call: { toolCallId, title, kind, status } };
      }
      if ("text" in i && i.text.length > MAX_TEXT) {
        return { ...i, text: `${i.text.slice(0, MAX_TEXT)}\n… [cut]` };
      }
      return i;
    })
    .slice(-MAX_ITEMS);
}

/** "3m ago", "2h ago", "Mar 4". */
export function relativeTime(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
