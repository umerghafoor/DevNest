import { create } from "zustand";

export interface ServiceDef {
  id: string;
  name: string;
  command: string;
  cwd: string;
  /** "stopped" until a backend run command is wired up. */
  status: "stopped" | "running" | "error";
  lastStartedAt: number | null;
}

const STORAGE_KEY = "devnest.services";

function readStored(): ServiceDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ServiceDef[]) : [];
  } catch {
    return [];
  }
}

function persist(services: ServiceDef[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(services));
}

interface ServicesState {
  services: ServiceDef[];
  add: (def: Omit<ServiceDef, "id" | "status" | "lastStartedAt">) => void;
  update: (id: string, patch: Partial<ServiceDef>) => void;
  remove: (id: string) => void;
  setStatus: (id: string, status: ServiceDef["status"]) => void;
}

export const useServicesStore = create<ServicesState>((set) => ({
  services: readStored(),
  add: (def) =>
    set((s) => {
      const next: ServiceDef[] = [
        ...s.services,
        {
          ...def,
          id: Math.random().toString(36).slice(2, 10),
          status: "stopped",
          lastStartedAt: null,
        },
      ];
      persist(next);
      return { services: next };
    }),
  update: (id, patch) =>
    set((s) => {
      const next = s.services.map((x) =>
        x.id === id ? { ...x, ...patch } : x,
      );
      persist(next);
      return { services: next };
    }),
  remove: (id) =>
    set((s) => {
      const next = s.services.filter((x) => x.id !== id);
      persist(next);
      return { services: next };
    }),
  setStatus: (id, status) =>
    set((s) => {
      const next = s.services.map((x) =>
        x.id === id
          ? {
              ...x,
              status,
              lastStartedAt:
                status === "running" ? Date.now() : x.lastStartedAt,
            }
          : x,
      );
      persist(next);
      return { services: next };
    }),
}));
