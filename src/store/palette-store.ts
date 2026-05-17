import { create } from "zustand";

interface PaletteState {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));
