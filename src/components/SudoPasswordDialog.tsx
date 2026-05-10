import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useSudoStore } from "../store/sudo-store";
import { Modal } from "./Modal";

export function SudoPasswordDialog() {
  const prompt = useSudoStore((s) => s.prompt);
  const close = useSudoStore((s) => s.close);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!prompt) return null;

  const cancel = () => {
    if (submitting) return;
    setPassword("");
    setError(null);
    close(false);
  };

  const submit = async () => {
    if (!password) {
      setError("Password is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.setSudoPassword(prompt.deviceId, password);
      setPassword("");
      close(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={cancel}
      title="Sudo password required"
      footer={
        <>
          <button
            onClick={cancel}
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
            {submitting ? "Saving…" : "Save & retry"}
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
        <p className="text-xs text-(--color-fg-muted)">
          DevNest needs your sudo password for{" "}
          <span className="font-medium text-(--color-fg)">
            {prompt.deviceName}
          </span>
          . It will be stored in your OS keychain and reused for future commands
          on this device.
        </p>
        <label className="block text-xs">
          <span className="mb-1 block text-(--color-fg-muted)">
            Sudo password
          </span>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </label>
        {error && (
          <p className="rounded bg-red-500/10 px-2 py-1 text-xs text-(--color-error)">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
