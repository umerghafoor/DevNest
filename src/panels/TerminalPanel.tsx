import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store/app-store";
import { notifyCompleted } from "../lib/notify";
import { terminalRegistry } from "../lib/terminal-registry";

interface Props {
  deviceId: string;
  instanceId?: string;
  /** Typed into the shell once, right after it opens (e.g. an agent login). */
  initialCommand?: string;
}

// Sessions that already ran their initialCommand, so a remount (which may
// reopen the PTY) doesn't run it again.
const ranInitial = new Set<string>();

type ConnectState = "connecting" | "connected" | "error";

const LAST_CMD_PREFIX = "devnest.lastcmd.";

function loadLastCmd(sessionKey: string): string | null {
  try {
    return localStorage.getItem(LAST_CMD_PREFIX + sessionKey);
  } catch {
    return null;
  }
}

function saveLastCmd(sessionKey: string, cmd: string) {
  try {
    localStorage.setItem(LAST_CMD_PREFIX + sessionKey, cmd);
  } catch {
    // ignore
  }
}

// Resolve a CSS color (the app tokens are oklch, which xterm can't parse) to
// a hex string by painting one pixel.
const colorCtx = document
  .createElement("canvas")
  .getContext("2d", { willReadFrequently: true });

function toHex(css: string, fallback: string): string {
  if (!colorCtx || !css) return fallback;
  colorCtx.clearRect(0, 0, 1, 1);
  colorCtx.fillStyle = fallback;
  colorCtx.fillStyle = css;
  colorCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = colorCtx.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function readTerminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const bg = toHex(style.getPropertyValue("--color-bg").trim(), "#0b0d10");
  const fg = toHex(style.getPropertyValue("--color-fg").trim(), "#e6edf3");
  const accent = toHex(
    style.getPropertyValue("--color-accent").trim(),
    "#e0a040",
  );
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    // xterm's default selection is translucent white, which is invisible on
    // a light background. Use the accent at partial opacity in both modes.
    selectionBackground: accent + "99",
    selectionInactiveBackground: accent + "80",
    black: "#0b0d10",
    brightBlack: "#6e7681",
  };
}

// Theme, OS appearance and custom colors all land on <html> as a class or
// inline style, so watching those attributes catches every change.
function watchTerminalTheme(term: Terminal): () => void {
  const mo = new MutationObserver(() => {
    term.options.theme = readTerminalTheme();
  });
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => mo.disconnect();
}

export function TerminalPanel({ deviceId, instanceId, initialCommand }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inputLineRef = useRef<string>("");

  const [connectState, setConnectState] = useState<ConnectState>("connecting");
  const [retryNonce, setRetryNonce] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [lastCmd, setLastCmd] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);

  const sessionKey = instanceId ?? deviceId;

  useEffect(() => {
    setConnectState("connecting");

    const saved = loadLastCmd(sessionKey);
    setLastCmd(saved ?? null);
    setBannerVisible(false);

    const container = containerRef.current;
    if (!container) return;

    const existing = terminalRegistry.get(sessionKey);

    // No existing entry = fresh start (first open or after terminal closed).
    // Show the banner immediately so the user can rerun their last command.
    if (!existing && saved) {
      setBannerVisible(true);
    }

    if (existing) {
      // xterm's open() can only be called once. On re-attach we move the
      // xterm-owned DOM node into the new container instead of re-opening.
      const xtermEl = existing.container?.querySelector(".xterm");
      if (xtermEl) {
        container.appendChild(xtermEl);
      } else {
        existing.term.open(container);
      }
      existing.container = container;
      existing.fit.fit();
      existing.term.options.theme = readTerminalTheme();
      fitAddonRef.current = existing.fit;
      searchAddonRef.current = existing.search;
      setConnectState("connected");
      // Keep the banner only if it hasn't been used or dismissed yet.
      setBannerVisible(existing.showRerunBanner && !!saved);

      const ro = new ResizeObserver(() => existing.fit.fit());
      ro.observe(container);
      const unwatchTheme = watchTerminalTheme(existing.term);
      return () => {
        ro.disconnect();
        unwatchTheme();
      };
    }

    // First mount: create xterm + PTY.
    const term = new Terminal({
      theme: readTerminalTheme(),
      fontFamily: '"Cascadia Code", "Fira Code", "Jetbrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(searchAddon);
    term.open(container);
    fit.fit();
    fitAddonRef.current = fit;
    searchAddonRef.current = searchAddon;

    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.select());
        return false;
      }
      return true;
    });

    let cancelled = false;

    const start = async () => {
      try {
        const { cols, rows } = term;
        const termId = await invoke<string>("terminal_open", {
          deviceId,
          cols,
          rows,
          sessionId: sessionKey,
        });

        if (cancelled) {
          void invoke("terminal_close", { termId });
          return;
        }

        const unlisten = await listen<string>(`terminal:${termId}`, (evt) => {
          const binary = atob(evt.payload);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
          term.write(bytes);
        });

        const unlistenExit = await listen(`terminal-exit:${termId}`, () => {
          const device = useAppStore
            .getState()
            .devices.find((d) => d.id === deviceId);
          notifyCompleted(
            `Terminal closed on ${device?.name ?? deviceId}`,
            "The remote shell exited.",
          );
          // Remove from registry so the next open starts fresh.
          terminalRegistry.destroy(sessionKey);
        });

        term.onData((data) => {
          // Track typed line to persist as last command.
          if (data === "\r" || data === "\n") {
            const line = inputLineRef.current.trim();
            if (line) {
              saveLastCmd(sessionKey, line);
              setLastCmd(line);
              // The banner is only a "resume" hint for a fresh session; once
              // the user runs anything, it's done.
              const e2 = terminalRegistry.get(sessionKey);
              if (e2) e2.showRerunBanner = false;
              setBannerVisible(false);
            }
            inputLineRef.current = "";
          } else if (data === "\x7f") {
            inputLineRef.current = inputLineRef.current.slice(0, -1);
          } else if (data.length === 1 && data >= " ") {
            inputLineRef.current += data;
          }

          const encoded = btoa(
            String.fromCharCode(...new TextEncoder().encode(data)),
          );
          void invoke("terminal_write", { termId, data: encoded });
        });

        term.onResize(({ cols: c, rows: r }) => {
          void invoke("terminal_resize", { termId, cols: c, rows: r });
        });

        terminalRegistry.set(sessionKey, {
          term,
          fit,
          search: searchAddon,
          termId,
          unlisten,
          unlistenExit,
          container,
          showRerunBanner: !!saved,
        });

        setConnectState("connected");

        if (initialCommand && !ranInitial.has(sessionKey)) {
          ranInitial.add(sessionKey);
          const data = btoa(
            String.fromCharCode(
              ...new TextEncoder().encode(initialCommand + "\r"),
            ),
          );
          void invoke("terminal_write", { termId, data });
        }
      } catch {
        if (!cancelled) {
          setConnectState("error");
        }
      }
    };

    void start();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);
    const unwatchTheme = watchTerminalTheme(term);

    return () => {
      cancelled = true;
      ro.disconnect();
      unwatchTheme();
      // Only dispose if this terminal never made it into the registry
      // (i.e. start() was cancelled before completing — e.g. strict-mode).
      // If it's in the registry the registry owns its lifetime.
      if (!terminalRegistry.has(sessionKey)) {
        term.dispose();
      }
    };
  }, [sessionKey, deviceId, retryNonce, initialCommand]);

  const termIdForRerun = terminalRegistry.get(sessionKey)?.termId ?? null;

  const dismissBanner = useCallback(() => {
    const entry = terminalRegistry.get(sessionKey);
    if (entry) entry.showRerunBanner = false;
    setBannerVisible(false);
  }, [sessionKey]);

  const rerunLastCmd = useCallback(() => {
    if (!lastCmd || !termIdForRerun) return;
    dismissBanner();
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(lastCmd + "\r")),
    );
    void invoke("terminal_write", { termId: termIdForRerun, data: encoded });
  }, [lastCmd, termIdForRerun, dismissBanner]);

  const findNext = useCallback(() => {
    if (!search) return;
    searchAddonRef.current?.findNext(search, { incremental: false });
  }, [search]);

  const findPrev = useCallback(() => {
    if (!search) return;
    searchAddonRef.current?.findPrevious(search, { incremental: false });
  }, [search]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchAddonRef.current?.clearDecorations();
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col bg-(--color-bg)">
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs">
          <input
            ref={searchInputRef}
            value={search}
            onChange={(e) => {
              const v = e.target.value;
              setSearch(v);
              if (v) {
                searchAddonRef.current?.findNext(v, { incremental: true });
              } else {
                searchAddonRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrev();
                else findNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Search…"
            className="input flex-1 py-1 text-xs"
          />
          <button
            onClick={findPrev}
            disabled={!search}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={findNext}
            disabled={!search}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}

      {bannerVisible && lastCmd && connectState === "connected" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs">
          <span className="text-(--color-fg-muted)">Last command:</span>
          <code className="flex-1 truncate font-mono text-(--color-fg)">
            {lastCmd}
          </code>
          <button
            onClick={rerunLastCmd}
            className="rounded border border-(--color-accent) px-2 py-0.5 text-(--color-accent) hover:bg-(--color-accent) hover:text-white"
          >
            Re-run
          </button>
          <button
            onClick={dismissBanner}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
          >
            ✕
          </button>
        </div>
      )}

      {/* Padding lives on this wrapper, not the xterm container: FitAddon
          measures the container's full height, so padding there makes it
          over-count rows and clip the last line. */}
      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{
            fontVariantLigatures: "none",
            opacity: connectState === "connected" ? 1 : 0,
            transition: "opacity 0.25s ease",
          }}
        />

        {connectState === "connecting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--color-bg)">
            <span className="h-5 w-5 rounded-full border-2 border-(--color-accent) border-t-transparent animate-spin" />
            <span className="text-xs text-(--color-fg-muted)">
              Opening terminal…
            </span>
          </div>
        )}

        {connectState === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--color-bg) px-6 text-center">
            <button
              onClick={() => {
                setRetryNonce((n) => n + 1);
              }}
              className="rounded border border-(--color-accent) px-3 py-1.5 text-xs text-(--color-accent) hover:bg-(--color-accent) hover:text-white"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
