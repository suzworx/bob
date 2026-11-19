import { useCallback, useSyncExternalStore } from 'react';
import { isDeviceOnline, listDevices, type ActiveConversation, type ActiveSpace, type Device } from './devices-api';
import { subscribeDevices } from './devices-events';

// The account's paired devices, read once and shared by every surface that
// shows them (the Devices page, the chat header control, the rail summary):
// one GET /api/devices per event instead of one per component. It re-reads on
// device.changed (subscribeDevices), and useDeviceConversation's
// bob:active-changed listener asks it to re-read too; only while something is
// mounted. The last unmount forgets it, so the next mount reads fresh.


export type DevicesSnapshot = {
  state: 'loading' | 'ready' | 'failed';
  devices: Device[];
  activeSpace: ActiveSpace | null;
  activeConversation: ActiveConversation | null;
  /** Bumped on every successful read, so dependants (Recent) re-read too. */
  loads: number;
};

const INITIAL: DevicesSnapshot = { state: 'loading', devices: [], activeSpace: null, activeConversation: null, loads: 0 };

let snapshot: DevicesSnapshot = INITIAL;
let subscribers = 0;
// A read started before the last unmount is ignored when it lands.
let generation = 0;
let inFlight: Promise<void> | null = null;
let stopListening: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: DevicesSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Re-reads the list. A failure after a good read keeps the list on screen. */
export function refreshDevices(): Promise<void> {
  if (subscribers === 0) return Promise.resolve();
  if (inFlight !== null) return inFlight;
  const started = generation;
  if (snapshot.state === 'failed') publish({ ...snapshot, state: 'loading' });
  inFlight = (async () => {
    try {
      const { devices, activeSpace, activeConversation } = await listDevices();
      if (started !== generation) return;
      publish({ state: 'ready', devices, activeSpace, activeConversation, loads: snapshot.loads + 1 });
    } catch {
      if (started !== generation) return;
      if (snapshot.state !== 'ready') publish({ ...snapshot, state: 'failed' });
    } finally {
      if (started === generation) inFlight = null;
    }
  })();
  return inFlight;
}

/** Replaces one device's fields with what the server just acknowledged. */
export function updateStoredDevice(id: string, patch: Partial<Device>): void {
  publish({ ...snapshot, devices: snapshot.devices.map((device) => (device.id === id ? { ...device, ...patch } : device)) });
}

/** Drops a removed device without waiting for the next read. */
export function forgetStoredDevice(id: string): void {
  publish({ ...snapshot, devices: snapshot.devices.filter((device) => device.id !== id) });
}

function startListening(): () => void {
  return subscribeDevices(() => void refreshDevices());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) {
    stopListening = startListening();
    // Counted first, so this read is not skipped.
    void refreshDevices();
  }
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) {
      stopListening?.();
      stopListening = null;
      generation += 1;
      inFlight = null;
      snapshot = INITIAL;
    }
  };
}

const read = (): DevicesSnapshot => snapshot;

/** The account's devices, shared across the app. */
export function useDevices(): DevicesSnapshot & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, read, read);
  const refresh = useCallback(() => refreshDevices(), []);
  return { ...current, refresh };
}

/** How many devices are paired, and how many of them are online now. */
export function useDevicesSummary(): { connected: number; total: number } {
  const { devices } = useDevices();
  return { connected: devices.filter(isDeviceOnline).length, total: devices.length };
}
