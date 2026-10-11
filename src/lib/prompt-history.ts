/**
 * Prompts sent to any agent, newest last, shared like shell history so ↑ in
 * one agent's composer recalls what you typed in another. Persisted.
 */

const KEY = "devnest.agent.promptHistory";
const MAX = 200;

let entries: string[] | null = null;

function load(): string[] {
  if (entries) return entries;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    entries = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    entries = [];
  }
  return entries;
}

export function promptHistory(): readonly string[] {
  return load();
}

export function pushPrompt(text: string) {
  const t = text.trim();
  if (!t) return;
  // Re-running an old prompt moves it to the end instead of duplicating.
  const next = [...load().filter((e) => e !== t), t].slice(-MAX);
  entries = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // History just won't persist.
  }
}

/**
 * ↑/↓ navigation over `history`. `index` is the entry shown, or null while
 * editing the draft. Returns the new index and the text to show, or null
 * when there's nowhere to go.
 */
export function stepHistory(
  history: readonly string[],
  index: number | null,
  dir: -1 | 1,
  draft: string,
): { index: number | null; text: string } | null {
  if (history.length === 0) return null;
  if (index === null) {
    if (dir === 1) return null;
    const i = history.length - 1;
    return { index: i, text: history[i] };
  }
  const i = index + dir;
  if (i < 0) return null;
  if (i >= history.length) return { index: null, text: draft };
  return { index: i, text: history[i] };
}

/** For tests. */
export function _resetPromptHistory() {
  entries = null;
}
