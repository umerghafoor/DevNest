import { useState } from "react";
import { toast } from "../components/Toast";

interface OpenFile {
  path: string;
  content: string;
  dirty: boolean;
}

const STORAGE_KEY = "devnest.editor.scratch";

function readScratch(): OpenFile {
  const stored = localStorage.getItem(STORAGE_KEY);
  return {
    path: "scratch.txt",
    content: stored ?? "# Scratchpad\n\nType anything here. It saves locally.\n",
    dirty: false,
  };
}

export function EditorPanel() {
  const [file, setFile] = useState<OpenFile>(readScratch);

  const onChange = (value: string) => {
    setFile((f) => ({ ...f, content: value, dirty: true }));
  };

  const save = () => {
    localStorage.setItem(STORAGE_KEY, file.content);
    setFile((f) => ({ ...f, dirty: false }));
    toast.success("Scratchpad saved");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
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
      <div className="flex shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{file.path}</span>
          {file.dirty && (
            <span className="text-xs text-(--color-warn)">• unsaved</span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!file.dirty}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
        >
          Save (⌘S)
        </button>
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
        Scaffold — uses a plain textarea. Syntax highlighting will land with a
        proper editor (e.g. CodeMirror) in a later phase.
      </div>
    </div>
  );
}
