import { useMemo, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { CodeEditor, languageFromFilename } from "../components/CodeEditor";
import { useAppStore } from "../store/app-store";
import { RemoteFilePicker } from "../components/RemoteFilePicker";

interface EditorState {
  /** Absolute path if a real file is open, null for the scratchpad. */
  path: string | null;
  /** Display name in the title bar. */
  name: string;
  content: string;
  dirty: boolean;
}

interface Props {
  deviceId: string;
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

export function EditorPanel({ deviceId }: Props) {
  const [file, setFile] = useState<EditorState>(loadScratch);
  const [showRemotePicker, setShowRemotePicker] = useState(false);

  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const isRemote = device ? !device.isLocalhost : false;

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
    if (isRemote) {
      setShowRemotePicker(true);
    } else {
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
    }
  };

  const openRemoteFile = async (path: string) => {
    setShowRemotePicker(false);
    try {
      const content = await invoke<string>("sftp_read_file", {
        deviceId,
        path,
      });
      setFile({ path, name: fileNameFromPath(path), content, dirty: false });
      toast.success(`Opened ${fileNameFromPath(path)}`);
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
        if (isRemote) {
          await invoke("sftp_write_file", {
            deviceId,
            path: file.path,
            content: file.content,
          });
        } else {
          await api.fsWriteText(file.path, file.content);
        }
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
    if (isRemote) {
      toast.info("Use Save after opening a remote file to save in place.");
      return;
    }
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

  const language = useMemo(() => languageFromFilename(file.name), [file.name]);

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
            onClick={() => void openFile()}
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
            onClick={() => void save()}
            disabled={!file.dirty && Boolean(file.path)}
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            title="Save (⌘S)"
          >
            Save
          </button>
          {!isRemote && (
            <button
              onClick={() => void saveAs()}
              className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
              title="Save As… (⇧⌘S)"
            >
              Save as…
            </button>
          )}
        </div>
      </div>
      <CodeEditor
        value={file.content}
        onChange={onChange}
        language={language}
        onSave={() => void save()}
        onSaveAs={() => void saveAs()}
        onOpen={() => void openFile()}
        className="min-h-0 flex-1 bg-(--color-bg) text-sm"
      />
      <div className="shrink-0 border-t border-(--color-border) bg-(--color-surface) px-4 py-1 text-[11px] text-(--color-fg-muted)">
        {language === "text"
          ? "Plain text"
          : `${language.toUpperCase()} · ⌘S to save · ⌘O to open`}
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
