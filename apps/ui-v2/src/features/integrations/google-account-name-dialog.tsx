import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { renameGoogleAccount, type GoogleAccount } from './google-accounts-api';

export function GoogleAccountNameDialog({ account, onClose, onSaved }: {
  account: GoogleAccount; onClose: () => void; onSaved: (account: GoogleAccount) => void;
}): ReactElement {
  const [name, setName] = useState(account.customName ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const save = async (): Promise<void> => {
    const controller = lifetime.current;
    if (!controller || busy || name.trim().length > 60) return;
    setBusy(true); setFailed(false);
    try {
      const updated = await renameGoogleAccount(account.id, name.trim() || null, controller.signal);
      if (!controller.signal.aborted) onSaved(updated);
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const close = (open: boolean): void => { if (!open && !busy) onClose(); };
  return <Dialog isOpen purpose={busy ? 'required' : 'form'} onOpenChange={close}>
    <Layout header={<DialogHeader title="Name this integration" subtitle={account.email} onOpenChange={close} />}
      content={<LayoutContent><VStack gap={4}>
        {failed && <Banner status="error" title="Couldn't save the name. Try again." />}
        <TextInput label="Integration name" value={name} onChange={setName} isOptional isDisabled={busy}
          description="Find this account by name when you type @. Leave blank to use the default name."
          status={name.trim().length > 60 ? { type: 'error', message: 'Use 60 characters or fewer.' } : undefined}
          onEnter={() => void save()} />
      </VStack></LayoutContent>}
      footer={<LayoutFooter>
        <Button label="Cancel" variant="ghost" isDisabled={busy} onClick={onClose} />
        <Button label="Save name" variant="primary" isLoading={busy} isDisabled={busy || name.trim().length > 60} onClick={() => void save()} />
      </LayoutFooter>} />
  </Dialog>;
}
