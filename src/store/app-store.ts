import { create } from "zustand";
import type { ConnectionStatus, Device } from "../lib/api";
import { randomWorkspaceName } from "../lib/workspace-names";

export type PanelKind =
  | "docker"
  | "metrics"
  | "terminal"
  | "files"
  | "tailscale"
  | "logs"
  | "processes"
  | "ports"
  | "cron"
  | "dashboard"
  | "settings"
  | "services"
  | "ngrok"
  | "sysinfo"
  | "editor"
  | "git"
  | "gitGraph"
  | "systemd"
  | "http"
  | "sql"
  | "markdown";

// ─── Pane leaf ───────────────────────────────────────────────────────────────

export interface Pane {
  id: string;
  deviceId: string;
  panel: PanelKind;
  instanceId: string; // unique per PTY / panel instance
  /** Optional panel-specific params (e.g. repoPath for the Git Graph). */
  extra?: Record<string, string>;
}

// ─── Tiling tree ─────────────────────────────────────────────────────────────

export type SplitDirection = "horizontal" | "vertical";
export type DockPosition = "left" | "right" | "top" | "bottom" | "center";

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number; // 0–1, fraction given to first child
  first: PaneNode;
  second: PaneNode;
}

export interface LeafNode {
  type: "leaf";
  pane: Pane;
}

export type PaneNode = SplitNode | LeafNode;

// ─── Workspace ───────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  paneRoot: PaneNode | null;
  floatingPanes: Pane[];
  activePaneId: string | null;
}

// ─── Tree helpers (pure) ──────────────────────────────────────────────────────

function makeLeaf(pane: Pane): LeafNode {
  return { type: "leaf", pane };
}

function normalizeWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    floatingPanes: workspace.floatingPanes ?? [],
  };
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function replaceLeaf(
  root: PaneNode,
  paneId: string,
  replacement: PaneNode,
): PaneNode {
  if (root.type === "leaf") {
    return root.pane.id === paneId ? replacement : root;
  }
  return {
    ...root,
    first: replaceLeaf(root.first, paneId, replacement),
    second: replaceLeaf(root.second, paneId, replacement),
  };
}

function removeLeaf(root: PaneNode, paneId: string): PaneNode | null {
  if (root.type === "leaf") {
    return root.pane.id === paneId ? null : root;
  }
  const first = removeLeaf(root.first, paneId);
  const second = removeLeaf(root.second, paneId);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...root, first, second };
}

export function collectPanes(root: PaneNode): Pane[] {
  if (root.type === "leaf") return [root.pane];
  return [...collectPanes(root.first), ...collectPanes(root.second)];
}

function updateRatio(
  root: PaneNode,
  splitNodeId: string,
  ratio: number,
): PaneNode {
  if (root.type === "leaf") return root;
  if (root.id === splitNodeId) return { ...root, ratio };
  return {
    ...root,
    first: updateRatio(root.first, splitNodeId, ratio),
    second: updateRatio(root.second, splitNodeId, ratio),
  };
}

export function findPaneInTree(
  root: PaneNode,
  paneId: string | null,
): Pane | undefined {
  if (!paneId) return undefined;
  if (root.type === "leaf")
    return root.pane.id === paneId ? root.pane : undefined;
  return (
    findPaneInTree(root.first, paneId) ?? findPaneInTree(root.second, paneId)
  );
}

// ─── Workspace helpers ────────────────────────────────────────────────────────

function defaultWorkspace(name?: string): Workspace {
  const paneId = uid();
  const dashboard: Pane = {
    id: paneId,
    instanceId: paneId,
    deviceId: "local",
    panel: "dashboard",
  };
  return {
    id: uid(),
    name: name ?? randomWorkspaceName(),
    paneRoot: makeLeaf(dashboard),
    floatingPanes: [],
    activePaneId: paneId,
  };
}

function collectWorkspacePanes(workspace: Workspace): Pane[] {
  return [
    ...(workspace.paneRoot ? collectPanes(workspace.paneRoot) : []),
    ...workspace.floatingPanes,
  ];
}

function removeFromWorkspace(
  workspace: Workspace,
  paneId: string,
): { workspace: Workspace; pane: Pane | null } {
  if (workspace.paneRoot) {
    const treePane = findPaneInTree(workspace.paneRoot, paneId);
    if (treePane) {
      const nextRoot = removeLeaf(workspace.paneRoot, paneId);
      const remaining = nextRoot ? collectPanes(nextRoot) : [];
      return {
        workspace: {
          ...workspace,
          paneRoot: nextRoot,
          activePaneId:
            workspace.activePaneId === paneId
              ? (remaining.at(-1)?.id ?? null)
              : workspace.activePaneId,
        },
        pane: treePane,
      };
    }
  }

  const floatingIdx = workspace.floatingPanes.findIndex((p) => p.id === paneId);
  if (floatingIdx !== -1) {
    const pane = workspace.floatingPanes[floatingIdx];
    const floatingPanes = workspace.floatingPanes.filter((p) => p.id !== paneId);
    return {
      workspace: { ...workspace, floatingPanes },
      pane,
    };
  }

  return { workspace, pane: null };
}

function insertIntoWorkspace(
  workspace: Workspace,
  targetPaneId: string,
  sourcePane: Pane,
  position: DockPosition,
): Workspace {
  if (!workspace.paneRoot) {
    return {
      ...workspace,
      paneRoot: makeLeaf(sourcePane),
      activePaneId: sourcePane.id,
    };
  }

  const target = findPaneInTree(workspace.paneRoot, targetPaneId);
  if (!target) return workspace;

  if (position === "center") {
    return {
      ...workspace,
      paneRoot: replaceLeaf(workspace.paneRoot, targetPaneId, makeLeaf(sourcePane)),
      activePaneId: sourcePane.id,
    };
  }

  const horizontal = position === "left" || position === "right";
  const firstIsSource = position === "left" || position === "top";
  const split: SplitNode = {
    type: "split",
    id: uid(),
    direction: horizontal ? "horizontal" : "vertical",
    ratio: 0.5,
    first: firstIsSource ? makeLeaf(sourcePane) : makeLeaf(target),
    second: firstIsSource ? makeLeaf(target) : makeLeaf(sourcePane),
  };

  return {
    ...workspace,
    paneRoot: replaceLeaf(workspace.paneRoot, targetPaneId, split),
    activePaneId: sourcePane.id,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface AppState {
  devices: Device[];
  statuses: Record<string, ConnectionStatus | "connecting" | "error">;
  activeDeviceId: string | null;

  // Workspaces
  workspaces: Workspace[];
  activeWorkspaceId: string;

  // Derived convenience (active workspace fields proxied)
  readonly paneRoot: PaneNode | null;
  readonly activePaneId: string | null;

  // Device actions
  setDevices: (devices: Device[]) => void;
  upsertDevice: (device: Device) => void;
  removeDevice: (id: string) => void;
  setStatus: (
    deviceId: string,
    status: ConnectionStatus | "connecting" | "error",
  ) => void;
  setActiveDevice: (deviceId: string | null) => void;

  // Workspace actions
  addWorkspace: () => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;

  // Pane actions (operate on the active workspace)
  openPane: (pane: Pane) => void;
  splitPane: (paneId: string, direction: SplitDirection, newPane: Pane) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string | null) => void;
  updateSplitRatio: (splitId: string, ratio: number) => void;
  updatePaneDevice: (paneId: string, deviceId: string) => void;
  detachPane: (workspaceId: string, paneId: string) => void;
  dockPane: (
    workspaceId: string,
    paneId: string,
    targetPaneId: string,
    position: DockPosition,
  ) => void;
}

const PERSIST_KEY = "devnest.workspaces";

interface PersistedShape {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}

function loadPersisted(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (
      !parsed ||
      !Array.isArray(parsed.workspaces) ||
      parsed.workspaces.length === 0 ||
      typeof parsed.activeWorkspaceId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizePersistedShape(shape: PersistedShape): PersistedShape {
  return {
    activeWorkspaceId: shape.activeWorkspaceId,
    workspaces: shape.workspaces.map((workspace) => normalizeWorkspace(workspace)),
  };
}

function persistWorkspaces(s: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}) {
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
      }),
    );
  } catch {
    // localStorage may be unavailable; degrade silently.
  }
}

const persisted = loadPersisted();
const normalizedPersisted = persisted ? normalizePersistedShape(persisted) : null;
const initial = normalizedPersisted ? null : defaultWorkspace();

export const useAppStore = create<AppState>((set, get) => ({
  devices: [],
  statuses: {},
  activeDeviceId: null,

  workspaces: normalizedPersisted?.workspaces ?? [initial!],
  activeWorkspaceId: normalizedPersisted?.activeWorkspaceId ?? initial!.id,

  // Proxy getters — read active workspace fields directly
  get paneRoot() {
    const s = get();
    return (
      s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.paneRoot ?? null
    );
  },
  get activePaneId() {
    const s = get();
    return (
      s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.activePaneId ??
      null
    );
  },

  // ── Device ─────────────────────────────────────────────────────────────────

  setDevices: (devices) =>
    set((s) => ({
      devices,
      activeDeviceId:
        s.activeDeviceId && devices.some((d) => d.id === s.activeDeviceId)
          ? s.activeDeviceId
          : (devices[0]?.id ?? null),
    })),

  upsertDevice: (device) =>
    set((s) => {
      const idx = s.devices.findIndex((d) => d.id === device.id);
      const devices =
        idx === -1
          ? [...s.devices, device]
          : s.devices.map((d) => (d.id === device.id ? device : d));
      return { devices };
    }),

  removeDevice: (id) =>
    set((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (!w.paneRoot && w.floatingPanes.length === 0) return w;
        let nextWorkspace = w;
        for (const p of collectWorkspacePanes(w)) {
          if (p.deviceId === id) {
            nextWorkspace = removeFromWorkspace(nextWorkspace, p.id).workspace;
          }
        }
        const remaining = collectWorkspacePanes(nextWorkspace);
        return {
          ...nextWorkspace,
          activePaneId: remaining.some((p) => p.id === w.activePaneId)
            ? w.activePaneId
            : (remaining.at(-1)?.id ?? null),
        };
      });
      return {
        devices: s.devices.filter((d) => d.id !== id),
        activeDeviceId: s.activeDeviceId === id ? null : s.activeDeviceId,
        workspaces,
        statuses: Object.fromEntries(
          Object.entries(s.statuses).filter(([k]) => k !== id),
        ),
      };
    }),

  setStatus: (deviceId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [deviceId]: status } })),

  setActiveDevice: (deviceId) => set({ activeDeviceId: deviceId }),

  // ── Workspaces ─────────────────────────────────────────────────────────────

  addWorkspace: () =>
    set((s) => {
      const existing = new Set(s.workspaces.map((w) => w.name));
      let name = randomWorkspaceName();
      for (let i = 0; i < 10 && existing.has(name); i++)
        name = randomWorkspaceName();
      const ws = defaultWorkspace(name);
      return { workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id };
    }),

  removeWorkspace: (id) =>
    set((s) => {
      if (s.workspaces.length <= 1) return {}; // never remove the last one
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId =
        s.activeWorkspaceId === id
          ? (workspaces.at(-1)?.id ?? workspaces[0].id)
          : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }),

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
    })),

  // ── Panes (mutate active workspace) ────────────────────────────────────────

  openPane: (pane) =>
    set((s) =>
      patchActiveWorkspace(s, (w) => {
        const leaf = makeLeaf(pane);
        if (!w.paneRoot) return { paneRoot: leaf, activePaneId: pane.id };
        if (!w.activePaneId) return { paneRoot: leaf, activePaneId: pane.id };

        const active = findPaneInTree(w.paneRoot, w.activePaneId);
        // Re-opening the same panel kind on the active pane just refocuses it
        // (no point stacking duplicates of Settings/Dashboard).
        if (active && active.panel === pane.panel) {
          return { activePaneId: active.id };
        }

        const split: SplitNode = {
          type: "split",
          id: uid(),
          direction: "horizontal",
          ratio: 0.5,
          first: makeLeaf(active!),
          second: leaf,
        };
        return {
          paneRoot: replaceLeaf(w.paneRoot, w.activePaneId, split),
          activePaneId: pane.id,
        };
      }),
    ),

  splitPane: (paneId, direction, newPane) =>
    set((s) =>
      patchActiveWorkspace(s, (w) => {
        if (!w.paneRoot) return {};
        const existing = findPaneInTree(w.paneRoot, paneId);
        if (!existing) return {};
        const split: SplitNode = {
          type: "split",
          id: uid(),
          direction,
          ratio: 0.5,
          first: makeLeaf(existing),
          second: makeLeaf(newPane),
        };
        return {
          paneRoot: replaceLeaf(w.paneRoot, paneId, split),
          activePaneId: newPane.id,
        };
      }),
    ),

  closePane: (paneId) =>
    set((s) =>
      patchActiveWorkspace(s, (w) => {
        if (!w.paneRoot) return {};
        const next = removeLeaf(w.paneRoot, paneId);
        const remaining = next ? collectPanes(next) : [];
        return {
          paneRoot: next,
          activePaneId:
            w.activePaneId === paneId
              ? (remaining.at(-1)?.id ?? null)
              : w.activePaneId,
        };
      }),
    ),

  setActivePane: (paneId) =>
    set((s) => patchActiveWorkspace(s, () => ({ activePaneId: paneId }))),

  updateSplitRatio: (splitId, ratio) =>
    set((s) =>
      patchActiveWorkspace(s, (w) => ({
        paneRoot: w.paneRoot ? updateRatio(w.paneRoot, splitId, ratio) : null,
      })),
    ),

  updatePaneDevice: (paneId, deviceId) =>
    set((s) =>
      patchActiveWorkspace(s, (w) => {
        if (!w.paneRoot) return {};
        const pane = findPaneInTree(w.paneRoot, paneId);
        if (!pane) return {};
        // Fresh instanceId forces a full unmount+remount of the panel content
        // so it reinitialises against the new device rather than carrying over
        // stale connections or cached data from the previous one.
        return {
          paneRoot: replaceLeaf(
            w.paneRoot,
            paneId,
            makeLeaf({ ...pane, deviceId, instanceId: uid() }),
          ),
        };
      }),
    ),

  detachPane: (workspaceId, paneId) =>
    set((s) =>
      patchWorkspaceById(s, workspaceId, (w) => {
        if (!w.paneRoot) return {};
        const pane = findPaneInTree(w.paneRoot, paneId);
        if (!pane) return {};
        const nextRoot = removeLeaf(w.paneRoot, paneId);
        const remaining = nextRoot ? collectPanes(nextRoot) : [];
        return {
          paneRoot: nextRoot,
          activePaneId:
            w.activePaneId === paneId
              ? (remaining.at(-1)?.id ?? null)
              : w.activePaneId,
          floatingPanes: [...w.floatingPanes, pane],
        };
      }),
    ),

  dockPane: (workspaceId, paneId, targetPaneId, position) =>
    set((s) =>
      patchWorkspaceById(s, workspaceId, (w) => {
        const sourcePane =
          (w.paneRoot ? findPaneInTree(w.paneRoot, paneId) : undefined) ??
          w.floatingPanes.find((p) => p.id === paneId) ??
          null;
        if (!sourcePane) return {};
        if (paneId === targetPaneId && w.paneRoot) return {};
        const targetExists = !!(w.paneRoot && findPaneInTree(w.paneRoot, targetPaneId));
        if (paneId === targetPaneId && !w.paneRoot) {
          const removed = removeFromWorkspace(w, paneId);
          return {
            ...removed.workspace,
            paneRoot: makeLeaf(sourcePane),
            activePaneId: sourcePane.id,
          };
        }
        if (!targetExists) return {};

        const removed = removeFromWorkspace(w, paneId);
        const nextWorkspace = removed.workspace;
        if (!nextWorkspace.paneRoot) {
          return {
            ...nextWorkspace,
            paneRoot: makeLeaf(sourcePane),
            activePaneId: sourcePane.id,
          };
        }

        return insertIntoWorkspace(nextWorkspace, targetPaneId, sourcePane, position);
      }),
    ),
}));

// Save workspace tree + active workspace whenever they change, so panel
// layouts survive a restart. Subscribed once at module load.
let lastWorkspaces = useAppStore.getState().workspaces;
let lastActiveId = useAppStore.getState().activeWorkspaceId;
useAppStore.subscribe((s) => {
  if (s.workspaces !== lastWorkspaces || s.activeWorkspaceId !== lastActiveId) {
    lastWorkspaces = s.workspaces;
    lastActiveId = s.activeWorkspaceId;
    persistWorkspaces({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
    });
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== PERSIST_KEY) return;
    const next = loadPersisted();
    if (!next) return;
    const normalized = normalizePersistedShape(next);
    useAppStore.setState({
      workspaces: normalized.workspaces,
      activeWorkspaceId: normalized.activeWorkspaceId,
    });
  });
}

// ─── Helper: patch the active workspace immutably ─────────────────────────────

function patchActiveWorkspace(
  s: AppState,
  fn: (w: Workspace) => Partial<Workspace>,
): Partial<AppState> {
  return {
    workspaces: s.workspaces.map((w) =>
      w.id === s.activeWorkspaceId ? { ...w, ...fn(w) } : w,
    ),
  };
}

function patchWorkspaceById(
  s: AppState,
  workspaceId: string,
  fn: (w: Workspace) => Partial<Workspace>,
): Partial<AppState> {
  return {
    workspaces: s.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, ...fn(w) } : w,
    ),
  };
}

// Selector helpers
export const selectActiveWorkspace = (s: AppState) =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
