import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { MainPanel } from "../components/MainPanel";
import { StatusBar } from "../components/StatusBar";
import { SudoPasswordDialog } from "../components/SudoPasswordDialog";
import { api } from "../lib/api";
import { useAppStore } from "../store/app-store";
import { useThemeStore } from "../store/theme-store";

export function App() {
  const setDevices = useAppStore((s) => s.setDevices);
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    initTheme();
    api
      .listDevices()
      .then(setDevices)
      .catch((e) => console.error("listDevices failed", e));
  }, [initTheme, setDevices]);

  return (
    <div className="flex h-screen w-screen flex-col bg-(--color-bg) text-(--color-fg)">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainPanel />
      </div>
      <StatusBar />
      <SudoPasswordDialog />
    </div>
  );
}
