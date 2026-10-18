import { describe, expect, it } from "vitest";
import {
  hexDump,
  looksLikeText,
  parseDelimited,
  previewKind,
} from "./file-preview";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("file preview", () => {
  it("picks a viewer by extension", () => {
    expect(previewKind("a.PNG")).toBe("image");
    expect(previewKind("clip.mov")).toBe("video");
    expect(previewKind("song.flac")).toBe("audio");
    expect(previewKind("doc.pdf")).toBe("pdf");
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("data.json")).toBe("json");
    expect(previewKind("t.tsv")).toBe("csv");
    expect(previewKind("index.html")).toBe("html");
    expect(previewKind("app.zip")).toBe("binary");
  });

  it("sniffs files without a known extension", () => {
    expect(previewKind("Makefile", text("all:\n\tcc x.c\n"))).toBe("text");
    expect(previewKind("blob", bytes(0x89, 0x50, 0x4e, 0x47, 0))).toBe("image");
    expect(previewKind("blob", bytes(0x25, 0x50, 0x44, 0x46))).toBe("pdf");
    expect(previewKind("blob", bytes(1, 2, 0, 4))).toBe("binary");
    expect(looksLikeText(text("héllo wörld"))).toBe(true);
  });

  it("parses CSV with quotes", () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\n', ",")).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(parseDelimited("a\tb\r\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("hex dumps", () => {
    const d = hexDump(text("Hi!\n"));
    expect(d.startsWith("00000000  48 69 21 0a")).toBe(true);
    expect(d.endsWith("Hi!.")).toBe(true);
  });
});
