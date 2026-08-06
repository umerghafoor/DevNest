import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const FLOATING_PANE_QUERY = "floatingPane";
export const FLOATING_WORKSPACE_QUERY = "workspace";

export function floatingPaneWindowLabel(paneId: string): string {
  return `devnest-floating-${paneId}`;
}

export function getFloatingPaneIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(FLOATING_PANE_QUERY);
}

export function getFloatingPaneWorkspaceIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(FLOATING_WORKSPACE_QUERY);
}

export async function openFloatingPaneWindow(
  paneId: string,
  workspaceId: string,
): Promise<void> {
  const label = floatingPaneWindowLabel(paneId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  new WebviewWindow(label, {
    url: `/app.html?${FLOATING_PANE_QUERY}=${encodeURIComponent(paneId)}&${FLOATING_WORKSPACE_QUERY}=${encodeURIComponent(workspaceId)}`,
    title: "DevNest Pane",
    width: 1000,
    height: 720,
    resizable: true,
    decorations: false,
    transparent: false,
  });
}
