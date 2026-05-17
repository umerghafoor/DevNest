import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, type SystemdUnit } from "../lib/api";
import { withSudo } from "../lib/with-sudo";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { SkeletonCard } from "../components/Skeleton";
import { highlightUnit } from "../lib/unit-highlight";

interface Props {
  deviceId: string;
}

type View = { kind: "list" } | { kind: "edit"; name: string; isNew: boolean };

export function SystemdPanel({ deviceId }: Props) {
  const [units, setUnits] = useState<SystemdUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      // First try without sudo (read-only). If permission denied, escalate.
      const list = await withSudo(deviceId, () => api.systemdList(deviceId));
      setUnits(list);
    } catch (e) {
      setError(errorMessage(e));
      setUnits([]);
    }
  }, [deviceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    if (!units) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return units;
    return units.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.description.toLowerCase().includes(q),
    );
  }, [units, filter]);

  const doAction = async (
    u: SystemdUnit,
    action: "start" | "stop" | "restart" | "enable" | "disable",
  ) => {
    setBusy(`${u.name}:${action}`);
    try {
      await withSudo(deviceId, () =>
        api.systemdAction(deviceId, u.name, action),
      );
      toast.success(`${action} ${u.name}`);
      await reload();
    } catch (e) {
      toast.error(`${action} failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (view.kind === "edit") {
    return (
      <UnitEditor
        deviceId={deviceId}
        name={view.name}
        isNew={view.isNew}
        onClose={() => setView({ kind: "list" })}
        onSaved={() => {
          setView({ kind: "list" });
          void reload();
        }}
      />
    );
  }

  if (error && !units?.length) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-(--color-error)">
        {error}
      </div>
    );
  }

  if (!units) {
    return (
      <div className="space-y-3 p-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <h2 className="text-sm font-semibold">systemd</h2>
        <span className="text-xs text-(--color-fg-muted)">
          {units.length} units
        </span>
        <input
          className="input ml-3 max-w-xs"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => void reload()}
            className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            title="Reload"
          >
            ↻
          </button>
          <button
            onClick={() =>
              setView({ kind: "edit", name: "new.service", isNew: true })
            }
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
          >
            New service
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            No units match.
          </div>
        ) : (
          <ul>
            {filtered.map((u) => (
              <UnitRow
                key={u.name}
                unit={u}
                busy={busy}
                onAction={(a) => void doAction(u, a)}
                onEdit={() =>
                  setView({ kind: "edit", name: u.name, isNew: false })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UnitRow({
  unit,
  busy,
  onAction,
  onEdit,
}: {
  unit: SystemdUnit;
  busy: string | null;
  onAction: (a: "start" | "stop" | "restart" | "enable" | "disable") => void;
  onEdit: () => void;
}) {
  const isActive = unit.active === "active" || unit.sub === "running";
  const isFailed = unit.active === "failed" || unit.sub === "failed";
  const dot = isFailed
    ? "bg-(--color-error)"
    : isActive
      ? "bg-(--color-online)"
      : "bg-(--color-offline)";
  const isEnabled = unit.unitFileState === "enabled";
  const actionBusy = (a: string) => busy === `${unit.name}:${a}`;

  return (
    <li className="row-animate flex items-center gap-3 border-b border-(--color-border) px-3 py-1.5 text-sm hover:bg-(--color-surface-2)/40">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <button
        onClick={onEdit}
        className="min-w-0 flex-1 text-left"
        title="View / edit unit file"
      >
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12px]">{unit.name}</span>
          <span className="rounded bg-(--color-surface-2) px-1.5 py-0.5 text-[10px] text-(--color-fg-muted)">
            {unit.active}/{unit.sub}
          </span>
          {isEnabled && (
            <span className="rounded bg-(--color-accent)/15 px-1.5 py-0.5 text-[10px] text-(--color-accent)">
              enabled
            </span>
          )}
        </div>
        {unit.description && (
          <div className="truncate text-[11px] text-(--color-fg-muted)">
            {unit.description}
          </div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {isActive ? (
          <ActionBtn onClick={() => onAction("stop")} busy={actionBusy("stop")}>
            Stop
          </ActionBtn>
        ) : (
          <ActionBtn
            onClick={() => onAction("start")}
            busy={actionBusy("start")}
          >
            Start
          </ActionBtn>
        )}
        <ActionBtn
          onClick={() => onAction("restart")}
          busy={actionBusy("restart")}
        >
          Restart
        </ActionBtn>
        <ActionBtn
          onClick={() =>
            onAction(unit.unitFileState === "enabled" ? "disable" : "enable")
          }
          busy={actionBusy("enable") || actionBusy("disable")}
        >
          {unit.unitFileState === "enabled" ? "Disable" : "Enable"}
        </ActionBtn>
      </div>
    </li>
  );
}

function ActionBtn({
  onClick,
  busy,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-0.5 text-[11px] hover:bg-(--color-surface-2) disabled:opacity-40"
    >
      {busy ? "…" : children}
    </button>
  );
}

// ─── Unit editor ─────────────────────────────────────────────────────────────

interface UnitFields {
  description: string;
  after: string;
  execStart: string;
  user: string;
  restart: string;
  wantedBy: string;
}

const DEFAULT_NEW = `[Unit]
Description=My App Service
After=network.target

[Service]
ExecStart=/usr/bin/python3 /home/me/myapp.py
Restart=always
User=me

[Install]
WantedBy=multi-user.target
`;

function UnitEditor({
  deviceId,
  name,
  isNew,
  onClose,
  onSaved,
}: {
  deviceId: string;
  name: string;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [unitName, setUnitName] = useState(name);
  const [content, setContent] = useState<string | null>(
    isNew ? DEFAULT_NEW : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"form" | "text">("form");

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    void withSudo(deviceId, () => api.systemdCat(deviceId, name))
      .then((c) => {
        if (cancelled) return;
        // `systemctl cat` prepends a `# /path/to/file` comment line. Keep it
        // for transparency but it doesn't affect parsing.
        setContent(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, name, isNew]);

  const fields = useMemo<UnitFields>(
    () => parseFields(content ?? ""),
    [content],
  );

  const updateField = (k: keyof UnitFields, v: string) => {
    if (content === null) return;
    setContent(updateFieldInContent(content, k, v));
  };

  const save = async () => {
    if (content === null) return;
    const targetName = unitName.trim();
    if (!targetName.endsWith(".service")) {
      toast.error("Unit name must end with .service");
      return;
    }
    setSaving(true);
    try {
      await withSudo(deviceId, () =>
        api.systemdWriteUnit(deviceId, targetName, stripCatHeader(content)),
      );
      toast.success(`Saved ${targetName}`);
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm(
      `Delete /etc/systemd/system/${name}? This cannot be undone.`,
      { title: "Delete unit file", destructive: true },
    );
    if (!ok) return;
    try {
      await withSudo(deviceId, () => api.systemdDeleteUnit(deviceId, name));
      toast.success(`Deleted ${name}`);
      onSaved();
    } catch (e) {
      toast.error(`Delete failed: ${errorMessage(e)}`);
    }
  };

  if (content === null && !error) {
    return (
      <div className="p-4">
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          ← Back
        </button>
        <input
          className="input max-w-xs font-mono text-xs"
          value={unitName}
          onChange={(e) => setUnitName(e.target.value)}
          disabled={!isNew}
          placeholder="my-app.service"
        />
        <div className="ml-3 flex overflow-hidden rounded-md border border-(--color-border)">
          <button
            onClick={() => setTab("form")}
            className={`px-3 py-1 text-xs ${
              tab === "form"
                ? "bg-(--color-accent) text-(--color-accent-fg)"
                : "bg-(--color-bg) text-(--color-fg-muted) hover:bg-(--color-surface-2)"
            }`}
          >
            Form
          </button>
          <button
            onClick={() => setTab("text")}
            className={`px-3 py-1 text-xs ${
              tab === "text"
                ? "bg-(--color-accent) text-(--color-accent-fg)"
                : "bg-(--color-bg) text-(--color-fg-muted) hover:bg-(--color-surface-2)"
            }`}
          >
            Text
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!isNew && (
            <button
              onClick={() => void remove()}
              className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
            >
              Delete
            </button>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save (sudo)"}
          </button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-(--color-border) bg-(--color-error)/10 px-3 py-2 text-xs text-(--color-error)">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "form" ? (
          <FormView fields={fields} onChange={updateField} />
        ) : (
          <TextView content={content ?? ""} onChange={setContent} />
        )}
      </div>
    </div>
  );
}

function FormView({
  fields,
  onChange,
}: {
  fields: UnitFields;
  onChange: (k: keyof UnitFields, v: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-5">
        <Section title="[Unit]">
          <Field
            label="Description"
            value={fields.description}
            onChange={(v) => onChange("description", v)}
            placeholder="My App Service"
          />
          <Field
            label="After"
            hint="Order this unit after these targets (space-separated)."
            value={fields.after}
            onChange={(v) => onChange("after", v)}
            placeholder="network.target"
          />
        </Section>
        <Section title="[Service]">
          <Field
            label="ExecStart"
            hint="The command to run. Use absolute paths."
            value={fields.execStart}
            onChange={(v) => onChange("execStart", v)}
            placeholder="/usr/bin/python3 /home/me/myapp.py"
            mono
          />
          <Field
            label="User"
            value={fields.user}
            onChange={(v) => onChange("user", v)}
            placeholder="me"
          />
          <Field
            label="Restart"
            hint="When systemd should restart the service."
            value={fields.restart}
            onChange={(v) => onChange("restart", v)}
            placeholder="always"
            options={[
              "no",
              "on-success",
              "on-failure",
              "on-abnormal",
              "on-watchdog",
              "on-abort",
              "always",
            ]}
          />
        </Section>
        <Section title="[Install]">
          <Field
            label="WantedBy"
            hint="Target to attach this service to when enabled."
            value={fields.wantedBy}
            onChange={(v) => onChange("wantedBy", v)}
            placeholder="multi-user.target"
          />
        </Section>
        <p className="text-[11px] text-(--color-fg-muted)">
          The Text tab has the raw file. Adding any field not shown here is fine
          — switch to Text mode for fields like Environment, WorkingDirectory,
          ExecStop, etc.
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-xs font-semibold text-(--color-accent)">
        {title}
      </h3>
      <div className="space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono,
  options,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  options?: string[];
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs text-(--color-online)">{label}</span>
        {hint && (
          <span className="truncate text-[10px] text-(--color-fg-muted)">
            {hint}
          </span>
        )}
      </div>
      {options ? (
        <select
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">(unset)</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={`input ${mono ? "font-mono text-xs" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
      )}
    </label>
  );
}

function TextView({
  content,
  onChange,
}: {
  content: string;
  onChange: (v: string) => void;
}) {
  const highlighted = useMemo(() => highlightUnit(content), [content]);
  return (
    <div className="relative h-full">
      {/* Highlighted overlay (read-only, behind the textarea). */}
      <pre
        aria-hidden
        className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre p-4 font-mono text-[13px] leading-[1.55]"
      >
        {highlighted.map((l) => (
          <div key={l.key}>{l.node}</div>
        ))}
      </pre>
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        wrap="off"
        className="absolute inset-0 m-0 resize-none overflow-auto whitespace-pre bg-transparent p-4 font-mono text-[13px] leading-[1.55] text-transparent caret-(--color-accent) outline-none selection:bg-(--color-accent)/30 selection:text-(--color-fg)"
      />
    </div>
  );
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function stripCatHeader(content: string): string {
  // `systemctl cat` prepends a "# /path/to/unit" line; drop it when writing back.
  const lines = content.split("\n");
  if (lines[0]?.startsWith("# /")) return lines.slice(1).join("\n").trimStart();
  return content;
}

function parseFields(content: string): UnitFields {
  const lines = content.split("\n");
  let section = "";
  const get = (sec: string, key: string): string => {
    let cur = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("#") || line.startsWith(";") || line === "") continue;
      const sm = line.match(/^\[([^\]]+)\]$/);
      if (sm) {
        cur = sm[1];
        continue;
      }
      if (cur !== sec) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
    }
    return "";
  };
  void section;
  return {
    description: get("Unit", "Description"),
    after: get("Unit", "After"),
    execStart: get("Service", "ExecStart"),
    user: get("Service", "User"),
    restart: get("Service", "Restart"),
    wantedBy: get("Install", "WantedBy"),
  };
}

function updateFieldInContent(
  content: string,
  key: keyof UnitFields,
  value: string,
): string {
  const mapping: Record<keyof UnitFields, { section: string; key: string }> = {
    description: { section: "Unit", key: "Description" },
    after: { section: "Unit", key: "After" },
    execStart: { section: "Service", key: "ExecStart" },
    user: { section: "Service", key: "User" },
    restart: { section: "Service", key: "Restart" },
    wantedBy: { section: "Install", key: "WantedBy" },
  };
  const { section, key: k } = mapping[key];
  return setKeyInSection(content, section, k, value);
}

/**
 * Replace `Key=...` within `[Section]`, inserting the section and/or key if
 * missing. Preserves comments and unrelated keys.
 */
function setKeyInSection(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = content.split("\n");
  let inSection = false;
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let keyLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sm = trimmed.match(/^\[([^\]]+)\]$/);
    if (sm) {
      if (sm[1] === section) {
        inSection = true;
        sectionStart = i;
      } else if (inSection) {
        sectionEnd = i;
        break;
      } else {
        inSection = false;
      }
      continue;
    }
    if (inSection && sectionStart !== -1) {
      const eq = trimmed.indexOf("=");
      if (eq !== -1 && trimmed.slice(0, eq).trim() === key) {
        keyLineIdx = i;
      }
    }
  }
  if (inSection && sectionStart !== -1 && sectionEnd === lines.length) {
    // section runs to end
  }

  if (keyLineIdx !== -1) {
    if (value.trim() === "") {
      lines.splice(keyLineIdx, 1);
    } else {
      lines[keyLineIdx] = `${key}=${value}`;
    }
    return lines.join("\n");
  }

  if (value.trim() === "") return content; // nothing to do

  if (sectionStart === -1) {
    // Section doesn't exist yet — append.
    const prefix =
      lines.length > 0 && lines[lines.length - 1].trim() !== "" ? "\n" : "";
    return `${content}${prefix}\n[${section}]\n${key}=${value}\n`;
  }

  // Insert key at end of section.
  const insertAt = sectionEnd === lines.length ? sectionEnd : sectionEnd;
  // Trim trailing blank lines inside the section so the new key lands tightly.
  let target = insertAt;
  while (target > sectionStart + 1 && lines[target - 1].trim() === "") target--;
  lines.splice(target, 0, `${key}=${value}`);
  return lines.join("\n");
}
