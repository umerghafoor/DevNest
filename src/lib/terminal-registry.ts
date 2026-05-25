import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";

export interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** Tauri PTY session id returned by terminal_open */
  termId: string;
  /** Tauri event unsubscribers — cleaned up only when explicitly destroyed */
  unlisten: (() => void) | null;
  unlistenExit: (() => void) | null;
  /** The DOM container the terminal is currently open() into */
  container: HTMLDivElement | null;
  /** True while a command is running (Enter sent, waiting for next prompt) */
  running: boolean;
  /** Accumulates recent output bytes for prompt detection */
  outputTail: string;
  /** True once at least one command has completed in this session */
  hasCompletedCommand: boolean;
  /**
   * Called by the output listener when running state changes.
   * Swapped by the currently-mounted TerminalPanel so the stale first-mount
   * closure always reaches the live component.
   */
  onBannerChange: ((visible: boolean) => void) | null;
}

/**
 * Global registry that keeps xterm + PTY instances alive for the lifetime of
 * the application, independent of which React component is currently rendered.
 * When TerminalPanel mounts with a known instanceId it receives the existing
 * entry and re-attaches the terminal to its container div rather than opening
 * a new PTY.
 */
const registry = new Map<string, TerminalEntry>();

export const terminalRegistry = {
  has(instanceId: string) {
    return registry.has(instanceId);
  },

  get(instanceId: string): TerminalEntry | undefined {
    return registry.get(instanceId);
  },

  set(instanceId: string, entry: TerminalEntry) {
    registry.set(instanceId, entry);
  },

  /** Fully tear down an entry — call only when the pane is explicitly closed. */
  destroy(instanceId: string) {
    const entry = registry.get(instanceId);
    if (!entry) return;
    entry.unlisten?.();
    entry.unlistenExit?.();
    entry.term.dispose();
    registry.delete(instanceId);
  },
};
