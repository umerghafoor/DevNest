import {
  isPermissionDeniedError,
  isSudoRequired,
  sudoRequiredDeviceId,
} from "./api";
import { useAppStore } from "../store/app-store";
import { useSudoStore } from "../store/sudo-store";
import { api } from "./api";

/**
 * Run a thunk that may need sudo. Two cases:
 *
 *   1. Backend signals `SudoPasswordRequired` (use_sudo is on, but no password
 *      stored or stored one was wrong) → prompt, save, retry.
 *
 *   2. Backend returns a generic permission-denied (e.g. docker socket EACCES)
 *      → offer to enable sudo for this device + prompt for password, then retry.
 *
 * `deviceId` lets case (2) know which device to escalate. Case (1) carries it
 * in the error payload itself.
 */
export async function withSudo<T>(
  deviceId: string,
  thunk: () => Promise<T>,
): Promise<T> {
  try {
    return await thunk();
  } catch (e) {
    if (isSudoRequired(e)) {
      const id = sudoRequiredDeviceId(e) ?? deviceId;
      const saved = await promptForSudo(id);
      if (!saved) throw e;
      return await thunk();
    }

    if (isPermissionDeniedError(e)) {
      const enabled = await offerSudoEscalation(deviceId);
      if (!enabled) throw e;
      const saved = await promptForSudo(deviceId);
      if (!saved) throw e;
      return await thunk();
    }

    throw e;
  }
}

async function promptForSudo(deviceId: string): Promise<boolean> {
  const device = useAppStore.getState().devices.find((d) => d.id === deviceId);
  return useSudoStore.getState().request(deviceId, device?.name ?? deviceId);
}

async function offerSudoEscalation(deviceId: string): Promise<boolean> {
  const device = useAppStore.getState().devices.find((d) => d.id === deviceId);
  if (!device) return false;
  if (device.useSudo) return true; // already on; just need password
  const ok = window.confirm(
    `This command failed with a permission error on "${device.name}".\n\n` +
      `Enable sudo for this device? You'll be asked for your sudo password ` +
      `next, and DevNest will retry automatically.`,
  );
  if (!ok) return false;
  const updated = await api.setUseSudo(deviceId, true);
  useAppStore.getState().upsertDevice(updated);
  return true;
}
