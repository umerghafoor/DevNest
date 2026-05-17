import { useEffect, useMemo, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  StreamLanguage,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { toml as legacyToml } from "@codemirror/legacy-modes/mode/toml";
import { properties as legacyIni } from "@codemirror/legacy-modes/mode/properties";
import { oneDark } from "@codemirror/theme-one-dark";
import { useThemeStore } from "../store/theme-store";

export type CodeEditorLanguage = "json" | "yaml" | "toml" | "ini" | "text";

interface Props {
  value: string;
  onChange: (next: string) => void;
  language: CodeEditorLanguage;
  /** Cmd/Ctrl+S handler. */
  onSave?: () => void;
  /** Cmd/Ctrl+Shift+S handler. */
  onSaveAs?: () => void;
  /** Cmd/Ctrl+O handler. */
  onOpen?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Guess a language by file extension. Falls back to "text" (no highlighting).
 */
export function languageFromFilename(
  name: string | null | undefined,
): CodeEditorLanguage {
  if (!name) return "text";
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (
    lower.endsWith(".ini") ||
    lower.endsWith(".conf") ||
    lower.endsWith(".cfg") ||
    lower.endsWith(".env") ||
    lower.endsWith(".properties") ||
    lower.endsWith(".service") ||
    lower.endsWith(".socket") ||
    lower.endsWith(".timer") ||
    lower.endsWith(".target") ||
    lower.endsWith(".mount") ||
    lower.endsWith(".path")
  )
    return "ini";
  return "text";
}

function languageExtension(lang: CodeEditorLanguage) {
  switch (lang) {
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "toml":
      return StreamLanguage.define(legacyToml);
    case "ini":
      return StreamLanguage.define(legacyIni);
    case "text":
      return [];
  }
}

/**
 * Thin CodeMirror 6 wrapper. Stays out of React's reconciliation by owning
 * its own DOM; React sets up the view once and pipes updates in via a
 * Compartment for the language and via dispatching transactions when the
 * `value` prop changes externally.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  onSave,
  onSaveAs,
  onOpen,
  readOnly = false,
  placeholder: _placeholder,
  className = "",
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const themeKind = useThemeStore((s) => s.theme);
  const isDark = useMemo(() => {
    if (themeKind === "dark") return true;
    if (themeKind === "light") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }, [themeKind]);

  // One-time view creation.
  useEffect(() => {
    if (!hostRef.current) return;
    const startState = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: "Mod-s",
            run: () => {
              onSave?.();
              return true;
            },
          },
          {
            key: "Mod-Shift-s",
            run: () => {
              onSaveAs?.();
              return true;
            },
          },
          {
            key: "Mod-o",
            run: () => {
              onOpen?.();
              return true;
            },
          },
        ]),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        langCompartment.of(languageExtension(language)),
        themeCompartment.of(isDark ? oneDark : []),
      ],
    });
    const view = new EditorView({ state: startState, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Language updates (compartment swap, doesn't re-create the view).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.reconfigure(languageExtension(language)),
    });
  }, [language, langCompartment]);

  // Theme updates.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(isDark ? oneDark : []),
    });
  }, [isDark, themeCompartment]);

  // External value updates (file open, scratchpad reset). Skip if the
  // current doc already matches — avoids fighting the user's typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={`h-full min-h-0 overflow-auto ${className}`}
    />
  );
}
