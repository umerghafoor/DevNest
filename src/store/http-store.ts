import { create } from "zustand";
import type { HttpRequestSpec } from "../lib/api";

export interface SavedRequest {
  id: string;
  name: string;
  spec: HttpRequestSpec;
  updatedAt: number;
}

const STORAGE_KEY = "devnest.http.saved";

function readStored(): SavedRequest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedRequest[]) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedRequest[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface HttpState {
  saved: SavedRequest[];
  save: (name: string, spec: HttpRequestSpec) => SavedRequest;
  update: (id: string, patch: Partial<SavedRequest>) => void;
  remove: (id: string) => void;
}

export const useHttpStore = create<HttpState>((set) => ({
  saved: readStored(),
  save: (name, spec) => {
    const req: SavedRequest = {
      id: Math.random().toString(36).slice(2, 10),
      name: name.trim() || untitled(),
      spec,
      updatedAt: Date.now(),
    };
    let next: SavedRequest[] = [];
    set((s) => {
      next = [req, ...s.saved];
      persist(next);
      return { saved: next };
    });
    return req;
  },
  update: (id, patch) =>
    set((s) => {
      const next = s.saved.map((r) =>
        r.id === id ? { ...r, ...patch, updatedAt: Date.now() } : r,
      );
      persist(next);
      return { saved: next };
    }),
  remove: (id) =>
    set((s) => {
      const next = s.saved.filter((r) => r.id !== id);
      persist(next);
      return { saved: next };
    }),
}));

function untitled(): string {
  return `Untitled ${new Date().toLocaleTimeString()}`;
}
