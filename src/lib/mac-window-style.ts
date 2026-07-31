import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Restores native rounded corners + shadow on macOS, which Tauri drops for
 * `decorations: false` windows (tauri-apps/tauri#12042). Also restyles the
 * real traffic-light buttons to sit inside TitleBar's reserved 72px gap.
 */

export interface MacWindowStyleConfig {
  cornerRadius?: number;
  offsetX?: number;
  offsetY?: number;
}

let currentConfig: MacWindowStyleConfig = {};
let unlistenResize: (() => void) | null = null;

export async function repositionMacTrafficLights(): Promise<void> {
  try {
    const window = getCurrentWebviewWindow();
    await invoke("reposition_traffic_lights", {
      window,
      offsetX: currentConfig.offsetX ?? 0,
      offsetY: currentConfig.offsetY ?? 0,
    });
  } catch (error) {
    console.error("Failed to reposition traffic lights:", error);
  }
}

export async function enableMacModernWindowStyle(
  config: MacWindowStyleConfig = {},
): Promise<void> {
  currentConfig = config;
  const window = getCurrentWebviewWindow();

  try {
    await invoke("enable_modern_window_style", {
      window,
      cornerRadius: config.cornerRadius ?? 10,
      offsetX: config.offsetX ?? 0,
      offsetY: config.offsetY ?? 0,
    });
  } catch (error) {
    console.error("Failed to enable macOS modern window style:", error);
    return;
  }

  if (unlistenResize) unlistenResize();
  unlistenResize = await window.onResized(() => {
    void repositionMacTrafficLights();
  });
}
