import { useRef, useState, type ReactElement } from 'react';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useTaskItems, type MoveDirection } from '@/features/productivity/use-task-items';
import type { TaskSummary } from '@/features/productivity/use-tasks';

/** Focuses the button with this accessible label, if it is enabled (Astryx
 *  may mark a disabled button with aria-disabled instead of `disabled`). */
function focusButton(label: string): boolean {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label && !b.disabled && b.getAttribute('aria-disabled') !== 'true',
  );
  button?.focus();
  return button !== undefined;
}

export function TaskChecklist({ taskId }: { taskId: string }): ReactElement {
  const { items, loading, error, addItem, toggleItem, removeItem, moveItem } = useTaskItems(taskId);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // Keeps keyboard focus on the moved row (the pressed control, or its twin
  // once the row reaches an end) and announces the new position.
  const move = async (item: TaskSummary, direction: MoveDirection): Promise<void> => {
    const position = await moveItem(item, direction);
    if (position === null) return;
    setAnnouncement(`Moved ${item.title} to position ${position} of ${items.length}.`);
    const other: MoveDirection = direction === 'up' ? 'down' : 'up';
    if (!focusButton(`Move ${direction} ${item.title}`)) focusButton(`Move ${other} ${item.title}`);
  };
  // Enter fires both onEnter and a following submit, and a state flag would
  // not be visible to the second call yet, so the in-flight guard is a ref.
  const inFlight = useRef(false);

  const add = async (): Promise<void> => {
    const title = draft.trim();
    if (title === '' || inFlight.current) return;
    inFlight.current = true;
    setAdding(true);
    try {
      const ok = await addItem(title);
      if (ok) setDraft('');
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  };

  return (
    <VStack gap={2}>
      <Text type="label">Checklist</Text>
      {loading && (
        <Text type="supporting" role="status">
          Loading checklist…
        </Text>
      )}
      {error !== null && <Banner status="warning" title={error} container="card" />}
      <Text type="supporting" role="status" aria-live="polite">
        {announcement}
      </Text>
      {!loading && items.length === 0 && error === null && (
        <Text type="supporting">No items yet.</Text>
      )}
      {items.map((item, index) => (
        <HStack key={item.id} gap={1} vAlign="center">
          <StackItem size="fill">
            <CheckboxInput
              label={item.title}
              value={item.status === 'completed'}
              onChange={() => void toggleItem(item)}
            />
          </StackItem>
          <IconButton
            label={`Move up ${item.title}`}
            tooltip="Move up"
            icon={<Icon icon={ArrowUpIcon} size="sm" />}
            variant="ghost"
            size="sm"
            isDisabled={index === 0}
            onClick={() => void move(item, 'up')}
          />
          <IconButton
            label={`Move down ${item.title}`}
            tooltip="Move down"
            icon={<Icon icon={ArrowDownIcon} size="sm" />}
            variant="ghost"
            size="sm"
            isDisabled={index === items.length - 1}
            onClick={() => void move(item, 'down')}
          />
          <IconButton
            label={`Remove ${item.title}`}
            tooltip="Remove"
            icon={<Icon icon="close" size="sm" />}
            variant="ghost"
            size="sm"
            onClick={() => void removeItem(item)}
          />
        </HStack>
      ))}
      <HStack gap={1} vAlign="end">
        <StackItem size="fill">
          <TextInput
            label="New checklist item"
            isLabelHidden
            placeholder="Add an item…"
            value={draft}
            onChange={setDraft}
            onEnter={add}
          />
        </StackItem>
        <Button
          label="Add item"
          icon={<Icon icon={PlusIcon} size="sm" />}
          isDisabled={adding || draft.trim() === ''}
          onClick={() => void add()}
        />
      </HStack>
    </VStack>
  );
}
