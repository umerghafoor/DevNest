import { useMemo, useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { useAppStore } from "../store/app-store";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface DocState {
  path: string | null;
  name: string;
  content: string;
  dirty: boolean;
}

interface Props {
  deviceId: string;
}

const SCRATCH_KEY = "devnest.markdown.scratch";

const DEFAULT_CONTENT = `# Markdown Preview

Write **Markdown** here and see it rendered live.

## Features

- _Italic_ and **bold** text
- \`inline code\` and fenced blocks
- [Links](https://example.com)
- Tables, blockquotes, and more

\`\`\`js
console.log("Hello, world!");
\`\`\`

> Tip: use the **Split** button to place the editor and preview side-by-side.
`;

function loadScratch(): DocState {
  const stored = localStorage.getItem(SCRATCH_KEY);
  return {
    path: null,
    name: "scratch.md",
    content: stored ?? DEFAULT_CONTENT,
    dirty: false,
  };
}

function fileNameFromPath(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ── Remote file picker ────────────────────────────────────────────────────────

function RemoteFilePicker({
  deviceId,
  onPick,
  onClose,
}: {
  deviceId: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputPath, setInputPath] = useState("/");

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<FileEntry[]>("sftp_list_dir", {
          deviceId,
          path,
        });
        setEntries(list);
        setCwd(path);
        setInputPath(path);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    void load("/");
  }, [load]);

  const goUp = () => {
    const parent = cwd.split("/").slice(0, -1).join("/") || "/";
    void load(parent);
  };

  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => !e.isDir)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-content flex h-[520px] w-[520px] flex-col rounded-lg border border-(--color-border) bg-(--color-surface) shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) px-4 py-3">
          <span className="text-sm font-semibold">Open remote file</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-1.5 py-0.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            ×
          </button>
        </div>

        {/* Path bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) px-3 py-2">
          <button
            onClick={goUp}
            disabled={cwd === "/"}
            className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) disabled:opacity-30"
            title="Go up"
          >
            ↑
          </button>
          <form
            className="flex flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void load(inputPath);
            }}
          >
            <input
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
              className="input flex-1 py-0.5 text-xs font-mono"
              spellCheck={false}
            />
            <button
              type="submit"
              className="rounded border border-(--color-border) px-2 py-0.5 text-xs hover:bg-(--color-surface-2)"
            >
              Go
            </button>
          </form>
        </div>

        {/* File list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
              Loading…
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-xs text-(--color-error)">
              {error}
            </div>
          ) : (
            <ul className="py-1">
              {dirs.map((e) => (
                <li key={e.path}>
                  <button
                    onClick={() => void load(e.path)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-(--color-surface-2)"
                  >
                    <span className="text-(--color-fg-muted)">📁</span>
                    <span className="font-medium">{e.name}</span>
                  </button>
                </li>
              ))}
              {files.map((e) => (
                <li key={e.path}>
                  <button
                    onClick={() => onPick(e.path)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-(--color-surface-2)"
                  >
                    <span className="text-(--color-fg-muted)">📄</span>
                    <span>{e.name}</span>
                  </button>
                </li>
              ))}
              {dirs.length === 0 && files.length === 0 && (
                <li className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
                  Empty directory
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function MarkdownPanel({ deviceId }: Props) {
  const [doc, setDoc] = useState<DocState>(loadScratch);
  const [mode, setMode] = useState<"edit" | "preview" | "split">("split");
  const [showRemotePicker, setShowRemotePicker] = useState(false);

  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const isRemote = device ? !device.isLocalhost : false;

  const html = useMemo(() => marked.parse(doc.content) as string, [doc.content]);

  const onChange = (value: string) => {
    setDoc((d) => ({ ...d, content: value, dirty: true }));
  };

  const promptDiscardIfDirty = async (action: string) => {
    if (!doc.dirty) return true;
    return confirm(`Discard unsaved changes to ${doc.name}? (${action})`, {
      title: "Unsaved changes",
      destructive: true,
    });
  };

  const openFile = async () => {
    if (!(await promptDiscardIfDirty("Open file"))) return;
    if (isRemote) {
      setShowRemotePicker(true);
    } else {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
      });
      if (typeof picked !== "string") return;
      try {
        const content = await api.fsReadText(picked);
        setDoc({ path: picked, name: fileNameFromPath(picked), content, dirty: false });
        toast.success(`Opened ${fileNameFromPath(picked)}`);
      } catch (e) {
        toast.error(`Open failed: ${errorMessage(e)}`);
      }
    }
  };

  const openRemoteFile = async (path: string) => {
    setShowRemotePicker(false);
    try {
      const content = await invoke<string>("sftp_read_file", { deviceId, path });
      setDoc({ path, name: fileNameFromPath(path), content, dirty: false });
      toast.success(`Opened ${fileNameFromPath(path)}`);
    } catch (e) {
      toast.error(`Open failed: ${errorMessage(e)}`);
    }
  };

  const newScratch = async () => {
    if (!(await promptDiscardIfDirty("New document"))) return;
    setDoc({ path: null, name: "scratch.md", content: "", dirty: true });
  };

  const save = async () => {
    if (doc.path) {
      try {
        if (isRemote) {
          await invoke("sftp_write_file", { deviceId, path: doc.path, content: doc.content });
        } else {
          await api.fsWriteText(doc.path, doc.content);
        }
        setDoc((d) => ({ ...d, dirty: false }));
        toast.success(`Saved ${doc.name}`);
      } catch (e) {
        toast.error(`Save failed: ${errorMessage(e)}`);
      }
      return;
    }
    localStorage.setItem(SCRATCH_KEY, doc.content);
    setDoc((d) => ({ ...d, dirty: false }));
    toast.success("Scratchpad saved");
  };

  const saveAs = async () => {
    if (isRemote) {
      toast.info("Use Save after opening a remote file to save in place.");
      return;
    }
    const picked = await saveDialog({ defaultPath: doc.path ?? doc.name });
    if (typeof picked !== "string") return;
    try {
      await api.fsWriteText(picked, doc.content);
      setDoc({ path: picked, name: fileNameFromPath(picked), content: doc.content, dirty: false });
      toast.success(`Saved ${fileNameFromPath(picked)}`);
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <div className="fade-up flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <span className="text-sm font-medium" title={doc.path ?? "Scratchpad"}>
          {doc.name}
          {doc.dirty && (
            <span className="ml-1.5 text-(--color-warn)" title="Unsaved">•</span>
          )}
        </span>
        {doc.path && (
          <span
            className="hidden truncate font-mono text-[10px] text-(--color-fg-muted) sm:inline"
            title={doc.path}
          >
            {doc.path}
          </span>
        )}

        {/* Mode toggle */}
        <div className="ml-auto flex items-center gap-1 rounded border border-(--color-border) bg-(--color-bg) p-0.5">
          {(["edit", "split", "preview"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${
                mode === m
                  ? "bg-(--color-accent) text-(--color-accent-fg) font-medium"
                  : "text-(--color-fg-muted) hover:text-(--color-fg)"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void openFile()}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
          >
            Open…
          </button>
          <button
            onClick={() => void newScratch()}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
          >
            New
          </button>
          <button
            onClick={() => void save()}
            disabled={!doc.dirty && Boolean(doc.path)}
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            title="Save (⌘S)"
          >
            Save
          </button>
          {!isRemote && (
            <button
              onClick={() => void saveAs()}
              className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
            >
              Save as…
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(mode === "edit" || mode === "split") && (
          <textarea
            value={doc.content}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className={`resize-none bg-(--color-bg) p-4 font-mono text-sm text-(--color-fg) outline-none ${
              mode === "split"
                ? "w-1/2 border-r border-(--color-border)"
                : "w-full"
            }`}
            placeholder="Write Markdown here…"
          />
        )}

        {(mode === "preview" || mode === "split") && (
          <div className={`overflow-y-auto p-6 ${mode === "split" ? "w-1/2" : "w-full"}`}>
            <div
              className="markdown-preview prose max-w-none"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>

      {showRemotePicker && (
        <RemoteFilePicker
          deviceId={deviceId}
          onPick={(path) => void openRemoteFile(path)}
          onClose={() => setShowRemotePicker(false)}
        />
      )}
    </div>
  );
}
