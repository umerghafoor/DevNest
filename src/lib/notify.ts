import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionCache: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionCache !== null) return permissionCache;
  try {
    if (await isPermissionGranted()) {
      permissionCache = true;
      return true;
    }
    const result = await requestPermission();
    permissionCache = result === "granted";
    return permissionCache;
  } catch {
    permissionCache = false;
    return false;
  }
}

/**
 * Notify the user that a long-running command finished. Suppressed when
 * the app window is currently visible — the in-app toast/visual cue is
 * enough in that case.
 *
 * Fire-and-forget; never throws.
 */
export function notifyCompleted(title: string, body?: string): void {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  ) {
    return;
  }
  void (async () => {
    try {
      if (!(await ensurePermission())) return;
      sendNotification({ title, body });
    } catch {
      // ignore — notifications are best-effort
    }
  })();
}
