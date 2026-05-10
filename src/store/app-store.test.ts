import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "./app-store";

describe("app-store", () => {
  beforeEach(() => {
    useAppStore.setState({
      devices: [],
      statuses: {},
      activeDeviceId: null,
      tabs: [],
      activeTabId: null,
    });
  });

  it("opens a tab and makes it active", () => {
    useAppStore
      .getState()
      .openTab({ id: "t1", deviceId: "d1", panel: "docker" });
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe("t1");
  });

  it("closing the active tab activates the previous one", () => {
    const { openTab, closeTab } = useAppStore.getState();
    openTab({ id: "t1", deviceId: "d1", panel: "docker" });
    openTab({ id: "t2", deviceId: "d1", panel: "metrics" });
    closeTab("t2");
    expect(useAppStore.getState().activeTabId).toBe("t1");
  });

  it("opening an existing tab id only activates it", () => {
    const { openTab } = useAppStore.getState();
    openTab({ id: "t1", deviceId: "d1", panel: "docker" });
    openTab({ id: "t2", deviceId: "d1", panel: "metrics" });
    openTab({ id: "t1", deviceId: "d1", panel: "docker" });
    expect(useAppStore.getState().tabs).toHaveLength(2);
    expect(useAppStore.getState().activeTabId).toBe("t1");
  });

  it("setStatus stores per-device", () => {
    useAppStore.getState().setStatus("d1", "connected");
    useAppStore.getState().setStatus("d2", "error");
    expect(useAppStore.getState().statuses).toEqual({
      d1: "connected",
      d2: "error",
    });
  });

  it("removeDevice cleans up tabs and statuses", () => {
    const { setStatus, openTab, removeDevice } = useAppStore.getState();
    setStatus("d1", "connected");
    openTab({ id: "t1", deviceId: "d1", panel: "docker" });
    openTab({ id: "t2", deviceId: "d2", panel: "metrics" });
    removeDevice("d1");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(useAppStore.getState().statuses).not.toHaveProperty("d1");
  });
});
