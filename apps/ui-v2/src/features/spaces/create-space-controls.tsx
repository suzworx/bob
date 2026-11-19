import { useRef, useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { fetchWithAuth } from '@/lib/auth/use-session';
import type { Space, SpacesValue } from '@/features/spaces/use-spaces';

const SPACE_NAME_MAX = 60;
const NAME_TOO_LONG = `Use ${SPACE_NAME_MAX} characters or fewer.`;
const CREATE_ERROR = 'That could not be created.';
const RENAME_ERROR = 'The space could not be renamed.';
const INVITES_BAD = 'Check the email addresses: separate them with commas.';
// A light check only; the server validates each address for real.
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** The addresses typed into "Invite", or null when one of them is not an address. */
export function parseInviteEmails(text: string): string[] | null {
  const parts = text.split(/[,;\s]+/).map((part) => part.trim()).filter((part) => part !== '');
  if (parts.some((part) => !EMAIL.test(part))) return null;
  return [...new Set(parts.map((part) => part.toLowerCase()))];
}

/** Sends one member invitation per address; resolves how many failed. */
async function sendInvites(spaceId: string, emails: string[]): Promise<number> {
  const results = await Promise.all(
    emails.map(async (email) => {
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/invitations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role: 'member' }),
        });
        return response.ok;
      } catch {
        return false;
      }
    }),
  );
  return results.filter((ok) => !ok).length;
}

type CreateProps = {
  mode?: 'create';
  onCreate: SpacesValue['createSpace'];
  /** The new space, and how many of its invitations could not be sent. */
  onCreated?: (space: Space, failedInvites: number) => void;
};
type RenameProps = {
  mode: 'rename';
  space: Space;
  onRename: SpacesValue['renameSpace'];
};

/**
 * The one space-name dialog. Create asks the name and optional invites, so it
 * is useful the moment it exists; rename asks only
 * the name. Mounted only while open, so each open starts fresh.
 */
export function SpaceNameDialog(props: (CreateProps | RenameProps) & { onClose: () => void }): ReactElement {
  const renaming = props.mode === 'rename';
  const original = renaming ? props.space.name : '';
  const [name, setName] = useState(original);
  const [invites, setInvites] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A rapid second Enter must not submit twice, and state would not be visible to it yet.
  const inFlight = useRef(false);
  const trimmed = name.trim();
  const tooLong = trimmed.length > SPACE_NAME_MAX;
  const emails = parseInviteEmails(invites);
  const canSubmit = trimmed !== '' && !tooLong && (renaming ? trimmed !== original : emails !== null);

  const close = (): void => {
    if (!busy) props.onClose();
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (props.mode === 'rename') {
        if (await props.onRename(props.space.id, trimmed)) props.onClose();
        else setFailed(true);
        return;
      }
      const created = await props.onCreate(trimmed);
      if (created === null) {
        setFailed(true);
        return;
      }
      const failedInvites = emails && emails.length > 0 ? await sendInvites(created.id, emails) : 0;
      props.onClose();
      props.onCreated?.(created, failedInvites);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const nameStatus = tooLong
    ? { type: 'error' as const, message: NAME_TOO_LONG }
    : failed
      ? { type: 'error' as const, message: renaming ? RENAME_ERROR : CREATE_ERROR }
      : undefined;

  return (
    <Dialog isOpen purpose="form" width={440} onOpenChange={(open) => { if (!open) close(); }}>
      <Layout
        header={<DialogHeader title={renaming ? 'Rename space' : 'New space'} onOpenChange={() => close()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label={renaming ? 'Space name' : 'Name'}
                hasAutoFocus
                value={name}
                onChange={setName}
                onEnter={submit}
                placeholder={renaming ? undefined : 'Home'}
                status={nameStatus}
              />
              {!renaming && (
                <>
                  <TextInput
                    label="Invite"
                    isOptional
                    value={invites}
                    onChange={setInvites}
                    placeholder="Email addresses"
                    description="They get an invite link; you can add people later."
                    status={emails === null ? { type: 'error', message: INVITES_BAD } : undefined}
                  />
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={close} />
              <Button
                label={renaming ? 'Save' : 'Create space'}
                variant="primary"
                isLoading={busy}
                isDisabled={!canSubmit}
                onClick={() => void submit()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** The New space dialog (the rail, All spaces and the empty state all open it). */
export function CreateSpaceDialog({
  onClose,
  onCreate,
  onCreated,
}: {
  onClose: () => void;
  onCreate: SpacesValue['createSpace'];
  onCreated?: (space: Space, failedInvites: number) => void;
}): ReactElement {
  return <SpaceNameDialog onClose={onClose} onCreate={onCreate} onCreated={onCreated} />;
}
