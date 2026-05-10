import { create } from "zustand";

interface PromptState {
  deviceId: string;
  deviceName: string;
  retry: () => void;
  resolve: (saved: boolean) => void;
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
      set({
        prompt: {
          deviceId,
          deviceName,
          retry: () => {},
          resolve,
        },
      });
    }),
  close: (saved) => {
    const p = get().prompt;
    if (p) p.resolve(saved);
    set({ prompt: null });
  },
}));
