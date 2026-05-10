import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/app-store";

export function StatusBar() {
  const [version, setVersion] = useState<string>("…");
  const deviceCount = useAppStore((s) => s.devices.length);
  const connectedCount = useAppStore(
    (s) => Object.values(s.statuses).filter((x) => x === "connected").length,
  );

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion("?"));
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-(--color-border) bg-(--color-surface) px-3 text-xs text-(--color-fg-muted)">
      <span>
        {connectedCount}/{deviceCount} connected
      </span>
      <span>v{version}</span>
    </footer>
  );
}
