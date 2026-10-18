import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpCircle } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { checkForUpdates, useUpdateStore } from "../lib/updates";

export function StatusBar() {
  const [version, setVersion] = useState<string>("…");
  const deviceCount = useAppStore((s) => s.devices.length);
  const connectedCount = useAppStore(
    (s) => Object.values(s.statuses).filter((x) => x === "connected").length,
  );
  const update = useUpdateStore((s) => s.available);
  const checking = useUpdateStore((s) => s.checking);

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
      {update ? (
        <button
          onClick={() => void openUrl(update.url)}
          title={`DevNest ${update.version} is out — open the release page`}
          className="flex items-center gap-1 rounded-full bg-(--color-accent)/15 px-2 font-medium text-(--color-accent) hover:bg-(--color-accent)/25"
        >
          <ArrowUpCircle size={11} />
          Update to v{update.version}
        </button>
      ) : (
        <button
          onClick={() => void checkForUpdates(true)}
          title="Check for a new version"
          className="hover:text-(--color-fg)"
        >
          v{version}
          {checking ? " · checking…" : ""}
        </button>
      )}
    </footer>
  );
}
