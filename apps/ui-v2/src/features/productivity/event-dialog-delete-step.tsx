import { useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { AgendaItem } from '@/features/productivity/use-agenda';
import { cancelEvent, type EventSummary, type RecurrenceScope } from '@/features/productivity/use-events';

const DELETE_FAILED_ERROR = 'The event could not be deleted.';

type DeleteScope = '' | RecurrenceScope;

/** The delete confirmation, shared by the edit dialog (organizer) and the view
 *  dialog (a group owner/admin who may delete but not edit, #873). It is the
 *  dialog's content only, so the open <dialog> survives the step change. */
export function DeleteEventStep({
  event,
  item,
  onBack,
  onClose,
  onChanged,
}: {
  event: EventSummary;
  item: AgendaItem;
  onBack: () => void;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const [deleteScope, setDeleteScope] = useState<DeleteScope>('');
  const [busy, setBusy] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState(false);
  const inFlight = useRef(false);
  const recurring = event.rrule !== null;

  const remove = async (): Promise<void> => {
    if (inFlight.current || (recurring && deleteScope === '')) return;
    inFlight.current = true;
    setBusy(true);
    setDeleteFailure(false);
    try {
      const scopeToSend: RecurrenceScope = recurring && deleteScope !== '' ? deleteScope : 'series';
      const result = await cancelEvent(
        event.id,
        scopeToSend,
        scopeToSend === 'this' || scopeToSend === 'this_and_following' ? item.original_occurrence_start : null,
      );
      if (!result.ok) {
        setDeleteFailure(true);
        return;
      }
      onChanged();
      onClose();
    } catch {
      setDeleteFailure(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Layout
      header={<DialogHeader title={`Delete “${event.title}”?`} onOpenChange={() => onClose()} />}
      content={
        <LayoutContent>
          <VStack gap={4}>
            <Text as="p">It disappears from everyone&apos;s agenda. This can&apos;t be undone.</Text>
            {recurring && (
              <RadioList
                label="Delete which events?"
                value={deleteScope}
                onChange={(value) => setDeleteScope(value as DeleteScope)}
              >
                <RadioListItem value="this" label="Only this event" />
                <RadioListItem
                  value="this_and_following"
                  label="This and every later event"
                  description="Ends the series before this date. Earlier dates stay."
                />
                <RadioListItem value="series" label="Every event in the series" />
              </RadioList>
            )}
            {deleteFailure && <Banner status="error" title={DELETE_FAILED_ERROR} container="card" />}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} hAlign="end">
            <Button label="Back" variant="secondary" onClick={onBack} />
            <Button
              label="Delete"
              variant="destructive"
              isLoading={busy}
              isDisabled={recurring && deleteScope === ''}
              onClick={() => void remove()}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
