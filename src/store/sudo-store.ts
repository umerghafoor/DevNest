import { create } from "zustand";

interface PromptState {
  deviceId: string;
  deviceName: string;
  retry: () => void;
  resolve: (saved: boolean) => void;
  // Extra waiters that arrived while this prompt was already open.
  waiters: Array<(saved: boolean) => void>;
}

interface SudoStore {
  prompt: PromptState | null;
  request: (deviceId: string, deviceName: string) => Promise<boolean>;
  close: (saved: boolean) => void;
}

export const useSudoStore = create<SudoStore>((set, get) => ({
  prompt: null,
  request: (deviceId, deviceName) =>
    new Promise<boolean>((resolve) => {
      const existing = get().prompt;
      // Re-entrant call while a prompt for the same device is already open —
      // queue behind the existing one instead of overwriting it.
      if (existing && existing.deviceId === deviceId) {
        existing.waiters.push(resolve);
        return;
      }
      set({
        prompt: {
          deviceId,
          deviceName,
          retry: () => {},
          resolve,
          waiters: [],
        },
      });
    }),
  close: (saved) => {
    const p = get().prompt;
    if (p) {
      p.resolve(saved);
      for (const w of p.waiters) w(saved);
    }
    set({ prompt: null });
  },
}));
