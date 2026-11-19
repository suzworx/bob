import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Smartphone } from 'lucide-react';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { isDeviceOnline, listDevices } from './devices-api';
import { subscribeDevices } from './devices-events';
import { refreshDevices } from './use-devices';

// What a device talks in (#492, docs/design/device-conversation.md): one
// hook every surface shares. It reads the account's pointer (GET /api/active),
// re-reads it when the shell relays the account SSE `active.changed`
// (bob:active-changed), and moves it with PUT /api/devices/active-conversation.
// A 202 {status:'pending'} (#668: paired but offline) keeps its status line up
// until a device.changed shows the device online, which then reads applied.
// A second send while one is in flight is `busy`: ignored, never a failure.

export type DeviceTarget = {
  // null starts a new conversation on the device.
  conversationId: string | null;
  // The space the device works in; null is General.
  spaceId: string | null;
  // A space thread to talk in (#565); sent with conversationId null and the thread's space.
  threadId?: string;
};

export type DeviceSendResult = 'sent' | 'pending' | 'no_device' | 'failed' | 'busy';

type DeviceItemsOptions = {
  // Offers "Use on <device>" for this conversation; omitted where there is
  // no conversation to send.
  conversationId?: string;
  // Offers "Use on <device>" for this space thread (#565), in spaceId.
  threadId?: string;
  spaceId: string | null;
  // Names the space in the "new conversation" item; without it, "this space".
  spaceName?: string;
  // Which surface or row shows the status line; defaults to the target.
  statusKey?: string;
};

export type DeviceConversation = {
  // The paired name of the device these actions reach: the scoped device, else
  // the account's only device; null with none or several (labels say "device").
  deviceName?: string | null;
  activeId: string | null;
  activeTitle: string | null;
  // The last result's text, for the surface that asked, while it shows.
  status: { key: string; text: string } | null;
  // True while a send is in flight; pickers disable their rows meanwhile.
  isSending?: boolean;
  // #900: deviceId omitted uses the hook's own scope (see useDeviceConversation);
  // null forces the account-wide write; a string targets
  // that one device instead.
  send: (target: DeviceTarget, statusKey?: string, deviceId?: string | null) => Promise<DeviceSendResult>;
  items: (options: DeviceItemsOptions) => DropdownMenuOption[];
};

const STATUS_MS = 2500;
export const DEVICE_STATUS: Record<Exclude<DeviceSendResult, 'busy'>, string> = {
  sent: 'Sent to device.',
  pending: 'Pending — applies when the device reconnects.',
  no_device: 'No device is connected.',
  failed: 'Could not reach the device.',
};
export const DEVICE_APPLIED = 'Applied on the device.';

// The status line with the device's name where it is known.
export function deviceStatusText(result: Exclude<DeviceSendResult, 'busy'>, name: string | null): string {
  switch (result) {
    case 'sent':
      return `Sent to ${name ?? 'device'}.`;
    case 'pending':
      return `Pending — applies when ${name ?? 'the device'} reconnects.`;
    case 'no_device':
      return name === null ? DEVICE_STATUS.no_device : `${name} is not connected.`;
    case 'failed':
      return `Could not reach ${name ?? 'the device'}.`;
  }
}

// GET /api/active names a thread pointer by this id (#565, D2).
export function threadRef(threadId: string): string {
  return `thr_${threadId}`;
}

function keyFor(target: DeviceTarget): string {
  if (target.threadId !== undefined) return threadRef(target.threadId);
  return target.conversationId ?? `new:${target.spaceId ?? 'main'}`;
}

// A 2xx is sent, unless it is the 202 {status:'pending'} of an offline device.
async function sentOrPending(response: Response): Promise<'sent' | 'pending'> {
  if (response.status !== 202) return 'sent';
  const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
  return body?.status === 'pending' ? 'pending' : 'sent';
}

// GET /api/active's body, narrowed by hand: no pointer and a cleared one both read as none.
function readActive(body: unknown): { id: string | null; title: string | null } {
  const active = (body as { active?: unknown } | null)?.active;
  if (typeof active !== 'object' || active === null) return { id: null, title: null };
  const { conversation_id: id, title } = active as { conversation_id?: unknown; title?: unknown };
  return { id: typeof id === 'string' ? id : null, title: typeof title === 'string' ? title : null };
}

// `readOnMount: false` is for a surface that already read the pointer itself
// (the Devices page's GET /api/devices); it still follows bob:active-changed.
// `deviceId` (#900) scopes the hook to one Cardputer: it reads that device's
// own pointer (falling back to the account pointer when the device has none
// of its own, same resolution rule the server applies) and writes with that
// device_id by default. Omitted, the hook behaves exactly as before #900.
export function useDeviceConversation(
  { readOnMount = true, deviceId }: { readOnMount?: boolean; deviceId?: string } = {},
): DeviceConversation {
  const [active, setActive] = useState<{ id: string | null; title: string | null }>({ id: null, title: null });
  const [status, setStatus] = useState<{ key: string; text: string } | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingKey = useRef<string | null>(null);
  // The device a pending action targets, for the reconnect check below; may
  // differ from the hook's own deviceId when a call overrides it (the picker's
  // Cardputer choice).
  const pendingDeviceId = useRef<string | undefined>(undefined);

  // A pending line stays until the device reconnects; every other one fades.
  const show = useCallback((next: { key: string; text: string }, fades: boolean): void => {
    setStatus(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = fades ? setTimeout(() => setStatus(null), STATUS_MS) : null;
  }, []);

  // #900: scoped to one device, the pointer comes from its own GET /api/devices
  // row instead of the account-wide GET /api/active; its title is known only
  // when it still matches the account pointer -- a diverged own pointer (another
  // device moved the account one since) is resolved locally by the caller.
  const refetchDevice = useCallback(async (id: string): Promise<void> => {
    try {
      const { devices, activeConversation } = await listDevices();
      setDeviceName(devices.find((device) => device.id === id)?.name ?? null);
      const ownId = devices.find((device) => device.id === id)?.active_conversation_id ?? null;
      const resolvedId = ownId ?? activeConversation?.id ?? null;
      const title = resolvedId === activeConversation?.id ? activeConversation?.title ?? null : null;
      setActive({ id: resolvedId, title });
    } catch {
      // The marker keeps its previous value.
    }
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    if (deviceId !== undefined) {
      await refetchDevice(deviceId);
      return;
    }
    try {
      const response = await fetchWithAuth('/api/active');
      if (response.ok) setActive(readActive(await response.json()));
    } catch {
      // The marker keeps its previous value.
    }
  }, [deviceId, refetchDevice]);

  // The account's only device names the labels; read once per mount, not on every refetch.
  useEffect(() => {
    if (!readOnMount || deviceId !== undefined) return;
    let live = true;
    listDevices()
      .then(({ devices }) => {
        if (live) setDeviceName(devices.length === 1 ? devices[0].name : null);
      })
      .catch(() => {}); // Labels keep the generic word.
    return () => {
      live = false;
    };
  }, [readOnMount, deviceId]);

  useEffect(() => {
    if (readOnMount) void refetch();
    // The shared device list carries each device's own pointer; re-read it too.
    const onActiveChanged = (): void => {
      void refetch();
      void refreshDevices();
    };
    window.addEventListener('bob:active-changed', onActiveChanged);
    return () => {
      window.removeEventListener('bob:active-changed', onActiveChanged);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [readOnMount, refetch]);

  // device.changed carries presence: once the device is online, it has
  // taken the stored pointer from its welcome.
  useEffect(
    () =>
      subscribeDevices(() => {
        const key = pendingKey.current;
        if (key === null) return;
        const targetId = pendingDeviceId.current;
        void listDevices()
          .then(({ devices }) => {
            const reachable = devices.some(
              (d) => (targetId === undefined || d.id === targetId) && isDeviceOnline(d),
            );
            if (pendingKey.current !== key || !reachable) return;
            pendingKey.current = null;
            show({ key, text: DEVICE_APPLIED }, true);
          })
          .catch(() => {});
      }),
    [show],
  );

  const send = useCallback(
    async (target: DeviceTarget, statusKey?: string, overrideDeviceId?: string | null): Promise<DeviceSendResult> => {
      // A double click or a second pick while one is in flight is ignored,
      // never reported as a failure.
      if (inFlight.current) return 'busy';
      // Not given: use this hook's own scope. Explicit null: account-wide.
      // A string: target that one device instead (#900).
      const effectiveDeviceId = overrideDeviceId === undefined ? deviceId : (overrideDeviceId ?? undefined);
      inFlight.current = true;
      setIsSending(true);
      setStatus(null);
      let result: Exclude<DeviceSendResult, 'busy'> = 'failed';
      try {
        const response = await fetchWithAuth('/api/devices/active-conversation', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: target.conversationId,
            space_id: target.spaceId,
            ...(target.threadId === undefined ? {} : { thread_id: target.threadId }),
            device_id: effectiveDeviceId,
          }),
        });
        result = response.ok ? await sentOrPending(response) : response.status === 409 ? 'no_device' : 'failed';
      } catch {
        result = 'failed';
      }
      inFlight.current = false;
      setIsSending(false);
      // The marker follows the server, never the click.
      if (result === 'sent' || result === 'pending') await refetch();
      const key = statusKey ?? keyFor(target);
      pendingKey.current = result === 'pending' ? key : null;
      pendingDeviceId.current = result === 'pending' ? effectiveDeviceId : undefined;
      show({ key, text: deviceStatusText(result, deviceName) }, result !== 'pending');
      return result;
    },
    [deviceId, deviceName, refetch, show],
  );

  const items = useCallback(
    ({ conversationId, threadId, spaceId, spaceName, statusKey }: DeviceItemsOptions): DropdownMenuOption[] => {
      const deviceLabel = deviceName ?? 'device';
      const options: DropdownMenuOption[] = [];
      if (threadId !== undefined && spaceId !== null) {
        const here = threadRef(threadId) === active.id;
        options.push({
          // Stable action-catalog ids: they are named from this id, not the label.
          id: 'use-on-cardputer',
          label: `Use on ${deviceLabel}`,
          icon: Smartphone,
          description: here ? `${deviceLabel} is in this thread` : undefined,
          isDisabled: here,
          onClick: () => void send({ conversationId: null, spaceId, threadId }, statusKey),
        });
      } else if (conversationId !== undefined) {
        const here = conversationId === active.id;
        options.push({
          // Stable action-catalog ids: they are named from this id, not the label.
          id: 'use-on-cardputer',
          label: `Use on ${deviceLabel}`,
          icon: Smartphone,
          description: here ? `${deviceLabel} is in this conversation` : undefined,
          isDisabled: here,
          onClick: () => void send({ conversationId, spaceId: null }, statusKey),
        });
      }
      options.push({
        id: 'new-conversation-on-cardputer',
        label: `New conversation on ${deviceLabel}`,
        icon: MessageSquarePlus,
        description: spaceId === null ? 'Starts in General' : spaceName ? `Starts in ${spaceName}` : 'Starts in this space',
        onClick: () => void send({ conversationId: null, spaceId }, statusKey),
      });
      return options;
    },
    [active.id, deviceName, send],
  );

  return { deviceName, activeId: active.id, activeTitle: active.title, status, isSending, send, items };
}
