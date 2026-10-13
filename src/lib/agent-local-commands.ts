import type { AvailableCommand, ConfigOption } from "./acp";
import { flattenOptions } from "./acp";
import {
  logout,
  newConversation,
  note,
  setConfig,
  showSignIn,
  type AgentSession,
} from "./agent-sessions";

/**
 * DevNest's own slash commands, run in the client instead of being sent to
 * the agent. They fill gaps ACP adapters leave: Claude Code's adapter hides
 * `/clear`, `/login`, `/logout`, `/help` and every terminal-only command, so
 * we provide working equivalents, plus one command per agent setting
 * (`/model sonnet`, `/effort max`, …) generated from its config options.
 *
 * The agent's own command always wins when names collide.
 */
export type MenuCommand = AvailableCommand & {
  local?: boolean;
  /** Not offered over ACP: runs in the agent's own terminal UI. */
  terminal?: boolean;
};

interface LocalCommand extends MenuCommand {
  local: true;
  run: (s: AgentSession, arg: string) => void | Promise<void>;
}

function builtins(s: AgentSession): LocalCommand[] {
  const cmds: LocalCommand[] = [
    {
      local: true,
      name: "clear",
      description: "Start a new conversation",
      run: (x) => newConversation(x),
    },
    {
      local: true,
      name: "help",
      description: "List available commands",
      run: (x) => {
        const lines = allCommands(x).map(
          (c) =>
            `/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""} — ${
              c.description ?? ""
            }`,
        );
        note(x, lines.join("\n"));
      },
    },
  ];
  if (s.authMethods.length) {
    cmds.push({
      local: true,
      name: "login",
      description: "Sign in or switch account",
      run: (x) => showSignIn(x),
    });
  }
  if (s.canLogout) {
    cmds.push({
      local: true,
      name: "logout",
      description: "Sign out of the agent's account",
      run: (x) => logout(x),
    });
  }
  return cmds;
}

function configCommand(o: ConfigOption): LocalCommand {
  if (o.type === "boolean") {
    return {
      local: true,
      name: o.id,
      description: `${o.name}: turn on or off${o.description ? ` — ${o.description}` : ""}`,
      input: { hint: "on|off" },
      run: (s, arg) => {
        const a = arg.toLowerCase();
        const value =
          a === "on" || a === "true"
            ? true
            : a === "off" || a === "false"
              ? false
              : !o.currentValue;
        return setConfig(s, o.id, value);
      },
    };
  }
  const choices = flattenOptions(o.options);
  return {
    local: true,
    name: o.id,
    description: `Set ${o.name} (now: ${
      choices.find((c) => c.value === o.currentValue)?.name ?? o.currentValue
    })`,
    input: { hint: choices.map((c) => c.value).join("|") },
    run: (s, arg) => {
      if (!arg) {
        note(
          s,
          `${o.name} options:\n` +
            choices
              .map(
                (c) =>
                  `${c.value === o.currentValue ? "●" : "○"} ${c.value} — ${c.name}`,
              )
              .join("\n"),
        );
        return;
      }
      const a = arg.toLowerCase();
      const pick =
        choices.find((c) => c.value.toLowerCase() === a) ??
        choices.find((c) => c.name.toLowerCase() === a) ??
        choices.find((c) => c.name.toLowerCase().includes(a));
      if (!pick) {
        note(s, `Unknown ${o.name.toLowerCase()} "${arg}". Try /${o.id}`, true);
        return;
      }
      return setConfig(s, o.id, pick.value);
    },
  };
}

function localCommands(s: AgentSession): LocalCommand[] {
  return [...builtins(s), ...s.config.map(configCommand)];
}

/** Agent commands first, then DevNest's (unless the agent has that name). */
export function allCommands(s: AgentSession): MenuCommand[] {
  const taken = new Set(s.commands.map((c) => c.name));
  return [...s.commands, ...localCommands(s).filter((c) => !taken.has(c.name))];
}

/** Run `text` if it's a DevNest command; returns false to send it as-is. */
export function runLocalCommand(s: AgentSession, text: string): boolean {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  if (s.commands.some((c) => c.name === m[1])) return false;
  const cmd = localCommands(s).find((c) => c.name === m[1]);
  if (!cmd) return false;
  void cmd.run(s, m[2].trim());
  return true;
}
