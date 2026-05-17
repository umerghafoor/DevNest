import { useState } from "react";
import { useServicesStore, type ServiceDef } from "../store/services-store";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";

export function ServicesPanel() {
  const services = useServicesStore((s) => s.services);
  const add = useServicesStore((s) => s.add);
  const remove = useServicesStore((s) => s.remove);
  const setStatus = useServicesStore((s) => s.setStatus);
  const [showForm, setShowForm] = useState(false);

  const toggle = (svc: ServiceDef) => {
    if (svc.status === "running") {
      setStatus(svc.id, "stopped");
      toast.info(`${svc.name} marked stopped`);
    } else {
      setStatus(svc.id, "running");
      toast.success(`${svc.name} marked running`);
    }
  };

  const onDelete = async (svc: ServiceDef) => {
    const ok = await confirm(`Remove service "${svc.name}"?`, {
      title: "Remove service",
      destructive: true,
    });
    if (ok) remove(svc.id);
  };

  return (
    <div className="fade-up flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <div>
          <h2 className="text-sm font-semibold">Services</h2>
          <p className="text-xs text-(--color-fg-muted)">
            Local service definitions. Spawning requires a backend command —
            currently tracks state only.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
        >
          New service
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {services.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-(--color-fg-muted)">
            No services yet. Click &quot;New service&quot; to define one.
          </div>
        ) : (
          <ul className="space-y-2">
            {services.map((svc) => (
              <li
                key={svc.id}
                className="row-animate flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2"
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    svc.status === "running"
                      ? "bg-(--color-online)"
                      : svc.status === "error"
                        ? "bg-(--color-error)"
                        : "bg-(--color-offline)"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{svc.name}</div>
                  <div className="truncate font-mono text-[11px] text-(--color-fg-muted)">
                    {svc.command}
                  </div>
                  {svc.cwd && (
                    <div className="truncate text-[10px] text-(--color-fg-muted)">
                      cwd: {svc.cwd}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggle(svc)}
                  className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
                >
                  {svc.status === "running" ? "Stop" : "Start"}
                </button>
                <button
                  onClick={() => void onDelete(svc)}
                  className="rounded px-1.5 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showForm && (
        <NewServiceForm
          onSubmit={(def) => {
            add(def);
            setShowForm(false);
            toast.success(`Added ${def.name}`);
          }}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function NewServiceForm({
  onSubmit,
  onClose,
}: {
  onSubmit: (def: { name: string; command: string; cwd: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    onSubmit({ name: name.trim(), command: command.trim(), cwd: cwd.trim() });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-(--color-border) bg-(--color-bg) p-4 shadow-xl"
      >
        <h3 className="mb-3 text-sm font-semibold">New service</h3>
        <div className="space-y-3">
          <label className="block">
            <div className="mb-1 text-xs text-(--color-fg-muted)">Name</div>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-api"
              autoFocus
            />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-(--color-fg-muted)">Command</div>
            <input
              className="input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm run dev"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-(--color-fg-muted)">
              Working directory (optional)
            </div>
            <input
              className="input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/me/project"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
          >
            Add
          </button>
        </div>
      </form>
    </div>
  );
}
