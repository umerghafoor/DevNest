import { Sidebar } from "../components/Sidebar";
import { MainPanel } from "../components/MainPanel";
import { StatusBar } from "../components/StatusBar";

export function App() {
  return (
    <div className="flex h-screen w-screen flex-col bg-(--color-bg) text-(--color-fg)">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainPanel />
      </div>
      <StatusBar />
    </div>
  );
}
