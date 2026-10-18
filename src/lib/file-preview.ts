/**
 * Which viewer a file gets in the Files preview, from its extension and,
 * for unknown ones, its first bytes.
 */

export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "json"
  | "csv"
  | "html"
  | "text"
  | "binary";

const BY_EXT: Record<string, PreviewKind> = {};
const add = (kind: PreviewKind, exts: string) =>
  exts.split(" ").forEach((e) => (BY_EXT[e] = kind));
add("image", "png jpg jpeg gif webp bmp ico svg avif apng tif tiff heic");
add("video", "mp4 m4v webm mov ogv mkv");
add("audio", "mp3 wav ogg oga m4a aac flac opus");
add("pdf", "pdf");
add("markdown", "md markdown mdx");
add("json", "json jsonc json5 geojson ipynb");
add("csv", "csv tsv");
add("html", "html htm xhtml");
// Formats that are binary even though nothing else here handles them.
add(
  "binary",
  "zip gz tgz bz2 xz 7z rar tar jar war deb rpm dmg iso exe dll so dylib o a bin class pyc wasm sqlite db woff woff2 ttf otf eot psd",
);

export const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  apng: "image/apng",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  pdf: "application/pdf",
};

export function extOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Sniff the first bytes: magic numbers, then "is it readable text". */
export function sniff(head: Uint8Array): PreviewKind {
  const starts = (...sig: number[]) => sig.every((b, i) => head[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image"; // PNG
  if (starts(0xff, 0xd8, 0xff)) return "image"; // JPEG
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image"; // GIF
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf"; // %PDF
  if (starts(0x49, 0x44, 0x33)) return "audio"; // ID3 (mp3)
  return looksLikeText(head) ? "text" : "binary";
}

/** No NUL bytes and mostly printable / valid UTF-8 in the sample. */
export function looksLikeText(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // A sample cut mid-character fails too: allow a few odd bytes.
    let odd = 0;
    for (const b of sample) if (b < 9 || (b > 13 && b < 32)) odd++;
    return odd / Math.max(1, sample.length) < 0.02;
  }
}

/** The viewer for a file: extension first, else sniffed from its bytes. */
export function previewKind(name: string, head?: Uint8Array): PreviewKind {
  const byExt = BY_EXT[extOf(name)];
  if (byExt) return byExt;
  return head ? sniff(head) : "text";
}

/** Kinds that need the whole file (media) rather than its first part. */
export function needsWholeFile(kind: PreviewKind) {
  return (
    kind === "image" || kind === "video" || kind === "audio" || kind === "pdf"
  );
}

/** Split CSV/TSV text into rows, honouring "quoted, cells". */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Classic hex dump: offset, 16 bytes in hex, then printable ASCII. */
export function hexDump(bytes: Uint8Array, max = 4096) {
  const out: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(chunk, (b) =>
      b >= 32 && b < 127 ? String.fromCharCode(b) : ".",
    ).join("");
    out.push(`${off.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return out.join("\n");
}
