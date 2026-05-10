import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  permissions: string;
}

interface Props {
  deviceId: string;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

export function FileBrowserPanel({ deviceId }: Props) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<{
    entry: FileEntry;
    name: string;
  } | null>(null);

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

  const navigate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
  };

  const goUp = () => {
    const parent = cwd.split("/").slice(0, -1).join("/") || "/";
    void load(parent);
  };

  const openEditor = async (entry: FileEntry) => {
    try {
      const content = await invoke<string>("sftp_read_file", {
        deviceId,
        path: entry.path,
      });
      setEditing({ path: entry.path, content });
    } catch (e) {
      alert(`Cannot open: ${errorMessage(e)}`);
    }
  };

  const saveFile = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await invoke("sftp_write_file", {
        deviceId,
        path: editing.path,
        content: editing.content,
      });
      setEditing(null);
    } catch (e) {
      alert(`Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await invoke("sftp_delete", {
        deviceId,
        path: entry.path,
        isDir: entry.isDir,
      });
      void load(cwd);
    } catch (e) {
      alert(`Delete failed: ${errorMessage(e)}`);
    }
  };

  const doRename = async () => {
    if (!renaming) return;
    const newPath = cwd.replace(/\/?$/, "/") + renaming.name;
    try {
      await invoke("sftp_rename", {
        deviceId,
        from: renaming.entry.path,
        to: newPath,
      });
      setRenaming(null);
      void load(cwd);
    } catch (e) {
      alert(`Rename failed: ${errorMessage(e)}`);
    }
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 text-xs">
          <span className="font-mono text-(--color-fg-muted)">
            {editing.path}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded border border-(--color-border) px-2 py-1 hover:bg-(--color-surface-2)"
            >
              Cancel
            </button>
            <button
              onClick={saveFile}
              disabled={saving}
              className="rounded bg-(--color-accent) px-2 py-1 text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <textarea
          className="flex-1 resize-none bg-(--color-bg) p-4 font-mono text-xs text-(--color-fg) outline-none"
          value={editing.content}
          onChange={(e) =>
            setEditing((prev) => prev && { ...prev, content: e.target.value })
          }
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2 text-xs">
        <button
          onClick={goUp}
          disabled={cwd === "/"}
          className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
        >
          ↑ Up
        </button>
        <span className="font-mono text-(--color-fg-muted)">{cwd}</span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-(--color-fg-muted)">
          Loading…
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-(--color-error)">
          {error}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-(--color-surface) text-left text-(--color-fg-muted)">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Modified</th>
                <th className="px-3 py-2 font-medium">Perms</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.path}
                  className="group border-b border-(--color-border) hover:bg-(--color-surface-2)"
                >
                  <td className="px-3 py-1.5 align-middle">
                    <button
                      onClick={() => navigate(e)}
                      className={`text-left ${e.isDir ? "font-medium text-(--color-accent)" : ""}`}
                    >
                      {e.isDir ? "📁 " : "📄 "}
                      {renaming?.entry.path === e.path ? (
                        <input
                          autoFocus
                          value={renaming.name}
                          onChange={(ev) =>
                            setRenaming(
                              (r) => r && { ...r, name: ev.target.value },
                            )
                          }
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") void doRename();
                            if (ev.key === "Escape") setRenaming(null);
                          }}
                          onClick={(ev) => ev.stopPropagation()}
                          className="rounded border border-(--color-accent) bg-(--color-bg) px-1 text-xs outline-none"
                        />
                      ) : (
                        e.name
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 align-middle text-(--color-fg-muted)">
                    {e.isDir ? "—" : fmtSize(e.size)}
                  </td>
                  <td className="px-3 py-1.5 align-middle text-(--color-fg-muted)">
                    {fmtDate(e.modified)}
                  </td>
                  <td className="px-3 py-1.5 align-middle font-mono text-(--color-fg-muted)">
                    {e.permissions}
                  </td>
                  <td className="px-3 py-1.5 align-middle">
                    <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                      {!e.isDir && (
                        <button
                          onClick={() => openEditor(e)}
                          className="rounded border border-(--color-border) px-1.5 py-0.5 text-[10px] hover:bg-(--color-surface)"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        onClick={() => setRenaming({ entry: e, name: e.name })}
                        className="rounded border border-(--color-border) px-1.5 py-0.5 text-[10px] hover:bg-(--color-surface)"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => deleteEntry(e)}
                        className="rounded border border-(--color-error)/30 px-1.5 py-0.5 text-[10px] text-(--color-error) hover:bg-(--color-error)/10"
                      >
                        Del
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
