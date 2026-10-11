import { create } from "zustand";

/** How to launch a third-party ACP agent. */
export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Shell command that installs `command` when it's missing. Runs through
   * the user's login shell on the target device.
   */
  install?: string;
  /** Shipped with the app; editable, but "reset" restores it. */
  builtin?: boolean;
}

/** Node via nvm: no sudo, works on macOS and Linux, gives `npx` + `npm -g`. */
const INSTALL_NODE =
  'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts';

/**
 * Known ACP agents. Package names move around — users can edit these, and
 * the registry at https://agentclientprotocol.com lists current commands.
 */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    install: INSTALL_NODE,
    builtin: true,
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    install: INSTALL_NODE,
    builtin: true,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    install: "npm install -g @google/gemini-cli",
    builtin: true,
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
    install:
      "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
    builtin: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    install: "npm install -g opencode-ai",
    builtin: true,
  },
];

const STORAGE_KEY = "devnest.agents";

interface Stored {
  agents: AgentDef[];
  lastAgentId: string | null;
  /** Last project folder, per device id. */
  lastCwd: Record<string, string>;
}

function readStored(): Stored {
  const fallback: Stored = {
    agents: BUILTIN_AGENTS,
    lastAgentId: null,
    lastCwd: {},
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    // Surface presets (and preset fields) added in newer app versions.
    for (const b of BUILTIN_AGENTS) {
      const i = agents.findIndex((a) => a.id === b.id);
      if (i === -1) agents.push(b);
      else if (agents[i].install === undefined)
        agents[i] = { ...agents[i], install: b.install };
    }
    return {
      agents,
      lastAgentId: parsed.lastAgentId ?? null,
      lastCwd:
        parsed.lastCwd && typeof parsed.lastCwd === "object"
          ? parsed.lastCwd
          : {},
    };
  } catch {
    return fallback;
  }
}

function persist(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

interface AgentsState extends Stored {
  upsert: (def: AgentDef) => void;
  remove: (id: string) => void;
  resetBuiltin: (id: string) => void;
  setLast: (agentId: string, deviceId: string, cwd: string) => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => {
  const save = (patch: Partial<Stored>) => {
    set(patch);
    const { agents, lastAgentId, lastCwd } = get();
    persist({ agents, lastAgentId, lastCwd });
  };
  return {
    ...readStored(),
    upsert: (def) => {
      const agents = get().agents;
      const idx = agents.findIndex((a) => a.id === def.id);
      save({
        agents:
          idx === -1
            ? [...agents, def]
            : agents.map((a) => (a.id === def.id ? def : a)),
      });
    },
    remove: (id) => save({ agents: get().agents.filter((a) => a.id !== id) }),
    resetBuiltin: (id) => {
      const preset = BUILTIN_AGENTS.find((b) => b.id === id);
      if (preset) get().upsert(preset);
    },
    setLast: (lastAgentId, deviceId, cwd) =>
      save({ lastAgentId, lastCwd: { ...get().lastCwd, [deviceId]: cwd } }),
  };
});

/** Split a command-line-ish string into args, honouring simple quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}
