import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { MainPanel } from "../components/MainPanel";
import { StatusBar } from "../components/StatusBar";
import { TitleBar } from "../components/TitleBar";
import { SudoPasswordDialog } from "../components/SudoPasswordDialog";
import { api } from "../lib/api";
import {
  useAppStore,
  selectActiveWorkspace,
  findPaneInTree,
} from "../store/app-store";
import { useThemeStore } from "../store/theme-store";

export function App() {
  const setDevices = useAppStore((s) => s.setDevices);
  const initTheme = useThemeStore((s) => s.init);
  const ws = useAppStore(selectActiveWorkspace);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);

  useEffect(() => {
    initTheme();
    api
      .listDevices()
      .then(setDevices)
      .catch((e) => console.error("listDevices failed", e));
  }, [initTheme, setDevices]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const { activePaneId, paneRoot } = ws;

      if (e.key === "w" && activePaneId) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if ((e.target as HTMLElement).closest(".xterm")) return;
        e.preventDefault();
        closePane(activePaneId);
        return;
      }

      if (e.key === "\\" && activePaneId && activeDeviceId && paneRoot) {
        e.preventDefault();
        const pane = findPaneInTree(paneRoot, activePaneId);
        if (!pane) return;
        const uid = Math.random().toString(36).slice(2, 10);
        splitPane(activePaneId, "horizontal", {
          id: uid,
          instanceId: uid,
          deviceId: activeDeviceId,
          panel: pane.panel,
        });
        return;
      }

      if (e.key === "-" && activePaneId && activeDeviceId && paneRoot) {
        e.preventDefault();
        const pane = findPaneInTree(paneRoot, activePaneId);
        if (!pane) return;
        const uid = Math.random().toString(36).slice(2, 10);
        splitPane(activePaneId, "vertical", {
          id: uid,
          instanceId: uid,
          deviceId: activeDeviceId,
          panel: pane.panel,
        });
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ws, activeDeviceId, closePane, splitPane]);

  return (
    <div className="flex h-screen w-screen flex-col bg-(--color-bg) text-(--color-fg) overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar />
        <MainPanel />
      </div>
      <StatusBar />
      <SudoPasswordDialog />
    </div>
  );
}
