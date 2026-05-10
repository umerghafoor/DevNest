import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface Props {
  deviceId: string;
  // Each unique instanceId gets its own PTY session. Lets you have
  // multiple terminal panes open for the same device simultaneously.
  instanceId?: string;
}

export function TerminalPanel({ deviceId, instanceId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const termIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Use instanceId (or deviceId) as the key so that splitting a terminal
  // pane creates a genuinely separate PTY rather than reusing an existing one.
  const sessionKey = instanceId ?? deviceId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: {
        background:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--color-bg")
            .trim() || "#0b0d10",
        foreground:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--color-fg")
            .trim() || "#e6edf3",
        cursor: "#e6edf3",
        black: "#0b0d10",
        brightBlack: "#6e7681",
      },
      fontFamily: '"Cascadia Code", "Fira Code", "Jetbrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitAddonRef.current = fit;

    let termId: string | null = null;
    let unlisten: (() => void) | null = null;

    const start = async () => {
      const { cols, rows } = term;
      termId = await invoke<string>("terminal_open", {
        deviceId,
        cols,
        rows,
      });
      termIdRef.current = termId;

      unlisten = await listen<string>(`terminal:${termId}`, (evt) => {
        const binary = atob(evt.payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);
      });

      term.onData((data) => {
        if (!termId) return;
        const encoded = btoa(
          String.fromCharCode(...new TextEncoder().encode(data)),
        );
        void invoke("terminal_write", { termId, data: encoded });
      });

      term.onResize(({ cols: c, rows: r }) => {
        if (!termId) return;
        void invoke("terminal_resize", { termId, cols: c, rows: r });
      });
    };

    void start();

    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      unlisten?.();
      if (termId) void invoke("terminal_close", { termId });
      term.dispose();
    };
    // sessionKey changes → new PTY. deviceId change is implied by sessionKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, deviceId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-(--color-bg) p-2"
      style={{ fontVariantLigatures: "none" }}
    />
  );
}
