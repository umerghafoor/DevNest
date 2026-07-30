import { useEffect, useState } from "react";
import { z } from "zod";
import { api } from "../lib/api";
import type { AuthType, Device, IceServer, WebRtcConfig } from "../lib/api";
import { useAppStore } from "../store/app-store";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  /** If set, the dialog opens in "edit" mode with this device's values. */
  editing?: Device | null;
}

const schema = z
  .object({
    name: z.string().min(1, "Name is required").max(64),
    // Host is only meaningful for TCP. For WebRTC the device is reached via the
    // signaling server + peer id, so it's optional there (enforced below).
    host: z.string(),
    port: z
      .number()
      .int()
      .min(1, "Port must be 1-65535")
      .max(65535, "Port must be 1-65535"),
    username: z.string().min(1, "Username is required"),
    authType: z.enum(["key", "password"]),
    keyPath: z.string().optional(),
    secret: z.string().optional(),
    sudoPrefix: z.string().optional(),
    useSudo: z.boolean(),
    keepAlive: z.boolean(),
    transport: z.enum(["tcp", "webrtc"]),
    signalingUrl: z.string().optional(),
    peerId: z.string().optional(),
    webrtcSecret: z.string().optional(),
    clientId: z.string().optional(),
    iceServersText: z.string().optional(),
    channelLabel: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.transport === "tcp" && v.host.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Host is required",
      });
    }
  });

type FormValues = z.infer<typeof schema>;

const initial: FormValues = {
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "key",
  keyPath: "",
  secret: "",
  sudoPrefix: "",
  useSudo: false,
  keepAlive: false,
  transport: "tcp",
  signalingUrl: "",
  peerId: "",
  webrtcSecret: "",
  clientId: "",
  iceServersText: "",
  channelLabel: "",
};

/** Render ICE servers as one `urls [username] [credential]` line each, the
 * format the textarea editor uses. TURN entries have all three; STUN just the
 * URL. */
function iceServersToText(servers: IceServer[]): string {
  return servers
    .map((s) => {
      const url = s.urls.join(" ");
      if (s.username && s.credential) {
        return `${url} ${s.username} ${s.credential}`;
      }
      return url;
    })
    .join("\n");
}

/** Parse the textarea back into ICE servers. Entries are separated by newlines
 * OR commas (so pasting a comma-separated env value works too). Each entry is
 * `url [username] [credential]`; an entry with 3+ tokens is treated as TURN.
 * Blank entries are dropped so a stray separator can't create an empty URL. */
function parseIceServers(text: string): IceServer[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length >= 3) {
        const [url, username, credential] = tokens;
        return { urls: [url], username, credential };
      }
      return { urls: [tokens[0]] };
    });
}

export function AddDeviceDialog({ open, onClose, editing }: Props) {
  const [values, setValues] = useState<FormValues>(initial);
  const [errors, setErrors] = useState<
    Partial<Record<keyof FormValues, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const upsertDevice = useAppStore((s) => s.upsertDevice);
  const setActiveDevice = useAppStore((s) => s.setActiveDevice);

  // Prefill from `editing` each time the dialog re-opens for a different
  // device, or reset to blanks when re-opened for a fresh add.
  useEffect(() => {
    if (!open) return;
    if (editing && editing.authType !== "localhost") {
      const cfg = editing.webrtcConfig;
      setValues({
        name: editing.name,
        host: editing.host,
        port: editing.port,
        username: editing.username,
        authType: editing.authType,
        keyPath: editing.keyPath ?? "",
        secret: "",
        sudoPrefix: editing.sudoPrefix ?? "",
        useSudo: editing.useSudo,
        keepAlive: editing.keepAlive,
        transport: editing.transport ?? "tcp",
        signalingUrl: cfg?.signalingUrl ?? "",
        peerId: cfg?.peerId ?? "",
        webrtcSecret: cfg?.secret ?? "",
        clientId: cfg?.clientId ?? "",
        iceServersText: cfg ? iceServersToText(cfg.iceServers) : "",
        channelLabel: cfg?.channelLabel ?? "",
      });
    } else {
      setValues(initial);
    }
    setErrors({});
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const set = <K extends keyof FormValues>(key: K, val: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: val }));

  const reset = () => {
    setValues(initial);
    setErrors({});
    setSubmitError(null);
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof FormValues, string>> = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as keyof FormValues;
        if (!fieldErrors[k]) fieldErrors[k] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    if (parsed.data.authType === "key" && !parsed.data.keyPath) {
      setErrors({ keyPath: "Key path is required for key auth" });
      return;
    }
    // In edit mode, an empty password means "keep the stored one". In add
    // mode, password auth requires a value (we have nothing to fall back to).
    if (
      !editing &&
      parsed.data.authType === "password" &&
      !parsed.data.secret
    ) {
      setErrors({ secret: "Password is required for password auth" });
      return;
    }

    // WebRTC transport needs a signaling URL and a peer id to reach the agent.
    if (parsed.data.transport === "webrtc") {
      if (!parsed.data.signalingUrl) {
        setErrors({ signalingUrl: "Signaling URL is required for WebRTC" });
        return;
      }
      if (!parsed.data.peerId) {
        setErrors({ peerId: "Peer ID is required for WebRTC" });
        return;
      }
    }

    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      const webrtcConfig: WebRtcConfig | null =
        parsed.data.transport === "webrtc"
          ? {
              signalingUrl: parsed.data.signalingUrl!,
              peerId: parsed.data.peerId!,
              secret: parsed.data.webrtcSecret || undefined,
              clientId: parsed.data.clientId || undefined,
              iceServers: parseIceServers(parsed.data.iceServersText ?? ""),
              channelLabel: parsed.data.channelLabel || undefined,
            }
          : null;
      const payload = {
        name: parsed.data.name,
        // The backend ignores host/port for WebRTC (the agent bridges to its
        // own 127.0.0.1:22), but the column is NOT NULL — send a placeholder
        // when the user left them blank.
        host:
          parsed.data.transport === "webrtc" && !parsed.data.host.trim()
            ? "webrtc"
            : parsed.data.host,
        port: parsed.data.port,
        username: parsed.data.username,
        authType: parsed.data.authType as AuthType,
        keyPath: parsed.data.keyPath || null,
        sudoPrefix: parsed.data.sudoPrefix || null,
        useSudo: parsed.data.useSudo,
        keepAlive: parsed.data.keepAlive,
        transport: parsed.data.transport,
        webrtcConfig,
      };
      const device = editing
        ? await api.updateDevice(
            editing.id,
            payload,
            parsed.data.secret ? parsed.data.secret : null,
          )
        : await api.createDevice(payload, parsed.data.secret || null);
      upsertDevice(device);
      if (!editing) setActiveDevice(device.id);
      reset();
      onClose();
    } catch (e) {
      setSubmitError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? `Edit ${editing.name}` : "Add device"}
      footer={
        <>
          <button
            onClick={close}
            disabled={submitting}
            className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface-2) disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving…" : editing ? "Save changes" : "Add device"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <Field label="Name" error={errors.name}>
          <input
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="my-server"
            className="input"
          />
        </Field>
        <Field
          label="Transport"
          hint={
            values.transport === "webrtc"
              ? "SSH is carried over a WebRTC DataChannel to your device agent, which bridges it to its own 127.0.0.1:22. No host/port needed — the device is reached via the signaling server + peer ID below."
              : "Connect directly to Host:Port over TCP."
          }
        >
          <div className="flex gap-2">
            {(["tcp", "webrtc"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set("transport", t)}
                className={`rounded border px-3 py-1 text-xs ${
                  values.transport === t
                    ? "border-(--color-accent) bg-(--color-accent) text-white"
                    : "border-(--color-border) hover:bg-(--color-surface-2)"
                }`}
              >
                {t === "tcp" ? "Direct TCP" : "WebRTC"}
              </button>
            ))}
          </div>
        </Field>
        {values.transport === "tcp" ? (
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Field label="Host" error={errors.host}>
                <input
                  value={values.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="192.168.1.10 or ts-name"
                  className="input"
                />
              </Field>
            </div>
            <Field label="Port" error={errors.port}>
              <input
                type="number"
                value={values.port}
                onChange={(e) =>
                  set("port", Number.parseInt(e.target.value, 10) || 0)
                }
                className="input"
              />
            </Field>
          </div>
        ) : null}
        <Field label="Username" error={errors.username}>
          <input
            value={values.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="root"
            className="input"
          />
        </Field>
        {values.transport === "webrtc" ? (
          <div className="space-y-3 rounded border border-(--color-border) bg-(--color-surface) p-3">
            <Field
              label="Signaling URL"
              error={errors.signalingUrl}
              hint="WebSocket URL of your signaling server (the one you use for HTTP/WS)."
            >
              <input
                value={values.signalingUrl}
                onChange={(e) => set("signalingUrl", e.target.value)}
                placeholder="wss://signal.example.com/ws"
                className="input"
              />
            </Field>
            <Field
              label="Target device ID"
              error={errors.peerId}
              hint="The agent's device_id you want to reach (its P2P_DEVICE_ID), e.g. edge-device-2. Sent as the `to` field when connecting."
            >
              <input
                value={values.peerId}
                onChange={(e) => set("peerId", e.target.value)}
                placeholder="edge-device-2"
                className="input"
              />
            </Field>
            <Field
              label="Shared secret"
              hint="The device's P2P_DEVICE_SECRET. Presented on register so the signaling server pairs you with the device."
            >
              <input
                type="password"
                value={values.webrtcSecret}
                onChange={(e) => set("webrtcSecret", e.target.value)}
                placeholder="••••••••"
                className="input"
              />
            </Field>
            <Field
              label="Client ID (optional)"
              hint="The id DevDash registers as. Leave blank to auto-generate a random devdash-<uuid>."
            >
              <input
                value={values.clientId}
                onChange={(e) => set("clientId", e.target.value)}
                placeholder="devdash-laptop"
                className="input"
              />
            </Field>
            <Field
              label="ICE servers"
              hint="One per line: `url [username] [credential]`. STUN needs only the URL; TURN adds username and credential."
            >
              <textarea
                value={values.iceServersText}
                onChange={(e) => set("iceServersText", e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={
                  "stun:stun.l.google.com:19302\nturn:turn.example.com:3478 user pass"
                }
                className="input font-mono"
              />
            </Field>
            <Field
              label="Channel label prefix (optional)"
              hint="DataChannel label the agent bridges to local sshd. Defaults to `ssh`."
            >
              <input
                value={values.channelLabel}
                onChange={(e) => set("channelLabel", e.target.value)}
                placeholder="ssh"
                className="input"
              />
            </Field>
          </div>
        ) : null}
        <Field label="Auth type">
          <div className="flex gap-2">
            {(["key", "password"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set("authType", t)}
                className={`rounded border px-3 py-1 text-xs ${
                  values.authType === t
                    ? "border-(--color-accent) bg-(--color-accent) text-white"
                    : "border-(--color-border) hover:bg-(--color-surface-2)"
                }`}
              >
                {t === "key" ? "SSH key" : "Password"}
              </button>
            ))}
          </div>
        </Field>
        {values.authType === "key" ? (
          <Field
            label="Key path"
            error={errors.keyPath}
            hint="Absolute path to your private key. Passphrase (if any) goes in Secret."
          >
            <input
              value={values.keyPath}
              onChange={(e) => set("keyPath", e.target.value)}
              placeholder="/home/you/.ssh/id_ed25519"
              className="input"
            />
          </Field>
        ) : null}
        <Field
          label={
            values.authType === "key"
              ? editing
                ? "Key passphrase (leave empty to keep stored)"
                : "Key passphrase (optional)"
              : editing
                ? "Password (leave empty to keep stored)"
                : "Password"
          }
          error={errors.secret}
          hint={
            editing
              ? "Stored in your OS keychain. Type a new value to replace it; leave empty to keep what's already saved."
              : "Stored in your OS keychain — never written to the database."
          }
        >
          <input
            type="password"
            value={values.secret}
            onChange={(e) => set("secret", e.target.value)}
            placeholder={editing ? "•••••••• (unchanged)" : ""}
            className="input"
          />
        </Field>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={values.useSudo}
            onChange={(e) => set("useSudo", e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-(--color-fg)">
              Run commands with sudo
            </span>
            <span className="mt-0.5 block text-(--color-fg-muted)">
              When enabled, DevNest wraps each command with{" "}
              <code className="font-mono">sudo -S</code> and prompts for your
              sudo password the first time it&apos;s needed.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={values.keepAlive}
            onChange={(e) => set("keepAlive", e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-(--color-fg)">
              Keep connection alive
            </span>
            <span className="mt-0.5 block text-(--color-fg-muted)">
              Send SSH keepalive packets every 30 s so NAT/firewall timeouts and
              the server&apos;s{" "}
              <code className="font-mono">ClientAliveInterval</code> don&apos;t
              drop the idle connection.
            </span>
          </span>
        </label>
        <Field
          label="Sudo prefix override (optional)"
          hint="Advanced: prepended to commands instead of `sudo`. Leave blank for default."
        >
          <input
            value={values.sudoPrefix}
            onChange={(e) => set("sudoPrefix", e.target.value)}
            placeholder=""
            className="input"
          />
        </Field>
        {submitError && (
          <p className="rounded bg-red-500/10 px-2 py-1 text-xs text-(--color-error)">
            {submitError}
          </p>
        )}
      </form>
    </Modal>
  );
}

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, error, hint, children }: FieldProps) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-(--color-fg-muted)">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-(--color-error)">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-(--color-fg-muted)">{hint}</span>
      ) : null}
    </label>
  );
}
