// Module-level subscription so the account-events stream (device.changed) can
// ask an open devices page to refetch without coupling the stream hook to the
// page. Copied from v1's devices page, which keeps it inline.
const listeners = new Set<() => void>();

/** Subscribe to device changes; returns the unsubscribe function. */
export function subscribeDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell any mounted devices page to refetch (wired to `device.changed`). */
export function notifyDevicesChanged(): void {
  for (const listener of listeners) listener();
}
