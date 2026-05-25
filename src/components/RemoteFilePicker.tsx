import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface Props {
  deviceId: string;
  /** If true, only directories are selectable (files are still shown for navigation context). */
  dirOnly?: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
}

export function RemoteFilePicker({ deviceId, dirOnly = false, onPick, onClose }: Props) {
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
        const list = await invoke<FileEntry[]>("sftp_list_dir", { deviceId, path });
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

  useEffect(() => { void load("/"); }, [load]);

  const goUp = () => {
    const parent = cwd.split("/").slice(0, -1).join("/") || "/";
    void load(parent);
  };

  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-content flex h-[520px] w-[520px] flex-col rounded-lg border border-(--color-border) bg-(--color-surface) shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) px-4 py-3">
          <span className="text-sm font-semibold">
            {dirOnly ? "Select remote folder" : "Open remote file"}
          </span>
          {dirOnly && cwd !== "/" && (
            <button
              onClick={() => onPick(cwd)}
              className="ml-auto rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
            >
              Select "{cwd.split("/").filter(Boolean).at(-1) ?? "/"}"
            </button>
          )}
          <button
            onClick={onClose}
            className={`rounded px-1.5 py-0.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) ${dirOnly && cwd !== "/" ? "" : "ml-auto"}`}
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
            onSubmit={(e) => { e.preventDefault(); void load(inputPath); }}
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
                    {dirOnly && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); onPick(e.path); }}
                        className="ml-auto rounded border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                      >
                        Select
                      </button>
                    )}
                  </button>
                </li>
              ))}
              {!dirOnly && files.map((e) => (
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
