import { useEffect, useState, type ReactElement } from 'react';
import { Hash, MessageSquare } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { useConversationList } from '@/features/chat/use-conversation-list';
import type { Space } from '@/features/spaces/use-spaces';
import { ConversationPicker } from './conversation-picker';
import type { ActiveSpace, Device } from './devices-api';
import { DEVICE_APPLIED, type DeviceConversation } from './use-device-conversation';
import { conversationPath, navigateTo, spacePath } from '../../app/routes';

// #668 "Talking in": the one row that says what this device talks in. The
// title opens that chat; the description names the conversation's OWN space
// (a thread's space, read from the thread itself, never the default space for
// new conversations) and its last turn. "Change" opens the picker, which also
// holds "New conversation". "Last turn" is this device's newest turn (GET
// /api/devices/:id/activity); with none yet, the conversation's updated time.

export const STATUS_KEY = 'devices';
const THREAD_PREFIX = 'thr_';

type Facts = { title: string | null; spaceId: string | null; updatedAt: number | null };

/** A thread pointer's own facts, from GET /api/threads/:id (it carries space_id). */
function useThreadFacts(threadId: string | null): Facts | null {
  const [facts, setFacts] = useState<{ id: string; facts: Facts } | null>(null);
  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/api/threads/${encodeURIComponent(threadId)}`);
        if (!response.ok) return;
        const body = (await response.json()) as { space_id?: string; title?: string; updated_at?: number };
        if (live) {
          setFacts({ id: threadId, facts: { title: body.title ?? null, spaceId: body.space_id ?? null, updatedAt: body.updated_at ?? null } });
        }
      } catch {
        // The row keeps what the pointer itself says.
      }
    })();
    return () => {
      live = false;
    };
  }, [threadId]);
  return facts !== null && facts.id === threadId ? facts.facts : null;
}

/** The title, own space and last update for a pointer id. */
function useConversationFacts(activeId: string | null, knownTitle: string | null): Facts & { isThread: boolean } {
  const threadId = activeId?.startsWith(THREAD_PREFIX) ? activeId.slice(THREAD_PREFIX.length) : null;
  const { conversations } = useConversationList();
  const thread = useThreadFacts(threadId);
  if (threadId !== null) {
    return { isThread: true, title: knownTitle ?? thread?.title ?? null, spaceId: thread?.spaceId ?? null, updatedAt: thread?.updatedAt ?? null };
  }
  const conversation = conversations.find((c) => c.id === activeId);
  return { isThread: false, title: knownTitle ?? conversation?.title ?? null, spaceId: null, updatedAt: conversation?.updatedAt ?? null };
}

type NowTalkingCardProps = {
  device: DeviceConversation;
  // The default space for this device's new conversations; null is General.
  activeSpace: ActiveSpace | null;
  spaces: Space[];
  // The newest turn this device spoke; null when it has none (or none loaded).
  lastTurnAt?: number | null;
  // #900: every paired device, and the id this row is scoped to (undefined
  // with only one device).
  devices?: Device[];
  deviceId?: string;
  // Shown while a pick waits for the device to come back online.
  deviceName?: string;
};

type FactsWithKind = Facts & { isThread: boolean };

/** Where a conversation lives: General, or the thread's own space. */
function whereOf(facts: FactsWithKind, spaces: Space[]): string {
  if (!facts.isThread) return 'General';
  return spaces.find((s) => s.id === facts.spaceId)?.name ?? 'a space';
}

/** The chat the row opens; null until a thread's own space is known. */
function chatPathFor(activeId: string | null, facts: FactsWithKind): string | null {
  if (activeId === null) return null;
  if (!facts.isThread) return conversationPath(activeId);
  return facts.spaceId === null ? null : spacePath(facts.spaceId, 'threads', activeId.slice(THREAD_PREFIX.length));
}

function RowDescription({ where, lastTurn, status, deviceName }: {
  where: string; lastTurn: number | null; status: string | null; deviceName?: string;
}): ReactElement {
  return (
    <>
      {`In ${where}`}
      {lastTurn !== null && (
        <>
          {' · last turn '}
          <Timestamp value={lastTurn} format="relative" type="inherit" color="inherit" />
        </>
      )}
      {status?.startsWith('Pending') === true && ` · Waiting for ${deviceName ?? 'the device'} to come online`}
      {status === DEVICE_APPLIED && ` · ${DEVICE_APPLIED}`}
    </>
  );
}

export function NowTalkingCard({
  device, activeSpace, spaces, lastTurnAt = null, devices = [], deviceId, deviceName,
}: NowTalkingCardProps): ReactElement {
  const [picking, setPicking] = useState(false);
  const { activeId, activeTitle } = device;
  const facts = useConversationFacts(activeId, activeTitle);
  const chatPath = chatPathFor(activeId, facts);
  // A pick made while the device is offline waits on this row until it is back.
  const ownStatus = device.status?.key === STATUS_KEY ? device.status.text : null;
  const description = activeId === null
    ? `Starts in ${activeSpace?.name ?? 'General'} on the next turn`
    : <RowDescription where={whereOf(facts, spaces)} lastTurn={lastTurnAt ?? facts.updatedAt} status={ownStatus} deviceName={deviceName} />;

  return (
    <>
      <List>
        <ListItem
          label={facts.title ?? 'A new conversation'}
          description={description}
          startContent={<Icon icon={facts.isThread ? Hash : MessageSquare} size="sm" />}
          onClick={chatPath === null ? undefined : () => navigateTo(chatPath)}
          endContent={<Button label="Change" variant="secondary" size="sm" onClick={() => setPicking(true)} />}
        />
      </List>
      {picking && (
        <ConversationPicker
          isOpen={picking}
          onOpenChange={setPicking}
          device={device}
          statusKey={STATUS_KEY}
          devices={devices}
          deviceId={deviceId}
          defaultSpace={activeSpace}
        />
      )}
    </>
  );
}
