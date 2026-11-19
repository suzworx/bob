import { useState, type ReactElement } from 'react';
import { ArrowRightLeft, Smartphone } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { StackItem } from '@astryxdesign/core/Stack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { ConversationPicker } from './conversation-picker';
import { isDeviceOnline, type Device } from './devices-api';
import { refreshDevices, useDevices } from './use-devices';
import { threadRef, type DeviceConversation } from './use-device-conversation';

// What a chat or thread header offers for the paired device (#667). Nothing at
// all while the account has no paired device. With one, it is that device;
// with several, the one online first (else the first paired), and the picker
// lets you choose another, so every pick reaches the device it names:
// - not on the device: a labelled "Use on <name>" button, one click;
// - on it: an "On <name>" token;
// - in both: the hook's menu (New conversation on <name>) and "Change
//   conversation…", which opens the shared picker (#668).
export type DeviceHeaderTarget =
  | { conversationId: string }
  | { threadId: string; spaceId: string; spaceName?: string };

/** The device the header acts on by default: online first, else the first. */
function defaultDevice(devices: Device[]): Device | undefined {
  return devices.find(isDeviceOnline) ?? devices[0];
}

/** What the device talks in: with several devices, the scoped device's own pointer. */
function activeIdFor(device: DeviceConversation, scoped: Device | undefined, accountId: string | undefined): string | null {
  if (scoped === undefined) return device.activeId;
  return scoped.active_conversation_id ?? accountId ?? device.activeId;
}

function targetRef(target: DeviceHeaderTarget): string {
  return 'threadId' in target ? threadRef(target.threadId) : target.conversationId;
}

/** Where "New conversation" starts from this header. */
function newSpaceOf(target: DeviceHeaderTarget): { newSpaceId: string | null; newSpaceName: string } {
  if ('threadId' in target) return { newSpaceId: target.spaceId, newSpaceName: target.spaceName ?? 'this space' };
  return { newSpaceId: null, newSpaceName: 'General' };
}

/** This surface's last result, else what the device is in elsewhere. */
function statusLine(device: DeviceConversation, statusKey: string, quiet: boolean, label: string): string {
  if (device.status?.key === statusKey) return device.status.text;
  return !quiet && device.activeTitle ? `On ${label}: ${device.activeTitle}` : '';
}

export function DeviceHeaderControl({
  device,
  target,
  statusKey,
}: {
  // The surface's one useDeviceConversation(), shared with its other menus.
  device: DeviceConversation;
  target: DeviceHeaderTarget;
  // Where this surface's clicks report; its row menus may share it.
  statusKey: string;
}): ReactElement | null {
  const [picking, setPicking] = useState(false);
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const store = useDevices();
  const devices = store.devices;
  const scoped = devices.length > 1 ? defaultDevice(devices) : undefined;
  if (store.state !== 'ready' || devices.length === 0) return null;

  const label = scoped?.name ?? device.deviceName ?? devices[0]?.name ?? 'device';
  const here = activeIdFor(device, scoped, store.activeConversation?.id) === targetRef(target);
  const scopeId = scoped?.id;
  const send = async (conversationId: string | null, spaceId: string | null, threadId?: string): Promise<void> => {
    const result = await device.send(
      { conversationId, spaceId, ...(threadId === undefined ? {} : { threadId }) },
      statusKey,
      scopeId,
    );
    if (scopeId !== undefined && (result === 'sent' || result === 'pending')) void refreshDevices();
  };
  const use = (): Promise<void> =>
    'threadId' in target ? send(null, target.spaceId, target.threadId) : send(target.conversationId, null);
  const { newSpaceId, newSpaceName } = newSpaceOf(target);
  const items = [
    {
      id: 'new-conversation-on-cardputer',
      label: `New conversation on ${label}`,
      description: `Starts in ${newSpaceName}`,
      onClick: () => void send(null, newSpaceId),
    },
    { id: 'change-device-conversation', label: 'Change conversation…', icon: ArrowRightLeft, onClick: () => setPicking(true) },
  ];
  const status = statusLine(device, statusKey, here || scoped !== undefined, label);

  return (
    <HStack gap={2} vAlign="center" hAlign="end" maxWidth="100%">
      <StackItem size="fill">
        <Text type="supporting" size="sm" role="status" maxLines={1}>
          {status}
        </Text>
      </StackItem>
      {here ? (
        <Token label={`On ${label}`} size="sm" color="green" icon={<Icon icon={Smartphone} size="sm" />} />
      ) : (
        <Button
          label={`Use on ${label}`}
          tooltip={`Use on ${label}`}
          isIconOnly={isNarrow}
          size="sm"
          icon={<Icon icon={Smartphone} size="sm" />}
          isDisabled={device.isSending === true}
          clickAction={use}
        />
      )}
      <DropdownMenu
        button={{ label: `${label} options`, variant: 'ghost', size: 'sm', isIconOnly: true, icon: <Icon icon="chevronDown" size="sm" /> }}
        hasChevron={false}
        alignment="end"
        presentation="adaptive"
        items={items}
      />
      {picking && (
        <ConversationPicker
          isOpen={picking}
          onOpenChange={setPicking}
          device={device}
          statusKey={statusKey}
          devices={devices}
          deviceId={scopeId}
          canChooseDevice
        />
      )}
    </HStack>
  );
}
