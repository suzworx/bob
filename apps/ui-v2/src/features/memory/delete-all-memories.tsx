import { BRAND } from '@/lib/brand';
import { useState, type ReactElement } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { MemoryUnavailableError, deleteAllMemories } from './memory-api';

const DELETE_ALL_ERROR = "Your memories couldn't be deleted.";

/**
 * "Delete all memories" for Settings > Your data. It used to sit under the
 * Memory list; one confirming AlertDialog replaces the typed phrase. A
 * settings-sidebar row, shaped like its siblings in that panel.
 */
export function DeleteAllMemoriesSection(): ReactElement {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAllMemories();
      setOpen(false);
      toast({ body: 'All memories deleted', isAutoHide: true });
    } catch (caught) {
      setOpen(false);
      setError(caught instanceof MemoryUnavailableError ? "Memory isn't available yet." : DELETE_ALL_ERROR);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <VStack gap={3} paddingBlock={4}>
        <HStack gap={3} hAlign="between" vAlign="start" wrap="wrap">
          <VStack gap={0}>
            <Text type="body" weight="semibold" display="block">
              Delete all memories
            </Text>
            <Text type="supporting" display="block">
              {`${BRAND.assistantName} forgets everything it remembers about you, and its suggested to-dos.`}
            </Text>
          </VStack>
          <Button label="Delete all memories" variant="destructive" size="sm" onClick={() => setOpen(true)} />
        </HStack>
        {error !== null && (
          <Banner
            status="error"
            title={error}
            endContent={<Button label="Retry" size="sm" onClick={() => setOpen(true)} />}
          />
        )}
      </VStack>
      <Divider />
      <AlertDialog
        isOpen={open}
        onOpenChange={(next) => {
          if (!next && !deleting) setOpen(false);
        }}
        title="Delete all memories?"
        description={`${BRAND.assistantName} will forget everything it remembers about you, including its suggested to-dos. This can't be undone.`}
        actionLabel="Delete all"
        isActionLoading={deleting}
        onAction={() => void confirm()}
      />
    </>
  );
}
