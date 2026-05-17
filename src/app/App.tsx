import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { MainPanel } from "../components/MainPanel";
import { StatusBar } from "../components/StatusBar";
import { TitleBar } from "../components/TitleBar";
import { SudoPasswordDialog } from "../components/SudoPasswordDialog";
import { ToastContainer } from "../components/Toast";
import { ConfirmDialogHost } from "../components/ConfirmDialog";
import { api } from "../lib/api";
import {
  useAppStore,
  selectActiveWorkspace,
  findPaneInTree,
} from "../store/app-store";
import { useThemeStore } from "../store/theme-store";
import { useUiStore } from "../store/ui-store";
import { useColorsStore } from "../store/colors-store";
import {
  useShortcutsStore,
  matchesBinding,
  type ShortcutId,
} from "../store/shortcuts-store";

export function App() {
  const setDevices = useAppStore((s) => s.setDevices);
  const initTheme = useThemeStore((s) => s.init);
  const initUi = useUiStore((s) => s.init);
  const initColors = useColorsStore((s) => s.init);
  const reapplyColors = useColorsStore((s) => s.reapply);
  const themeValue = useThemeStore((s) => s.theme);
  const ws = useAppStore(selectActiveWorkspace);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const openPane = useAppStore((s) => s.openPane);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const getBinding = useShortcutsStore((s) => s.getBinding);

  useEffect(() => {
    initTheme();
    initUi();
    initColors();
    api
      .listDevices()
      .then(setDevices)
      .catch((e) => console.error("listDevices failed", e));
  }, [initTheme, initUi, initColors, setDevices]);

  // Re-apply color overrides whenever the active theme (light/dark) changes,
  // since each mode has its own override map.
  useEffect(() => {
    reapplyColors();
  }, [themeValue, reapplyColors]);

  // Global keyboard shortcuts driven by the customizable shortcut registry.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement | null)?.closest?.(".xterm");

      const matches = (id: ShortcutId) => matchesBinding(e, getBinding(id));
      const { activePaneId, paneRoot } = ws;
      const splitWith = (dir: "horizontal" | "vertical") => {
        if (!activePaneId || !activeDeviceId || !paneRoot) return false;
        const pane = findPaneInTree(paneRoot, activePaneId);
        if (!pane) return false;
        const uid = Math.random().toString(36).slice(2, 10);
        splitPane(activePaneId, dir, {
          id: uid,
          instanceId: uid,
          deviceId: activeDeviceId,
          panel: pane.panel,
        });
        return true;
      };

      if (matches("closePane")) {
        if (inEditable || !activePaneId) return;
        e.preventDefault();
        closePane(activePaneId);
      } else if (matches("splitHorizontal")) {
        if (splitWith("horizontal")) e.preventDefault();
      } else if (matches("splitVertical")) {
        if (splitWith("vertical")) e.preventDefault();
      } else if (matches("newWorkspace")) {
        e.preventDefault();
        addWorkspace();
      } else if (matches("openSettings")) {
        e.preventDefault();
        const uid = Math.random().toString(36).slice(2, 10);
        openPane({
          id: uid,
          instanceId: uid,
          deviceId: activeDeviceId ?? "local",
          panel: "settings",
        });
      } else if (matches("openDashboard")) {
        e.preventDefault();
        const uid = Math.random().toString(36).slice(2, 10);
        openPane({
          id: uid,
          instanceId: uid,
          deviceId: activeDeviceId ?? "local",
          panel: "dashboard",
        });
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    ws,
    activeDeviceId,
    closePane,
    splitPane,
    openPane,
    addWorkspace,
    getBinding,
  ]);

  return (
    <div className="flex h-screen w-screen flex-col bg-(--color-bg) text-(--color-fg) overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar />
        <MainPanel />
      </div>
      <StatusBar />
      <SudoPasswordDialog />
      <ConfirmDialogHost />
      <ToastContainer />
    </div>
  );
}
