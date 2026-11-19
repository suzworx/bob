import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { ListItem } from '@astryxdesign/core/List';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
  isTypeMuted,
  listNotificationPreferences,
  setNotificationTypeMuted,
  type NotificationPreference,
  type NotificationType,
} from './notifications-api';

const MUTABLE_TYPES: ReadonlyArray<{ type: NotificationType; label: string; description: string }> = [
  { type: 'reminder', label: 'Reminders', description: 'When a reminder rings.' },
  { type: 'mention', label: 'Mentions', description: 'When someone mentions you in a conversation.' },
  { type: 'assignment', label: 'Task assignments', description: 'When a task is given to you.' },
  { type: 'task_update', label: 'Tasks you follow', description: 'When one is done, reassigned or its due date moves.' },
  { type: 'event_change', label: 'Events', description: 'Invites, changes, cancellations and replies.' },
  { type: 'invitation', label: 'Space members', description: 'When someone accepts your invite or joins a space.' },
  { type: 'bob_message', label: 'Notes from Bob', description: 'When Bob leaves you a note.' },
];

type LoadState = 'loading' | 'ready' | 'failed';

/**
 * Settings #notifications: one switch per kind, security always on. The
 * Settings page owns the section heading; this is its content.
 */
export function NotificationSettingsSection(): ReactElement {
  const { isMobile } = useAppShellMobile();
  const [state, setState] = useState<LoadState>('loading');
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [saving, setSaving] = useState<NotificationType | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    try {
      setPreferences(await listNotificationPreferences());
      setState('ready');
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (type: NotificationType, checked: boolean): Promise<void> => {
      setSaveFailed(false);
      const previous = preferences;
      const isTypeRow = (p: NotificationPreference): boolean =>
        p.space_id === null && p.thread_id === null && p.type === type;
      const optimistic: NotificationPreference = {
        id: `optimistic:${type}`,
        user_id: '',
        space_id: null,
        thread_id: null,
        type,
        muted: !checked,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_zone: null,
      };
      setPreferences([...previous.filter((p) => !isTypeRow(p)), optimistic]);
      setSaving(type);
      try {
        const saved = await setNotificationTypeMuted(type, !checked);
        setPreferences((current) => [...current.filter((p) => !isTypeRow(p)), saved]);
      } catch {
        setPreferences(previous);
        setSaveFailed(true);
      } finally {
        setSaving(null);
      }
    },
    [preferences],
  );

  if (state === 'loading') {
    return (
      <VStack gap={3} role="status" aria-label="Loading notification settings">
        {MUTABLE_TYPES.map(({ type }, index) => (
          <Skeleton key={type} height={40} index={index} />
        ))}
      </VStack>
    );
  }

  if (state === 'failed') {
    return (
      <Banner
        status="error"
        title="Couldn't load notification settings."
        container="card"
        endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void load()} />}
      />
    );
  }

  // On a phone each setting is one row of the section's grouped card, its switch at the end.
  if (isMobile) {
    return (
      <>
        {saveFailed && <ListItem label="Couldn't save that setting. Try again." />}
        {MUTABLE_TYPES.map(({ type, label, description }) => (
          <ListItem
            key={type}
            label={label}
            description={description}
            endContent={
              <Switch
                label={label}
                isLabelHidden
                value={!isTypeMuted(preferences, type)}
                isLoading={saving === type}
                onChange={(checked) => void save(type, checked)}
              />
            }
          />
        ))}
        <ListItem
          label="Security notices"
          description="New sign-ins, paired devices and connected accounts."
          endContent={
            <Switch
              label="Security notices"
              isLabelHidden
              value
              isDisabled
              disabledMessage="Security notices are always on."
            />
          }
        />
      </>
    );
  }

  return (
    <VStack gap={3}>
      {saveFailed && <Banner status="error" title="Couldn't save that setting. Try again." container="card" />}
      <Text type="supporting">Choose what shows up in your notifications.</Text>
      {MUTABLE_TYPES.map(({ type, label, description }) => (
        <Switch
          key={type}
          label={label}
          description={description}
          value={!isTypeMuted(preferences, type)}
          isLoading={saving === type}
          labelPosition="start"
          labelSpacing="spread"
          onChange={(checked) => void save(type, checked)}
        />
      ))}
      <Switch
        label="Security notices"
        description="New sign-ins, paired devices and connected accounts."
        value
        isDisabled
        disabledMessage="Security notices are always on."
        labelPosition="start"
        labelSpacing="spread"
      />
    </VStack>
  );
}
