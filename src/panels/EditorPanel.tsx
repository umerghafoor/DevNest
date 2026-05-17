import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";

interface EditorState {
  /** Absolute path if a real file is open, null for the scratchpad. */
  path: string | null;
  /** Display name in the title bar. */
  name: string;
  content: string;
  dirty: boolean;
}

const SCRATCH_KEY = "devnest.editor.scratch";

function loadScratch(): EditorState {
  const stored = localStorage.getItem(SCRATCH_KEY);
  return {
    path: null,
    name: "scratch.txt",
    content:
      stored ?? "# Scratchpad\n\nType anything here. It saves locally.\n",
    dirty: false,
  };
}

function fileNameFromPath(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function EditorPanel() {
  const [file, setFile] = useState<EditorState>(loadScratch);

  const onChange = (value: string) => {
    setFile((f) => ({ ...f, content: value, dirty: true }));
  };

  const promptDiscardIfDirty = async (action: string) => {
    if (!file.dirty) return true;
    return confirm(`Discard unsaved changes to ${file.name}? (${action})`, {
      title: "Unsaved changes",
      destructive: true,
    });
  };

  const openFile = async () => {
    if (!(await promptDiscardIfDirty("Open file"))) return;
    const picked = await openDialog({ multiple: false, directory: false });
    if (typeof picked !== "string") return;
    try {
      const content = await api.fsReadText(picked);
      setFile({
        path: picked,
        name: fileNameFromPath(picked),
        content,
        dirty: false,
      });
      toast.success(`Opened ${fileNameFromPath(picked)}`);
    } catch (e) {
      toast.error(`Open failed: ${errorMessage(e)}`);
    }
  };

  const newScratch = async () => {
    if (!(await promptDiscardIfDirty("New scratchpad"))) return;
    setFile({
      path: null,
      name: "scratch.txt",
      content: "",
      dirty: true,
    });
  };

  const save = async () => {
    if (file.path) {
      try {
        await api.fsWriteText(file.path, file.content);
        setFile((f) => ({ ...f, dirty: false }));
        toast.success(`Saved ${file.name}`);
      } catch (e) {
        toast.error(`Save failed: ${errorMessage(e)}`);
      }
      return;
    }
    // Scratchpad — persist to localStorage.
    localStorage.setItem(SCRATCH_KEY, file.content);
    setFile((f) => ({ ...f, dirty: false }));
    toast.success("Scratchpad saved");
  };

  const saveAs = async () => {
    const picked = await saveDialog({
      defaultPath: file.path ?? file.name,
    });
    if (typeof picked !== "string") return;
    try {
      await api.fsWriteText(picked, file.content);
      setFile({
        path: picked,
        name: fileNameFromPath(picked),
        content: file.content,
        dirty: false,
      });
      toast.success(`Saved ${fileNameFromPath(picked)}`);
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (e.shiftKey) void saveAs();
      else void save();
      return;
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openFile();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = file.content.slice(0, start) + "  " + file.content.slice(end);
      setFile((f) => ({ ...f, content: next, dirty: true }));
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="fade-up flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <span className="text-sm font-medium" title={file.path ?? "Scratchpad"}>
          {file.name}
          {file.dirty && (
            <span className="ml-1.5 text-(--color-warn)" title="Unsaved">
              •
            </span>
          )}
        </span>
        {file.path && (
          <span
            className="hidden truncate font-mono text-[10px] text-(--color-fg-muted) sm:inline"
            title={file.path}
          >
            {file.path}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={openFile}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
            title="Open file (⌘O)"
          >
            Open…
          </button>
          <button
            onClick={() => void newScratch()}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
            title="New scratchpad"
          >
            New
          </button>
          <button
            onClick={save}
            disabled={!file.dirty && Boolean(file.path)}
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            title="Save (⌘S)"
          >
            Save
          </button>
          <button
            onClick={saveAs}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
            title="Save As… (⇧⌘S)"
          >
            Save as…
          </button>
        </div>
      </div>
      <textarea
        value={file.content}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-(--color-bg) p-4 font-mono text-sm text-(--color-fg) outline-none"
        placeholder="Type something…"
      />
      <div className="shrink-0 border-t border-(--color-border) bg-(--color-surface) px-4 py-1 text-[11px] text-(--color-fg-muted)">
        Plain text editor. Syntax highlighting will land with a proper editor
        (e.g. CodeMirror) in a later phase.
      </div>
    </div>
  );
}
