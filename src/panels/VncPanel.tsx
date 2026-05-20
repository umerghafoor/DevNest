import { useEffect, useMemo, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { api, errorMessage } from "../lib/api";
import { useVncStore, type SavedVncProfile } from "../store/vnc-store";
import { useAppStore } from "../store/app-store";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";

type ConnState = "disconnected" | "connecting" | "connected" | "error";

export function VncPanel() {
  const saved = useVncStore((s) => s.saved);
  const activeId = useVncStore((s) => s.activeId);
  const setActive = useVncStore((s) => s.setActive);
  const addProfile = useVncStore((s) => s.add);
  const updateProfile = useVncStore((s) => s.update);
  const removeProfile = useVncStore((s) => s.remove);

  const [editing, setEditing] = useState<SavedVncProfile | "new" | null>(null);
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connError, setConnError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState<boolean>(true);
  const active = saved.find((p) => p.id === activeId) ?? null;

  const onSelect = (p: SavedVncProfile) => {
    setActive(p.id);
    setConnState("disconnected");
    setConnError(null);
  };

  return (
    <div className="flex h-full">
      {railOpen ? (
        <ProfileRail
          profiles={saved}
          activeId={active?.id ?? null}
          connState={connState}
          onCollapse={() => setRailOpen(false)}
          onSelect={onSelect}
          onNew={() => setEditing("new")}
          onEdit={(p) => setEditing(p)}
          onDelete={async (p) => {
            const ok = await confirm(`Remove VNC profile "${p.name}"?`, {
              title: "Delete profile",
              destructive: true,
            });
            if (!ok) return;
            await api.vncClearPassword(p.id).catch(() => {});
            removeProfile(p.id);
          }}
        />
      ) : (
        <CollapsedRail
          connState={connState}
          onExpand={() => setRailOpen(true)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-(--color-bg)">
        {active ? (
          <Viewer
            key={active.id}
            profile={active}
            onState={setConnState}
            onError={setConnError}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            Pick or add a VNC profile on the left.
          </div>
        )}
        {connError && (
          <div className="shrink-0 bg-(--color-error)/10 px-3 py-1.5 text-xs text-(--color-error)">
            {connError}
          </div>
        )}
      </div>

      {editing && (
        <ProfileEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (draft, password) => {
            let id: string;
            if (editing === "new") {
              const created = addProfile(draft);
              id = created.id;
            } else {
              id = editing.id;
              updateProfile(id, draft);
            }
            if (password !== null) {
              if (password.length > 0) await api.vncSetPassword(id, password);
              else await api.vncClearPassword(id).catch(() => {});
            }
            setEditing(null);
            toast.success("Profile saved");
          }}
        />
      )}
    </div>
  );
}

// ── Viewer ────────────────────────────────────────────────────────────────

/**
 * Per-profile session registry.
 *
 * React 18 StrictMode (dev) mounts every effect twice: mount → cleanup →
 * mount. Two mounts in microseconds would each issue their own
 * `api.vncOpen` call, and the second-to-arrive Rust call would call
 * `self.close(&id)` and kill the first-to-arrive's listener — leaving
 * noVNC pointing at a dead port. To avoid this we serialize all opens
 * for a given profile id behind a single in-flight Promise: every mount
 * gets the same URL, the Rust pool only sees one `open` call.
 *
 * Cleanup likewise debounces close. A 50ms timer is armed; a remount
 * within that window cancels it and reuses the existing session.
 */
interface VncSession {
  /** Resolves to the ws://… URL noVNC should connect to. */
  url: Promise<string>;
  /** Filled in once a Viewer constructs the RFB instance. */
  rfb: RFB | null;
  /** Pending-close timer, if a cleanup is debounced. */
  closeTimer: number | null;
}

const sessions = new Map<string, VncSession>();

interface OpenParams {
  id: string;
  host: string;
  port: number;
  deviceId?: string | null;
}

/** Get the ws URL for this profile, opening the proxy if needed. */
function acquireSession(params: OpenParams): VncSession {
  // Cancel a pending close — we're back in business for this id.
  const existing = sessions.get(params.id);
  if (existing) {
    if (existing.closeTimer !== null) {
      window.clearTimeout(existing.closeTimer);
      existing.closeTimer = null;
    }
    return existing;
  }
  const url = api.vncOpen({
    id: params.id,
    host: params.host,
    port: params.port,
    deviceId: params.deviceId ?? null,
  });
  const session: VncSession = { url, rfb: null, closeTimer: null };
  sessions.set(params.id, session);
  return session;
}

/**
 * Schedule a teardown of the session. A subsequent acquire within 50ms
 * cancels it. Idempotent for the same id.
 */
function releaseSession(profileId: string) {
  const session = sessions.get(profileId);
  if (!session) return;
  if (session.closeTimer !== null) return; // already scheduled
  session.closeTimer = window.setTimeout(() => {
    sessions.delete(profileId);
    try {
      session.rfb?.disconnect();
    } catch {
      // ignore
    }
    void api.vncClose(profileId).catch(() => {});
  }, 50);
}

function Viewer({
  profile,
  onState,
  onError,
}: {
  profile: SavedVncProfile;
  onState: (s: ConnState) => void;
  onError: (e: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  // Stable refs for callbacks so the effect doesn't re-fire if the parent
  // ever passes new function identities.
  const onStateRef = useRef(onState);
  const onErrorRef = useRef(onError);
  onStateRef.current = onState;
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Acquire (or reuse) the session for this profile id. Concurrent
    // mounts (StrictMode) share the same in-flight open Promise, so the
    // Rust pool only sees one `vncOpen` per profile.
    const session = acquireSession({
      id: profile.id,
      host: profile.host,
      port: profile.port,
      deviceId: profile.viaDeviceId,
    });

    // If the session already has an RFB from a prior mount, reuse it.
    if (session.rfb) {
      rfbRef.current = session.rfb;
      onStateRef.current("connected");
      return () => {
        releaseSession(profile.id);
        rfbRef.current = null;
      };
    }

    let cancelled = false;
    onStateRef.current("connecting");
    onErrorRef.current(null);

    (async () => {
      let wsUrl: string;
      try {
        wsUrl = await session.url;
      } catch (e) {
        if (!cancelled) {
          onStateRef.current("error");
          onErrorRef.current(errorMessage(e));
        }
        return;
      }
      if (cancelled) return;
      // Another concurrent mount may have already built the RFB while
      // we were awaiting; in that case reuse it instead of building a
      // second one.
      if (session.rfb) {
        rfbRef.current = session.rfb;
        onStateRef.current("connected");
        return;
      }

      const opts: ConstructorParameters<typeof RFB>[2] = {
        credentials: { password: "" },
      };
      const rfb = new RFB(container, wsUrl, opts);
      session.rfb = rfb;
      rfbRef.current = rfb;
      rfb.viewOnly = profile.viewOnly ?? false;
      rfb.scaleViewport = profile.scaleViewport ?? true;
      rfb.background = "";

      rfb.addEventListener("connect", () => {
        if (!cancelled) onStateRef.current("connected");
      });
      rfb.addEventListener("disconnect", (e: Event) => {
        if (cancelled) return;
        const detail = (e as CustomEvent<{ clean: boolean; reason?: string }>)
          .detail;
        onStateRef.current(detail?.clean ? "disconnected" : "error");
        if (detail?.reason) {
          onErrorRef.current(detail.reason);
        } else if (!detail?.clean) {
          onErrorRef.current(
            "Connection lost. Check the VNC server is reachable.",
          );
        }
      });
      rfb.addEventListener("credentialsrequired", () => {
        const pw = window.prompt(
          `Password for VNC profile "${profile.name}"`,
          "",
        );
        rfb.sendCredentials({ password: pw ?? "" });
      });
      rfb.addEventListener("securityfailure", (e: Event) => {
        const detail = (
          e as CustomEvent<{ status: number; reason?: string }>
        ).detail;
        if (!cancelled) {
          onErrorRef.current(detail?.reason ?? "Security handshake failed");
        }
      });
    })();

    return () => {
      cancelled = true;
      releaseSession(profile.id);
      rfbRef.current = null;
    };
  }, [profile.id, profile.host, profile.port, profile.viaDeviceId]);

  // Apply cosmetic toggles when they change without rebuilding the session.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = profile.viewOnly ?? false;
    rfb.scaleViewport = profile.scaleViewport ?? true;
  }, [profile.viewOnly, profile.scaleViewport]);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-black"
    />
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────

function CollapsedRail({
  connState,
  onExpand,
}: {
  connState: ConnState;
  onExpand: () => void;
}) {
  const dot =
    connState === "connected"
      ? "bg-(--color-online)"
      : connState === "connecting"
        ? "bg-(--color-warn) animate-pulse"
        : connState === "error"
          ? "bg-(--color-error)"
          : "bg-(--color-offline)";
  return (
    <aside className="flex w-8 shrink-0 flex-col items-center gap-2 bg-(--color-surface) py-2">
      <button
        onClick={onExpand}
        title="Show profiles"
        className="rounded bg-(--color-surface-2) px-1.5 py-0.5 text-xs text-(--color-fg-muted) hover:bg-(--color-bg)"
      >
        ⇥
      </button>
      <span
        title={connState}
        className={`h-2 w-2 rounded-full ${dot}`}
        aria-label={connState}
      />
    </aside>
  );
}

function ProfileRail({
  profiles,
  activeId,
  connState,
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onCollapse,
}: {
  profiles: SavedVncProfile[];
  activeId: string | null;
  connState: ConnState;
  onSelect: (p: SavedVncProfile) => void;
  onNew: () => void;
  onEdit: (p: SavedVncProfile) => void;
  onDelete: (p: SavedVncProfile) => void;
  onCollapse: () => void;
}) {
  return (
    <aside className="flex w-60 flex-col bg-(--color-surface)">
      <div className="flex items-center gap-1 px-3 py-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          Profiles
        </span>
        <button
          onClick={onNew}
          className="ml-auto rounded bg-(--color-surface-2) px-2 py-0.5 hover:bg-(--color-bg)"
        >
          + New
        </button>
        <button
          onClick={onCollapse}
          title="Collapse profiles"
          className="rounded bg-(--color-surface-2) px-2 py-0.5 text-(--color-fg-muted) hover:bg-(--color-bg)"
        >
          ⇤
        </button>
      </div>
      <div className="flex-1 overflow-auto text-xs">
        {profiles.length === 0 && (
          <div className="px-3 py-4 text-center text-(--color-fg-muted)">
            No profiles yet.
          </div>
        )}
        {profiles.map((p) => {
          const isActive = p.id === activeId;
          const dot =
            isActive && connState === "connected"
              ? "bg-(--color-online)"
              : isActive && connState === "connecting"
                ? "bg-(--color-warn) animate-pulse"
                : isActive && connState === "error"
                  ? "bg-(--color-error)"
                  : "bg-(--color-offline)";
          return (
            <div key={p.id}>
              <button
                onClick={() => onSelect(p)}
                className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  isActive
                    ? "bg-(--color-surface-2)"
                    : "hover:bg-(--color-surface-2)"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                <span className="min-w-0 flex-1">
                  <div className="truncate font-medium text-(--color-fg)">
                    {p.name}
                  </div>
                  <div className="truncate text-[10px] text-(--color-fg-muted)">
                    {p.host}:{p.port}
                    {p.viaDeviceId ? " · via SSH" : ""}
                  </div>
                </span>
              </button>
              {isActive && (
                <div className="flex items-center gap-1 px-3 pb-2 text-[10px]">
                  <button
                    onClick={() => onEdit(p)}
                    className="rounded bg-(--color-surface-2) px-2 py-0.5 hover:bg-(--color-bg)"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(p)}
                    className="ml-auto rounded bg-(--color-surface-2) px-2 py-0.5 text-(--color-error) hover:bg-(--color-error)/15"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── Profile editor ────────────────────────────────────────────────────────

function ProfileEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: SavedVncProfile | null;
  onClose: () => void;
  onSave: (
    draft: Omit<SavedVncProfile, "id" | "updatedAt">,
    password: string | null,
  ) => void | Promise<void>;
}) {
  const devices = useAppStore((s) => s.devices);
  const sshDevices = useMemo(
    () => devices.filter((d) => !d.isLocalhost),
    [devices],
  );

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState<number>(initial?.port ?? 5900);
  const [viaDeviceId, setViaDeviceId] = useState<string>(
    initial?.viaDeviceId ?? "",
  );
  const [scaleViewport, setScaleViewport] = useState<boolean>(
    initial?.scaleViewport ?? true,
  );
  const [viewOnly, setViewOnly] = useState<boolean>(initial?.viewOnly ?? false);
  const [password, setPassword] = useState("");

  const save = () => {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    if (!host.trim()) {
      toast.error("Host required");
      return;
    }
    void onSave(
      {
        name: name.trim(),
        host: host.trim(),
        port,
        viaDeviceId: viaDeviceId || undefined,
        scaleViewport,
        viewOnly,
      },
      password.length > 0 ? password : null,
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[26rem] rounded-lg bg-(--color-surface) p-4 text-xs shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold">
          {initial ? "Edit VNC profile" : "New VNC profile"}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Name" cols={3}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="workstation"
              className="input w-full py-1 text-xs"
            />
          </Field>
          <Field label="Host" cols={2}>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="127.0.0.1 or remote-only-name"
              className="input w-full py-1 text-xs"
            />
          </Field>
          <Field label="Port" cols={1}>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="input w-full py-1 text-xs"
            />
          </Field>
          <Field label="Password (leave empty to keep stored)" cols={3}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                initial ? "•••••••• in keyring (leave blank to keep)" : ""
              }
              className="input w-full py-1 text-xs"
            />
          </Field>
          <Field label="Via SSH device (optional)" cols={3}>
            <select
              value={viaDeviceId}
              onChange={(e) => setViaDeviceId(e.target.value)}
              className="input w-full py-1 text-xs"
            >
              <option value="">— direct connection —</option>
              {sshDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.host})
                </option>
              ))}
            </select>
          </Field>
          <label className="col-span-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={scaleViewport}
              onChange={(e) => setScaleViewport(e.target.checked)}
            />
            <span>Scale viewport to fit panel</span>
          </label>
          <label className="col-span-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={viewOnly}
              onChange={(e) => setViewOnly(e.target.checked)}
            />
            <span>View only (no input)</span>
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded bg-(--color-surface-2) px-3 py-1 hover:bg-(--color-bg)"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded bg-(--color-accent) px-3 py-1 text-(--color-accent-fg) hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  cols,
}: {
  label: string;
  children: React.ReactNode;
  cols: 1 | 2 | 3;
}) {
  const span =
    cols === 3 ? "col-span-3" : cols === 2 ? "col-span-2" : "col-span-1";
  return (
    <label className={`flex flex-col gap-1 ${span}`}>
      <span className="text-[10px] uppercase tracking-wide text-(--color-fg-muted)">
        {label}
      </span>
      {children}
    </label>
  );
}
