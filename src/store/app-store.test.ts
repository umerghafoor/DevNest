import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "./app-store";

function activeWs() {
  const s = useAppStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

describe("app-store — panes", () => {
  beforeEach(() => {
    const ws = {
      id: "w1",
      name: "Workspace 1",
      paneRoot: null,
      activePaneId: null,
    };
    useAppStore.setState({
      devices: [],
      statuses: {},
      activeDeviceId: null,
      workspaces: [ws],
      activeWorkspaceId: ws.id,
    });
  });

  it("opens a pane and makes it active", () => {
    useAppStore.getState().openPane({
      id: "p1",
      deviceId: "d1",
      panel: "docker",
      instanceId: "i1",
    });
    expect(activeWs().paneRoot).not.toBeNull();
    expect(activeWs().activePaneId).toBe("p1");
  });

  it("closing the active pane removes it from the tree", () => {
    const { openPane, splitPane, closePane } = useAppStore.getState();
    openPane({ id: "p1", deviceId: "d1", panel: "docker", instanceId: "i1" });
    splitPane("p1", "horizontal", {
      id: "p2",
      deviceId: "d1",
      panel: "metrics",
      instanceId: "i2",
    });
    closePane("p2");
    const root = activeWs().paneRoot;
    expect(root?.type).toBe("leaf");
    expect((root as { type: "leaf"; pane: { id: string } }).pane.id).toBe("p1");
  });

  it("closing last pane empties the tree", () => {
    const { openPane, closePane } = useAppStore.getState();
    openPane({ id: "p1", deviceId: "d1", panel: "docker", instanceId: "i1" });
    closePane("p1");
    expect(activeWs().paneRoot).toBeNull();
    expect(activeWs().activePaneId).toBeNull();
  });

  it("setStatus stores per-device", () => {
    useAppStore.getState().setStatus("d1", "connected");
    useAppStore.getState().setStatus("d2", "error");
    expect(useAppStore.getState().statuses).toEqual({
      d1: "connected",
      d2: "error",
    });
  });

  it("removeDevice cleans up panes across all workspaces", () => {
    const { setStatus, openPane, splitPane, removeDevice } =
      useAppStore.getState();
    setStatus("d1", "connected");
    openPane({ id: "p1", deviceId: "d1", panel: "docker", instanceId: "i1" });
    splitPane("p1", "horizontal", {
      id: "p2",
      deviceId: "d2",
      panel: "metrics",
      instanceId: "i2",
    });
    removeDevice("d1");
    const root = activeWs().paneRoot;
    expect(root?.type).toBe("leaf");
    expect((root as { type: "leaf"; pane: { id: string } }).pane.id).toBe("p2");
    expect(useAppStore.getState().statuses).not.toHaveProperty("d1");
  });
});

describe("app-store — workspaces", () => {
  beforeEach(() => {
    const ws = {
      id: "w1",
      name: "Workspace 1",
      paneRoot: null,
      activePaneId: null,
    };
    useAppStore.setState({
      devices: [],
      statuses: {},
      activeDeviceId: null,
      workspaces: [ws],
      activeWorkspaceId: ws.id,
    });
  });

  it("addWorkspace creates a new workspace seeded with a Dashboard pane and switches to it", () => {
    useAppStore.getState().addWorkspace();
    expect(useAppStore.getState().workspaces).toHaveLength(2);
    const activeId = useAppStore.getState().activeWorkspaceId;
    const active = useAppStore
      .getState()
      .workspaces.find((w) => w.id === activeId)!;
    expect(active.paneRoot?.type).toBe("leaf");
    expect(
      (active.paneRoot as { type: "leaf"; pane: { panel: string } }).pane.panel,
    ).toBe("dashboard");
  });

  it("removeWorkspace removes it and falls back to another", () => {
    useAppStore.getState().addWorkspace();
    const ids = useAppStore.getState().workspaces.map((w) => w.id);
    useAppStore.getState().removeWorkspace(ids[0]);
    expect(useAppStore.getState().workspaces).toHaveLength(1);
    expect(useAppStore.getState().activeWorkspaceId).toBe(ids[1]);
  });

  it("cannot remove the last workspace", () => {
    const id = useAppStore.getState().workspaces[0].id;
    useAppStore.getState().removeWorkspace(id);
    expect(useAppStore.getState().workspaces).toHaveLength(1);
  });

  it("panes in different workspaces are independent", () => {
    useAppStore.getState().openPane({
      id: "p1",
      deviceId: "d1",
      panel: "docker",
      instanceId: "i1",
    });
    useAppStore.getState().addWorkspace(); // switches to new workspace
    // New workspace is seeded with a Dashboard, not the docker pane.
    const root = activeWs().paneRoot;
    expect(root?.type).toBe("leaf");
    expect(
      (root as { type: "leaf"; pane: { panel: string } }).pane.panel,
    ).toBe("dashboard");
  });

  it("renameWorkspace updates the name", () => {
    const id = useAppStore.getState().workspaces[0].id;
    useAppStore.getState().renameWorkspace(id, "My Dev Setup");
    expect(useAppStore.getState().workspaces[0].name).toBe("My Dev Setup");
  });
});
