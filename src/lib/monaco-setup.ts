// Wire up Monaco workers so the editor loads entirely from the local bundle
// rather than `@monaco-editor/react`'s CDN default. SQL has no dedicated
// worker — the generic `editor.worker` covers syntax highlighting.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
