import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface Props {
  deviceId: string;
  instanceId?: string;
}

type ConnectState = "connecting" | "connected" | "error";

export function TerminalPanel({ deviceId, instanceId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const termIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [connectState, setConnectState] = useState<ConnectState>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sessionKey = instanceId ?? deviceId;

  useEffect(() => {
    setConnectState("connecting");
    setErrorMsg(null);

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
    let cancelled = false;

    const start = async () => {
      try {
        const { cols, rows } = term;
        termId = await invoke<string>("terminal_open", { deviceId, cols, rows });
        if (cancelled) {
          void invoke("terminal_close", { termId });
          return;
        }
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

        setConnectState("connected");
      } catch (e) {
        if (!cancelled) {
          setConnectState("error");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      }
    };

    // Start in background — the rest of the app is NOT blocked
    void start();

    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlisten?.();
      if (termId) void invoke("terminal_close", { termId });
      term.dispose();
    };
  }, [sessionKey, deviceId]);

  return (
    <div className="relative h-full w-full bg-(--color-bg)">
      {/* xterm container — always mounted so the terminal is ready as soon as the PTY opens */}
      <div
        ref={containerRef}
        className="h-full w-full p-2"
        style={{
          fontVariantLigatures: "none",
          // Hide (but keep alive) until connected so the user sees the overlay
          opacity: connectState === "connected" ? 1 : 0,
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Connecting overlay — rendered on top, doesn't block xterm setup */}
      {connectState === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--color-bg)">
          <span className="h-5 w-5 rounded-full border-2 border-(--color-accent) border-t-transparent animate-spin" />
          <span className="text-xs text-(--color-fg-muted)">Opening terminal…</span>
        </div>
      )}

      {connectState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--color-bg) px-6 text-center">
          <span className="text-sm text-(--color-error)">
            Could not open terminal
          </span>
          {errorMsg && (
            <span className="text-xs text-(--color-fg-muted) font-mono max-w-sm">
              {errorMsg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
