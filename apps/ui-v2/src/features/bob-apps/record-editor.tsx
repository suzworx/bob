import { useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import type { AppDefinition, AppRecords, AppCommand } from './bob-apps-api';
import { cellText, fieldLabel } from './app-starters';

type Table = AppDefinition['tables'][number];
type Row = AppRecords[string][number];
type Props = { table: Table; listTitle: string; rows: Row[]; row?: Row; action?: string; revision: number; busy: boolean; onSave: (command: AppCommand, expectedRevision?: number) => Promise<boolean>; onClose: () => void };
type Value = string | number | boolean | null;
type Values = Record<string, Value>;

// What the saved record accepts.
const NUMBER_LIMIT = 1e12;
const initialValue = (type: string, saved: unknown): Value => {
  if (type === 'boolean') return saved === true;
  if (type === 'number') return typeof saved === 'number' ? saved : null;
  return String(saved ?? '');
};
const editableNumber = (value: number): string => value.toLocaleString(navigator.language, { useGrouping: false, maximumFractionDigits: 20 });
const needsNumber = (label: string): string => `${label} needs a number, like ${(12.5).toLocaleString(navigator.language)}.`;
function numberProblem(label: string, value: Value): string | null {
  if (typeof value !== 'number') return needsNumber(label);
  return Math.abs(value) > NUMBER_LIMIT ? `${label} is too large to save.` : null;
}
function fieldProblems(table: Table, values: Values, known: Record<string, string>): Record<string, string> {
  const found = { ...known };
  for (const field of table.fields.filter((item) => item.type === 'number' && !known[item.id])) {
    const problem = numberProblem(fieldLabel(field.id), values[field.id] ?? null);
    if (problem) found[field.id] = problem;
  }
  return found;
}
function FormFrame({ title, isMobile, content, footer, onDismiss }: { title: string; isMobile: boolean; content: ReactElement; footer: ReactElement; onDismiss: () => void }): ReactElement {
  const onOpenChange = (open: boolean): void => { if (!open) onDismiss(); };
  if (isMobile) return <BottomSheet isOpen onOpenChange={onOpenChange} purpose="form" height="tall" label={title}>
    <Layout height="fill" header={<LayoutHeader><Heading level={2}>{title}</Heading></LayoutHeader>} content={content} footer={footer} />
  </BottomSheet>;
  return <Dialog isOpen onOpenChange={onOpenChange} purpose="form" width={480}>
    <Layout header={<DialogHeader title={title} onOpenChange={onDismiss} />} content={content} footer={footer} />
  </Dialog>;
}
/** Ends the edit in progress: NumberInput only commits or rejects its draft on blur. */
function endEdit(): void { if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); }

/** Number entry reads and shows the phone's own decimal mark, as the saved records do. */
function DeviceLocale({ children }: { children: ReactNode }): ReactElement {
  return <InternationalizationProvider locale={navigator.language} dir={document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'}>{children}</InternationalizationProvider>;
}

function Fields({ table, values, errors, busy, autoFocus, onValue, onFocusNumber, onBlurNumber, onEnter }: { table: Table; values: Values; errors: Record<string, string>; busy: boolean; autoFocus: boolean; onValue: (id: string, value: Value) => void; onFocusNumber: (id: string) => void; onBlurNumber: (id: string, event: FocusEvent<HTMLInputElement>) => void; onEnter: () => void }): ReactElement {
  return <FormLayout>{table.fields.map((field, index) => {
    const label = fieldLabel(field.id);
    if (field.type === 'boolean') return <CheckboxInput key={field.id} label={label} value={values[field.id] === true} isDisabled={busy} onChange={(value) => onValue(field.id, value)} />;
    const hasAutoFocus = autoFocus && index === 0;
    if (field.type === 'number') {
      const message = errors[field.id];
      return <NumberInput key={field.id} label={label} isRequired value={values[field.id] as number | null} step={null} hasClear isWheelEnabled={false} isDisabled={busy} hasAutoFocus={hasAutoFocus} formatValue={editableNumber}
        status={message ? { type: 'error', message } : undefined} onFocus={() => onFocusNumber(field.id)} onBlur={(event) => onBlurNumber(field.id, event)} onEnter={onEnter} onChange={(value: number | null) => onValue(field.id, value)} />;
    }
    return <TextInput key={field.id} label={label} value={String(values[field.id] ?? '')} isDisabled={busy} hasAutoFocus={hasAutoFocus} onEnter={onEnter} onChange={(value) => onValue(field.id, value)} />;
  })}</FormLayout>;
}

/** Add or edit one record: a bottom sheet on a phone with its actions pinned below the fields, a dialog on desktop. */
export function RecordEditor({ table, listTitle, rows, row, action, revision, busy, onSave, onClose }: Props): ReactElement {
  const { isMobile } = useAppShellMobile();
  const toast = useToast();
  const [initial] = useState<Values>(() => Object.fromEntries(table.fields.map((field) => [field.id, initialValue(field.type, row?.values[field.id])])));
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Enter commits a draft and saves in one event, so saving reads what just landed, not this render's state.
  const latest = useRef({ values: initial, errors, rejectedDraft: false });
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [failed, setFailed] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // One id per open form: a retry after a lost response is recognisably the same record.
  const [newId] = useState(() => `r_${crypto.randomUUID().replaceAll('-', '')}`);
  const title = row ? `Edit in ${listTitle}` : `Add to ${listTitle}`;
  const savedMessage = row ? `Saved in ${listTitle}` : `Added to ${listTitle}`;
  const changed = expectedRevision !== revision;
  const latestRow = row && rows.find((item) => item.id === row.id);
  const landed = failed && !row && rows.some((item) => item.id === newId);
  const done = (): void => { toast({ body: savedMessage, uniqueID: 'record-saved' }); onClose(); };
  // The failed add reached the server after all: the reloaded list holds this form's record.
  useEffect(() => { if (landed) done(); }, [landed]); // eslint-disable-line react-hooks/exhaustive-deps
  const showErrors = (next: Record<string, string>): void => { latest.current.errors = next; setErrors(next); };
  const setValue = (id: string, value: Value): void => { latest.current.values = { ...latest.current.values, [id]: value }; setValues(latest.current.values); };
  // A field's error clears when it is focused, never as its value commits on blur: that would
  // shrink the dialog under a pointer on its way to Save and lose the click.
  const focusNumber = (id: string): void => { const { [id]: _cleared, ...rest } = latest.current.errors; showErrors(rest); };
  // NumberInput flags a draft it cannot read and then silently restores the old value on blur.
  const blurNumber = (id: string, event: FocusEvent<HTMLInputElement>): void => {
    if (event.target.getAttribute('aria-invalid') !== 'true') return;
    latest.current.rejectedDraft = true;
    showErrors({ ...latest.current.errors, [id]: needsNumber(fieldLabel(id)) });
  };
  const save = async (): Promise<void> => {
    if (!action || busy || changed) return;
    endEdit();
    const found = fieldProblems(table, latest.current.values, latest.current.errors);
    showErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailed(false);
    const saved = Object.fromEntries(table.fields.map((field) => [field.id, latest.current.values[field.id] ?? ''])) as Extract<AppCommand, { operation: 'write' }>['values'];
    if (await onSave({ operation: 'write', action, id: row?.id ?? newId, values: saved }, expectedRevision)) done();
    else setFailed(true);
  };
  const askToClose = (): void => {
    if (busy) return;
    endEdit();
    if (latest.current.rejectedDraft || JSON.stringify(latest.current.values) !== JSON.stringify(initial)) setConfirmingDiscard(true);
    else onClose();
  };
  const keepMine = (): void => { setExpectedRevision(revision); setFailed(false); };
  const content = <LayoutContent><VStack gap={4}>
    {changed && <VStack gap={3}><Banner status="warning" title="Saved data changed while you were editing" description="Your edits are still here. Compare the latest saved values before replacing them." />
      {latestRow && <Text>{table.fields.map((field) => `${fieldLabel(field.id)}: ${cellText(latestRow.values[field.id])}`).join(' · ')}</Text>}
      <Button label="Keep my edits against latest data" onClick={keepMine} /></VStack>}
    {failed && !changed && <Banner status="error" title="Couldn’t save this. Your edits are still here, so you can try again." />}
    <Fields table={table} values={values} errors={errors} busy={busy} autoFocus={!isMobile} onValue={setValue} onFocusNumber={focusNumber} onBlurNumber={blurNumber} onEnter={() => void save()} />
  </VStack></LayoutContent>;
  const footer = <LayoutFooter hasDivider><HStack gap={2} hAlign="end">
    <Button label="Cancel" variant="ghost" isDisabled={busy} onClick={onClose} />
    <Button label="Save" variant="primary" isLoading={busy} isDisabled={changed} onClick={() => void save()} />
  </HStack></LayoutFooter>;
  return <DeviceLocale>
    <FormFrame title={title} isMobile={isMobile} content={content} footer={footer} onDismiss={askToClose} />
    {confirmingDiscard && <AlertDialog isOpen title="Discard what you typed?" description="It hasn’t been saved." actionLabel="Discard" cancelLabel="Keep editing" onOpenChange={setConfirmingDiscard} onAction={onClose} />}
  </DeviceLocale>;
}
