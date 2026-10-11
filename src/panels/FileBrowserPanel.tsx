import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  File as FileIcon,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Pencil,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { errorMessage } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { SkeletonTable } from "../components/Skeleton";
import { DiskUsageTreemap } from "../components/DiskUsageTreemap";

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
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type SortKey = "name" | "size" | "modified";

const CODE_EXT =
  /\.(tsx?|jsx?|json|ya?ml|toml|rs|py|go|c|cpp|h|java|sh|css|html|sql|xml)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i;
const TEXT_EXT = /\.(md|txt|log|csv|lock|env)$/i;

function EntryIcon({ entry }: { entry: FileEntry }) {
  const cls = "h-4 w-4 shrink-0";
  if (entry.isDir)
    return (
      <Folder
        className={`${cls} text-(--color-accent)`}
        fill="currentColor"
        fillOpacity={0.18}
      />
    );
  if (IMAGE_EXT.test(entry.name))
    return <FileImage className={`${cls} text-(--color-online)`} />;
  if (CODE_EXT.test(entry.name))
    return <FileCode className={`${cls} text-sky-500`} />;
  if (TEXT_EXT.test(entry.name))
    return <FileText className={`${cls} text-(--color-fg-muted)`} />;
  return <FileIcon className={`${cls} text-(--color-fg-muted)`} />;
}

function IconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        danger
          ? "text-(--color-error) hover:bg-(--color-error)/15"
          : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
      }`}
    >
      {children}
    </button>
  );
}

const CWD_PREFIX = "devnest.files.cwd.";
const DEVNEST_FILE_DRAG = "application/x-devnest-file";

function loadCwd(deviceId: string): string {
  try {
    return localStorage.getItem(CWD_PREFIX + deviceId) ?? "/";
  } catch {
    return "/";
  }
}
function saveCwd(deviceId: string, path: string) {
  try {
    localStorage.setItem(CWD_PREFIX + deviceId, path);
  } catch {
    /* ignore */
  }
}

export function FileBrowserPanel({ deviceId }: Props) {
  const [cwd, setCwd] = useState(() => loadCwd(deviceId));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"files" | "diskUsage">("files");
  const [editing, setEditing] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<{
    entry: FileEntry;
    name: string;
  } | null>(null);

  // Drag and drop states
  const [dragOver, setDragOver] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Quick filter
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: "name",
    asc: true,
  });
  const [showHidden, setShowHidden] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);

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
        setFilter("");
        setCwd(path);
        saveCwd(deviceId, path);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    void load(loadCwd(deviceId));
  }, [load, deviceId]);

  const navigate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
  };

  const q = filter.trim().toLowerCase();
  const visible = entries
    .filter((e) => showHidden || !e.name.startsWith("."))
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const dir = sort.asc ? 1 : -1;
      if (sort.key === "size") return (a.size - b.size) * dir;
      if (sort.key === "modified") return (a.modified - b.modified) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
    });

  const toggleSort = (key: SortKey) =>
    setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));

  const crumbs = cwd.split("/").filter(Boolean);
  const crumbPath = (i: number) => "/" + crumbs.slice(0, i + 1).join("/");

  const openFirstMatch = () => {
    const first = visible[0];
    if (!first) return;
    if (first.isDir) void load(first.path);
    else void openEditor(first);
  };

  // Type anywhere in the panel to start filtering; Ctrl/Cmd+F focuses the box.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (viewMode !== "files") return;
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      filterRef.current?.focus();
    }
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
      toast.error(`Cannot open: ${errorMessage(e)}`);
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
      toast.success("File saved");
      setEditing(null);
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    const ok = await confirm(`Delete ${entry.name}?`, {
      title: "Delete file",
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke("sftp_delete", {
        deviceId,
        path: entry.path,
        isDir: entry.isDir,
      });
      toast.success(`Deleted ${entry.name}`);
      void load(cwd);
    } catch (e) {
      toast.error(`Delete failed: ${errorMessage(e)}`);
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
      toast.success(`Renamed to ${renaming.name}`);
      setRenaming(null);
      void load(cwd);
    } catch (e) {
      toast.error(`Rename failed: ${errorMessage(e)}`);
    }
  };

  // Upload local files
  const uploadLocalFile = async (file: File, targetDir: string) => {
    const targetPath = targetDir.replace(/\/?$/, "/") + file.name;
    const buffer = await file.arrayBuffer();
    const data = Array.from(new Uint8Array(buffer));

    await invoke("sftp_upload_file_bytes", {
      deviceId,
      path: targetPath,
      data,
    });
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setTransferring(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        toast.info(`Uploading ${f.name}…`);
        await uploadLocalFile(f, cwd);
      }
      toast.success(`Uploaded ${files.length} file(s)`);
      void load(cwd);
    } catch (err) {
      toast.error(`Upload failed: ${errorMessage(err)}`);
    } finally {
      setTransferring(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear if dragging out of currentTarget
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    // Case 1: Drop from another DevNest remote FileBrowserPanel
    const remoteData = e.dataTransfer.getData(DEVNEST_FILE_DRAG);
    if (remoteData) {
      try {
        const payload = JSON.parse(remoteData) as {
          sourceDeviceId: string;
          sourcePath: string;
          name: string;
          isDir: boolean;
        };

        if (payload.isDir) {
          toast.warn(
            "Folder transfer is currently not supported. Please transfer individual files.",
          );
          return;
        }

        if (
          payload.sourceDeviceId === deviceId &&
          payload.sourcePath.startsWith(cwd)
        ) {
          toast.info("Source and destination are the same");
          return;
        }

        setTransferring(true);
        toast.info(`Transferring ${payload.name}…`);

        // Download bytes from source device
        const bytes = await invoke<number[]>("sftp_download_file_bytes", {
          deviceId: payload.sourceDeviceId,
          path: payload.sourcePath,
        });

        // Upload bytes to destination device
        const targetPath = cwd.replace(/\/?$/, "/") + payload.name;
        await invoke("sftp_upload_file_bytes", {
          deviceId,
          path: targetPath,
          data: bytes,
        });

        toast.success(`Transferred ${payload.name} successfully`);
        void load(cwd);
      } catch (err) {
        toast.error(`Transfer failed: ${errorMessage(err)}`);
      } finally {
        setTransferring(false);
      }
      return;
    }

    // Case 2: Drop from local operating system
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      setTransferring(true);
      try {
        for (const file of files) {
          toast.info(`Uploading ${file.name}…`);
          await uploadLocalFile(file, cwd);
        }
        toast.success(`Uploaded ${files.length} file(s)`);
        void load(cwd);
      } catch (err) {
        toast.error(`Drop upload failed: ${errorMessage(err)}`);
      } finally {
        setTransferring(false);
      }
    }
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col fade-up">
        <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 text-xs">
          <span className="font-mono text-(--color-fg-muted)">
            {editing.path}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded border border-(--color-border) px-2 py-1 hover:bg-(--color-surface-2) transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={saveFile}
              disabled={saving}
              className="rounded bg-(--color-accent) px-2 py-1 text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
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
    <div
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="relative flex h-full flex-col select-none overflow-hidden outline-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input for Upload button */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        multiple
        className="hidden"
      />

      {/* Drag & Drop Visual Overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-(--color-accent) bg-(--color-bg)/90 backdrop-blur-xs">
          <span className="text-3xl">📥</span>
          <div className="text-sm font-semibold text-(--color-fg)">
            Drop files here to upload to
          </div>
          <div className="font-mono text-xs text-(--color-accent)">{cwd}</div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2 text-xs">
        <button
          onClick={goUp}
          disabled={cwd === "/"}
          title="Go to parent folder"
          aria-label="Up"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-fg-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>

        {/* View switcher */}
        <div className="flex shrink-0 rounded-md bg-(--color-surface-2) p-0.5">
          {(
            [
              ["files", "Files", FolderOpen],
              ["diskUsage", "Disk Usage", HardDrive],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                viewMode === mode
                  ? "bg-(--color-bg) text-(--color-fg) shadow-sm"
                  : "text-(--color-fg-muted) hover:text-(--color-fg)"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Breadcrumbs */}
        <nav className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-md bg-(--color-bg) px-2 py-1 font-mono [scrollbar-width:none]">
          <button
            onClick={() => void load("/")}
            title="Root"
            className="flex shrink-0 items-center rounded px-1 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          {crumbs.map((c, i) => (
            <span key={crumbPath(i)} className="flex shrink-0 items-center">
              <ChevronRight className="h-3 w-3 text-(--color-fg-muted)/60" />
              <button
                onClick={() => void load(crumbPath(i))}
                className={`rounded px-1 hover:bg-(--color-surface-2) ${
                  i === crumbs.length - 1
                    ? "font-semibold text-(--color-fg)"
                    : "text-(--color-fg-muted) hover:text-(--color-fg)"
                }`}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {(loading || transferring) && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-(--color-accent) border-t-transparent" />
          )}
          {viewMode === "files" && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--color-fg-muted)" />
                <input
                  ref={filterRef}
                  value={filter}
                  onChange={(ev) => setFilter(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Escape") {
                      setFilter("");
                      ev.currentTarget.blur();
                    } else if (ev.key === "Enter") {
                      openFirstMatch();
                    }
                  }}
                  placeholder="Filter files…"
                  spellCheck={false}
                  className="w-44 select-text rounded-md bg-(--color-bg) py-1 pl-7 pr-6 text-xs outline-none ring-1 ring-(--color-border) transition-shadow focus:ring-(--color-accent)"
                />
                {filter && (
                  <button
                    onClick={() => {
                      setFilter("");
                      filterRef.current?.focus();
                    }}
                    title="Clear filter"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-(--color-fg-muted) hover:text-(--color-fg)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <IconButton
                title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                )}
              </IconButton>
              <IconButton title="Refresh" onClick={() => void load(cwd)}>
                <RefreshCw className="h-4 w-4" />
              </IconButton>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={transferring}
                title="Upload files from your computer"
                className="flex items-center gap-1.5 rounded-md bg-(--color-accent) px-2.5 py-1 font-medium text-(--color-accent-fg) transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                Upload
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main View Area */}
      {viewMode === "diskUsage" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiskUsageTreemap
            deviceId={deviceId}
            path={cwd}
            onNavigate={(newPath) => {
              void load(newPath);
              setViewMode("files");
            }}
          />
        </div>
      ) : loading && entries.length === 0 ? (
        <SkeletonTable rows={8} cols={5} />
      ) : error ? (
        <div className="fade-up flex flex-1 items-center justify-center text-sm text-(--color-error)">
          {error}
        </div>
      ) : (
        <>
          <div
            className="flex-1 overflow-auto transition-opacity duration-150"
            style={{ opacity: loading ? 0.5 : 1 }}
          >
            <table className="w-full table-fixed text-xs">
              <thead className="sticky top-0 z-10 bg-(--color-bg) text-left text-[11px] uppercase tracking-wide text-(--color-fg-muted)">
                <tr className="border-b border-(--color-border)">
                  {(
                    [
                      ["name", "Name", "w-auto"],
                      ["size", "Size", "w-24"],
                      ["modified", "Modified", "w-32"],
                    ] as const
                  ).map(([key, label, w]) => (
                    <th key={key} className={`px-3 py-2 font-medium ${w}`}>
                      <button
                        onClick={() => toggleSort(key)}
                        className="flex items-center gap-1 uppercase tracking-wide hover:text-(--color-fg)"
                      >
                        {label}
                        {sort.key === key &&
                          (sort.asc ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                  ))}
                  <th className="hidden w-20 px-3 py-2 font-medium md:table-cell">
                    Perms
                  </th>
                  <th className="w-28 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-12 text-center text-(--color-fg-muted)"
                    >
                      {q ? `No files match "${filter}"` : "Empty directory"}
                    </td>
                  </tr>
                )}
                {visible.map((e, i) => (
                  <tr
                    key={e.path}
                    draggable
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData(
                        DEVNEST_FILE_DRAG,
                        JSON.stringify({
                          sourceDeviceId: deviceId,
                          sourcePath: e.path,
                          name: e.name,
                          isDir: e.isDir,
                        }),
                      );
                      ev.dataTransfer.effectAllowed = "copyMove";
                    }}
                    onDoubleClick={() =>
                      e.isDir ? navigate(e) : void openEditor(e)
                    }
                    className="group row-animate cursor-default border-b border-(--color-border) transition-colors hover:bg-(--color-surface)"
                    style={{ animationDelay: `${Math.min(i, 20) * 20}ms` }}
                  >
                    <td className="px-3 py-1.5 align-middle">
                      <div className="flex items-center gap-2.5">
                        <EntryIcon entry={e} />
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
                            className="select-text rounded border border-(--color-accent) bg-(--color-bg) px-1.5 py-0.5 text-xs outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => navigate(e)}
                            className={`truncate text-left ${
                              e.isDir
                                ? "font-medium text-(--color-fg) hover:text-(--color-accent)"
                                : "text-(--color-fg)"
                            } ${e.name.startsWith(".") ? "opacity-60" : ""}`}
                          >
                            {e.name}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 align-middle tabular-nums text-(--color-fg-muted)">
                      {e.isDir ? "" : fmtSize(e.size)}
                    </td>
                    <td className="px-3 py-1.5 align-middle text-(--color-fg-muted)">
                      {fmtDate(e.modified)}
                    </td>
                    <td className="hidden px-3 py-1.5 align-middle font-mono text-(--color-fg-muted)/70 md:table-cell">
                      {e.permissions}
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        {e.isDir ? (
                          <IconButton
                            title="Scan disk usage"
                            onClick={() => {
                              setCwd(e.path);
                              saveCwd(deviceId, e.path);
                              setViewMode("diskUsage");
                            }}
                          >
                            <ScanLine className="h-3.5 w-3.5" />
                          </IconButton>
                        ) : (
                          <IconButton
                            title="Edit"
                            onClick={() => void openEditor(e)}
                          >
                            <FileCode className="h-3.5 w-3.5" />
                          </IconButton>
                        )}
                        <IconButton
                          title="Rename"
                          onClick={() =>
                            setRenaming({ entry: e, name: e.name })
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          title="Delete"
                          danger
                          onClick={() => void deleteEntry(e)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-surface) px-3 py-1 text-[11px] text-(--color-fg-muted)">
            <span>
              {visible.length}
              {q || !showHidden ? ` of ${entries.length}` : ""} items
            </span>
            <span>
              Drag to transfer · type to filter
            </span>
          </div>
        </>
      )}
    </div>
  );
}
