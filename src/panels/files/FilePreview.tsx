import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Download,
  Eye,
  FileCode,
  X,
} from "lucide-react";
import { errorMessage } from "../../lib/api";
import {
  MIME,
  extOf,
  hexDump,
  needsWholeFile,
  parseDelimited,
  previewKind,
  type PreviewKind,
} from "../../lib/file-preview";
import { SafeMarkdown } from "../../components/SafeMarkdown";

/** Text-like previews read this much of the file. */
const TEXT_MAX = 2 * 1024 * 1024;
/** Media must be read whole; bigger files are offered as a download. */
const MEDIA_MAX = 64 * 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_ROWS = 1_000;

export interface PreviewFile {
  name: string;
  path: string;
  size: number;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "tooBig"; kind: PreviewKind }
  | {
      state: "ready";
      kind: PreviewKind;
      bytes: Uint8Array;
      truncated: boolean;
    };

/**
 * Quick Look for the Files panel: images, video, audio, PDF, Markdown,
 * JSON, CSV/TSV, HTML (sandboxed, no scripts), any text with line numbers,
 * and a hex dump for everything else. ←/→ step through the folder's files.
 */
export function FilePreview({
  deviceId,
  files,
  index,
  onIndex,
  onClose,
  onDownload,
  onEdit,
}: {
  deviceId: string;
  files: PreviewFile[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDownload: (f: PreviewFile) => void;
  onEdit: (f: PreviewFile) => void;
}) {
  const file = files[index];
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    if (!file) return;
    let stale = false;
    const guess = previewKind(file.name);
    const whole = needsWholeFile(guess);
    if (whole && file.size > MEDIA_MAX) {
      setLoaded({ state: "tooBig", kind: guess });
      return;
    }
    setLoaded({ state: "loading" });
    const max = whole ? MEDIA_MAX : TEXT_MAX;
    invoke<ArrayBuffer>("file_preview", {
      deviceId,
      path: file.path,
      maxBytes: max,
    })
      .then((buf) => {
        if (stale) return;
        const bytes = new Uint8Array(buf);
        const kind = previewKind(file.name, bytes);
        if (needsWholeFile(kind) && file.size > bytes.length) {
          setLoaded({ state: "tooBig", kind });
          return;
        }
        setLoaded({
          state: "ready",
          kind,
          bytes,
          truncated: file.size > bytes.length,
        });
      })
      .catch((e) => {
        if (!stale) setLoaded({ state: "error", message: errorMessage(e) });
      });
    return () => {
      stale = true;
    };
  }, [deviceId, file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onIndex(index - 1);
      } else if (e.key === "ArrowRight" && index < files.length - 1) {
        e.preventDefault();
        onIndex(index + 1);
      }
    };
    // Capture: the file list underneath also listens for arrows.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, files.length, onIndex, onClose]);

  if (!file) return null;
  const kind =
    loaded.state === "ready" || loaded.state === "tooBig"
      ? loaded.kind
      : previewKind(file.name);
  const textual = !needsWholeFile(kind) && kind !== "binary";

  const navBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-30";

  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="modal-content flex h-[88vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-xl border border-(--color-border) bg-(--color-bg) text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-2">
          <button
            className={navBtn}
            disabled={index === 0}
            onClick={() => onIndex(index - 1)}
            title="Previous file (←)"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className={navBtn}
            disabled={index >= files.length - 1}
            onClick={() => onIndex(index + 1)}
            title="Next file (→)"
          >
            <ChevronRight size={15} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={file.path}>
              {file.name}
            </div>
            <div className="truncate text-[10px] text-(--color-fg-muted)">
              {fmtSize(file.size)} · {KIND_LABEL[kind]}
              {files.length > 1 && ` · ${index + 1} of ${files.length}`}
            </div>
          </div>
          {textual && (
            <button
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
              onClick={() => onEdit(file)}
              title="Open in the editor"
            >
              <FileCode size={13} /> Edit
            </button>
          )}
          <button
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            onClick={() => onDownload(file)}
            title="Download to this computer"
          >
            <Download size={13} /> Download
          </button>
          <button className={navBtn} onClick={onClose} title="Close (Esc)">
            <X size={15} />
          </button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {loaded.state === "loading" ? (
            <Center>Loading…</Center>
          ) : loaded.state === "error" ? (
            <Center error>{loaded.message}</Center>
          ) : loaded.state === "tooBig" ? (
            <Center>
              <span>
                {file.name} is {fmtSize(file.size)} — too large to preview here.
              </span>
              <button
                className="mt-2 flex h-7 items-center gap-1.5 rounded-md bg-(--color-accent) px-3 font-medium text-(--color-accent-fg) hover:opacity-90"
                onClick={() => onDownload(file)}
              >
                <Download size={13} /> Download instead
              </button>
            </Center>
          ) : (
            <Viewer file={file} kind={loaded.kind} bytes={loaded.bytes} />
          )}
          {loaded.state === "ready" && loaded.truncated && (
            <div className="absolute right-3 bottom-3 rounded-md bg-(--color-surface) px-2 py-1 text-[10px] text-(--color-fg-muted) shadow">
              Showing the first {fmtSize(loaded.bytes.length)} of{" "}
              {fmtSize(file.size)}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const KIND_LABEL: Record<PreviewKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  markdown: "Markdown",
  json: "JSON",
  csv: "Table",
  html: "HTML",
  text: "Text",
  binary: "Binary",
};

function Viewer({
  file,
  kind,
  bytes,
}: {
  file: PreviewFile;
  kind: PreviewKind;
  bytes: Uint8Array;
}) {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
    case "pdf":
      return <MediaViewer file={file} kind={kind} bytes={bytes} />;
    case "markdown":
      return <MarkdownViewer text={decode(bytes)} />;
    case "json":
      return <JsonViewer text={decode(bytes)} />;
    case "csv":
      return (
        <TableViewer
          text={decode(bytes)}
          sep={extOf(file.name) === "tsv" ? "\t" : ","}
        />
      );
    case "html":
      return <HtmlViewer text={decode(bytes)} />;
    case "text":
      return <TextViewer text={decode(bytes)} />;
    case "binary":
      return <BinaryViewer bytes={bytes} />;
  }
}

function MediaViewer({
  file,
  kind,
  bytes,
}: {
  file: PreviewFile;
  kind: "image" | "video" | "audio" | "pdf";
  bytes: Uint8Array;
}) {
  const [actual, setActual] = useState(false);
  const url = useMemo(() => {
    const type = MIME[extOf(file.name)] ?? "";
    return URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
    );
  }, [bytes, file.name]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (kind === "image")
    return (
      <div
        className={`checkerboard flex h-full w-full ${actual ? "overflow-auto" : "items-center justify-center p-4"}`}
        onClick={() => setActual((v) => !v)}
        title={actual ? "Fit to window" : "Actual size"}
      >
        {/* SVGs load as images: scripts inside them don't run. */}
        <img
          src={url}
          alt={file.name}
          className={
            actual
              ? "m-auto max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain"
          }
        />
      </div>
    );
  if (kind === "video")
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <video src={url} controls className="max-h-full max-w-full" />
      </div>
    );
  if (kind === "audio")
    return (
      <Center>
        <span className="mb-3 font-medium text-(--color-fg)">{file.name}</span>
        <audio src={url} controls className="w-[min(480px,90%)]" />
      </Center>
    );
  return <iframe src={url} title={file.name} className="h-full w-full" />;
}

function MarkdownViewer({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <Toggleable source={source} onToggle={() => setSource((v) => !v)}>
      {source ? (
        <TextViewer text={text} />
      ) : (
        <div className="h-full overflow-auto px-8 py-6">
          <SafeMarkdown text={text} className="agent-md mx-auto max-w-3xl" />
        </div>
      )}
    </Toggleable>
  );
}

function HtmlViewer({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <Toggleable source={source} onToggle={() => setSource((v) => !v)}>
      {source ? (
        <TextViewer text={text} />
      ) : (
        // Empty sandbox: no scripts, forms, popups or same-origin access.
        <iframe
          sandbox=""
          srcDoc={text}
          title="HTML preview"
          className="h-full w-full bg-white"
        />
      )}
    </Toggleable>
  );
}

/** Rendered view with a Source toggle in the corner. */
function Toggleable({
  source,
  onToggle,
  children,
}: {
  source: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative h-full">
      {children}
      <button
        onClick={onToggle}
        className="absolute top-2 right-3 flex h-7 items-center gap-1.5 rounded-md border border-(--color-border) bg-(--color-surface) px-2 text-(--color-fg-muted) shadow-sm hover:text-(--color-fg)"
      >
        {source ? <Eye size={13} /> : <Code size={13} />}
        {source ? "Rendered" : "Source"}
      </button>
    </div>
  );
}

function JsonViewer({ text }: { text: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text; // JSONC, truncated or invalid: show as-is.
    }
  }, [text]);
  return <TextViewer text={pretty} />;
}

function TableViewer({ text, sep }: { text: string; sep: string }) {
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  if (rows.length === 0) return <Center>Empty file.</Center>;
  const [head, ...body] = rows;
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse">
        <thead className="sticky top-0 bg-(--color-surface)">
          <tr>
            <th className="border-b border-(--color-border) px-2 py-1.5 text-right font-normal text-(--color-fg-muted)">
              #
            </th>
            {head.map((h, i) => (
              <th
                key={i}
                className="border-b border-(--color-border) px-3 py-1.5 text-left font-semibold whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_ROWS).map((r, ri) => (
            <tr key={ri} className="hover:bg-(--color-surface)">
              <td className="border-b border-(--color-border) px-2 py-1 text-right text-(--color-fg-muted) tabular-nums">
                {ri + 1}
              </td>
              {head.map((_, ci) => (
                <td
                  key={ci}
                  className="max-w-80 truncate border-b border-(--color-border) px-3 py-1"
                  title={r[ci]}
                >
                  {r[ci]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_ROWS && (
        <p className="p-3 text-center text-(--color-fg-muted)">
          First {MAX_ROWS.toLocaleString()} of {body.length.toLocaleString()}{" "}
          rows.
        </p>
      )}
    </div>
  );
}

function TextViewer({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n").slice(0, MAX_LINES), [text]);
  const width = String(lines.length).length;
  return (
    <div className="h-full overflow-auto bg-(--color-bg) py-2 font-mono text-[12px] leading-[1.6]">
      {lines.map((l, i) => (
        <div key={i} className="flex hover:bg-(--color-surface)">
          <span
            className="shrink-0 pr-3 pl-3 text-right text-(--color-fg-muted)/60 select-none"
            style={{ width: `${width + 3}ch` }}
          >
            {i + 1}
          </span>
          <span className="pr-4 break-all whitespace-pre-wrap">{l || " "}</span>
        </div>
      ))}
    </div>
  );
}

function BinaryViewer({ bytes }: { bytes: Uint8Array }) {
  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-3 text-(--color-fg-muted)">
        Binary file — first {Math.min(bytes.length, 4096).toLocaleString()}{" "}
        bytes:
      </p>
      <pre className="font-mono text-[11px] leading-relaxed whitespace-pre">
        {hexDump(bytes)}
      </pre>
    </div>
  );
}

function Center({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center p-6 text-center ${error ? "text-(--color-error)" : "text-(--color-fg-muted)"}`}
    >
      {children}
    </div>
  );
}

function decode(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}

function fmtSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
