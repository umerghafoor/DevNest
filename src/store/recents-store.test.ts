import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";
import { useRecentsStore } from "./recents-store";

const pane = (id: string, panel: "docker" | "terminal" | "dashboard") => ({
  id,
  deviceId: "d1",
  panel,
  instanceId: id,
});

describe("recents", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "W",
          paneRoot: null,
          floatingPanes: [],
          activePaneId: null,
        },
      ],
      activeWorkspaceId: "w1",
    });
    useRecentsStore.getState().clear();
  });

  it("records panes however they're opened, newest first", () => {
    const { openPane, splitPane, dockPane } = useAppStore.getState();
    openPane(pane("a", "docker"));
    splitPane("a", "horizontal", pane("b", "terminal"));
    openPane(pane("c", "dashboard"));
    expect(useRecentsStore.getState().recents).toEqual(["terminal", "docker"]);
    // Moving a pane isn't opening one.
    dockPane("w1", "a", "b", "left");
    expect(useRecentsStore.getState().recents).toEqual(["terminal", "docker"]);
  });
});
