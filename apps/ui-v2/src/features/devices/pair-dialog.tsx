import { useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { formatCodeInput, formatRetryAfter, isNormalizable, normalizeCode } from './pair-code';

// Pairing (#1240): a Dialog over the Devices list at /devices/pair. One step:
// the code on the device's screen (prefilled from ?code=) and an optional
// name, then Pair: POST /api/pair/lookup, then /api/pair/approve. An expired or
// unknown code clears the field and says to enter the new one; nothing is
// stuck. Cancel closes without pairing (the code simply expires).

type PairingLookup = { pairing_id: string; device_model: string; expires_at: number };
type PairApproved = { device_id: string; name: string };

const NAME_MAX = 40;
const INVALID_CODE_ERROR = 'Enter the 8-character code shown on the device.';
export const EXPIRED_ERROR = 'That code expired. Enter the new one on the screen.';
const REQUEST_ERROR = "Couldn't pair right now. Try again.";
const NAME_TOO_LONG_ERROR = `Use ${NAME_MAX} characters or fewer.`;

type Failure = { field: 'code' | 'name' | 'form'; message: string };

async function readRetryAfter(response: Response): Promise<number> {
  const body = (await response.json().catch(() => ({}))) as { retry_after_seconds?: number };
  const header = response.headers.get('Retry-After');
  return body.retry_after_seconds ?? (header === null ? 900 : Number(header));
}

async function lookup(code: string): Promise<PairingLookup | Failure> {
  const response = await fetchWithAuth('/api/pair/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_code: code }),
  });
  if (response.status === 200) return (await response.json()) as PairingLookup;
  if (response.status === 404) return { field: 'code', message: EXPIRED_ERROR };
  if (response.status === 400) return { field: 'code', message: INVALID_CODE_ERROR };
  if (response.status === 429) {
    return { field: 'code', message: `Too many attempts. Try again in ${formatRetryAfter(await readRetryAfter(response))}.` };
  }
  return { field: 'form', message: REQUEST_ERROR };
}

async function approve(pairingId: string, name: string): Promise<PairApproved | Failure> {
  const response = await fetchWithAuth('/api/pair/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_id: pairingId, ...(name ? { name } : {}) }),
  });
  if (response.status === 200) return (await response.json()) as PairApproved;
  if (response.status === 404) return { field: 'code', message: EXPIRED_ERROR };
  return { field: 'form', message: REQUEST_ERROR };
}

/** The normalized code and trimmed name, or the field that is wrong. */
function validate(code: string, name: string): { code: string; name: string } | Failure {
  const normalized = normalizeCode(code);
  if (!isNormalizable(normalized)) return { field: 'code', message: INVALID_CODE_ERROR };
  const trimmed = name.trim();
  if (trimmed.length > NAME_MAX) return { field: 'name', message: NAME_TOO_LONG_ERROR };
  return { code: normalized, name: trimmed };
}

/** Looks the code up, then approves it under the name; any throw is a form failure. */
async function lookupAndApprove(code: string, name: string): Promise<PairApproved | Failure> {
  try {
    const found = await lookup(code);
    return 'field' in found ? found : await approve(found.pairing_id, name);
  } catch {
    return { field: 'form', message: REQUEST_ERROR };
  }
}

/** The ?code= a device's QR or link carries, shaped for the field. */
function codeFromLocation(): string {
  const raw = new URLSearchParams(window.location.search).get('code');
  return raw === null ? '' : formatCodeInput(raw);
}

type PairDialogProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Called once the device is paired, with its id and name. */
  onPaired: (device: PairApproved) => void;
};

export function PairDialog({ isOpen, onOpenChange, onPaired }: PairDialogProps): ReactElement {
  const [code, setCode] = useState(codeFromLocation);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);

  const close = (open: boolean): void => {
    if (!open) {
      setCode('');
      setName('');
      setFailure(null);
    }
    onOpenChange(open);
  };

  const pair = async (): Promise<void> => {
    setFailure(null);
    const checked = validate(code, name);
    if ('field' in checked) {
      setFailure(checked);
      return;
    }
    const result = await lookupAndApprove(checked.code, checked.name);
    if ('field' in result) {
      if (result.message === EXPIRED_ERROR) setCode('');
      setFailure(result);
      return;
    }
    setCode('');
    setName('');
    onPaired(result);
  };

  const status = (field: Failure['field']) =>
    failure?.field === field ? { type: 'error' as const, message: failure.message } : undefined;

  return (
    <Dialog isOpen={isOpen} onOpenChange={close} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title="Pair a device" subtitle="Find the 8-character code on your device's screen." onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Code on the screen"
                description="It looks like K7QX-4TZP."
                placeholder="XXXX-XXXX"
                size="lg"
                autoComplete="one-time-code"
                hasAutoFocus
                value={code}
                status={status('code')}
                statusVariant="detached"
                onChange={(raw) => {
                  setCode(formatCodeInput(raw));
                  setFailure(null);
                }}
                onEnter={() => void pair()}
              />
              <TextInput
                label="Name"
                description={`You can rename it later. ${NAME_MAX - name.length} characters left.`}
                placeholder="Kitchen"
                isOptional
                autoComplete="off"
                value={name}
                status={status('name')}
                statusVariant="detached"
                onChange={(value) => setName(value.slice(0, NAME_MAX))}
                onEnter={() => void pair()}
              />
              {failure?.field === 'form' && <Text type="supporting" role="alert">{failure.message}</Text>}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={() => close(false)} />
              <Button label="Pair" variant="primary" isDisabled={normalizeCode(code).length !== 8} clickAction={pair} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
