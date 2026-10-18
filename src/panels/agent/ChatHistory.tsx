import { useEffect, useRef, useState } from "react";
import { History, Plus, X } from "lucide-react";
import { relativeTime, type ChatRecord } from "../../lib/agent-chats";

/**
 * Past chats for an agent: new chat, then saved conversations newest first.
 * Shared by agent panes (as a popover) and the Master panel's menu.
 */
export function ChatList({
  chats,
  currentId,
  showCwd,
  agentName,
  onNew,
  onOpen,
  onDelete,
}: {
  chats: ChatRecord[];
  currentId: string | null;
  /** Show each chat's folder (agent panes work in different projects). */
  showCwd?: boolean;
  /** Display name for a chat's agent; shown when the list mixes agents. */
  agentName?: (agentId: string) => string;
  onNew?: () => void;
  onOpen: (c: ChatRecord) => void;
  onDelete: (c: ChatRecord) => void;
}) {
  const mixed = new Set(chats.map((c) => c.agentId)).size > 1;
  return (
    <div className="text-xs">
      {onNew && (
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-(--color-surface-2)"
        >
          <span className="flex w-4 justify-center text-(--color-fg-muted)">
            <Plus size={12} />
          </span>
          New chat
        </button>
      )}
      {chats.length === 0 ? (
        <div className="px-3 py-2 text-(--color-fg-muted)">
          No saved chats yet.
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {chats.map((c) => (
            <li key={c.id} className="group relative">
              <button
                onClick={() => onOpen(c)}
                className={`flex w-full flex-col items-start gap-0.5 py-1.5 pr-7 pl-9 text-left hover:bg-(--color-surface-2) ${
                  c.id === currentId ? "bg-(--color-accent)/10" : ""
                }`}
              >
                <span className="w-full truncate" title={c.title}>
                  {c.title}
                </span>
                <span className="w-full truncate text-[11px] text-(--color-fg-muted)">
                  {relativeTime(c.updatedAt)}
                  {mixed && agentName && ` · ${agentName(c.agentId)}`}
                  {showCwd && c.cwd && (
                    <>
                      {" · "}
                      <span className="font-mono" title={c.cwd}>
                        {c.cwd.split(/[\\/]/).filter(Boolean).pop() ?? c.cwd}
                      </span>
                    </>
                  )}
                </span>
              </button>
              <button
                onClick={() => onDelete(c)}
                title="Delete chat"
                className="absolute top-1.5 right-1.5 hidden h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) group-hover:flex hover:bg-(--color-surface) hover:text-(--color-error)"
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Toolbar button that opens the chat list in a popover. */
export function ChatHistoryButton(
  props: React.ComponentProps<typeof ChatList>,
) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const close = <A extends unknown[]>(fn?: (...a: A) => void) =>
    fn &&
    ((...a: A) => {
      setOpen(false);
      fn(...a);
    });

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Chats"
        className={`inline-flex h-6 items-center justify-center gap-1 rounded px-2 hover:bg-(--color-surface-2) ${open ? "bg-(--color-surface-2)" : ""}`}
      >
        <History size={12} />
        {props.chats.length > 0 && (
          <span className="text-(--color-fg-muted) tabular-nums">
            {props.chats.length}
          </span>
        )}
      </button>
      {open && (
        <div className="modal-content absolute top-full right-0 z-30 mt-1 w-72 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) py-1 shadow-xl">
          <ChatList
            {...props}
            onNew={close(props.onNew)}
            onOpen={close(props.onOpen)!}
          />
        </div>
      )}
    </div>
  );
}
