import { useEffect, useState, type ReactElement } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { StackItem } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import type { AppDefinition, AppRecords, AppCommand } from './bob-apps-api';
import { cellText, fieldLabel } from './app-starters';
import { RecordEditor } from './record-editor';

type View = AppDefinition['views'][number];
type RecordView = Extract<View, { table: string }>;
type RecordRow = AppRecords[string][number];
export type AppViewSelection = { viewId: string; slideIndex?: number };
type Props = { definition: AppDefinition; state: AppRecords; metrics: Record<string, number>; onAction?: (command: AppCommand, expectedRevision?: number) => Promise<boolean>; busy?: boolean; revision?: number; lockedTable?: string; selection?: AppViewSelection; onSelectionChange?: (selection: AppViewSelection) => void; presentation?: 'interactive' | 'image' };
function Metrics({ ids, metrics }: { ids: string[]; metrics: Record<string, number> }): ReactElement {
  const { isMobile } = useAppShellMobile();
  return <Grid columns={isMobile ? 1 : { minWidth: 240, repeat: 'fit' }} gap={4}>{ids.map((id) => <Card key={id} padding={4}><VStack gap={2}>
    <Text type="supporting">{fieldLabel(id)}</Text><Text type="display-3" hasTabularNumbers>{(metrics[id] ?? 0).toLocaleString()}</Text>
  </VStack></Card>)}</Grid>;
}
function Slides({ view, metrics, index, onChange, image }: { view: Extract<View, { kind: 'slides' }>; metrics: Record<string, number>; index: number; onChange: (index: number) => void; image: boolean }): ReactElement {
  const slide = view.slides[Math.min(index, view.slides.length - 1)];
  return <VStack gap={6}>
    {slide && <Card padding={6}><VStack gap={6}><Heading level={2}>{slide.title}</Heading><Text>{slide.body}</Text><Metrics ids={slide.metrics} metrics={metrics} /></VStack></Card>}
    <HStack gap={3} wrap="wrap">{!image && <Button label="Previous slide" isDisabled={index === 0} onClick={() => onChange(index - 1)} />}
      <Text role="status">{`Slide ${Math.min(index + 1, view.slides.length)} of ${view.slides.length}`}</Text>
      {!image && <Button label="Next slide" isDisabled={index >= view.slides.length - 1} onClick={() => onChange(index + 1)} />}</HStack>
  </VStack>;
}
function RecordTable({ rows, fields, controls }: { rows: RecordRow[]; fields: string[]; controls?: (row: RecordRow) => ReactElement }): ReactElement {
  const columns = fields.map((field) => ({ key: field, header: fieldLabel(field), width: proportional(1), renderCell: (row: RecordRow) => <Text hasTabularNumbers>{cellText(row.values[field])}</Text> }));
  // Table bleeds into its container's padding, block end too, so give the next block its gap back.
  return <VStack paddingBlockEnd={6}><Table data={rows} idKey="id" columns={controls ? [...columns, { key: 'actions', header: 'Actions', width: pixel(88), renderCell: controls }] : columns} /></VStack>;
}
/** How a view reads one record: a name for the row and a line of its other fields. */
function rowText(view: RecordView, table: AppDefinition['tables'][number] | undefined) {
  const inView = table?.fields.filter((item) => view.fields.includes(item.id)) ?? [];
  const boolean = view.kind === 'checklist' ? inView.find((item) => item.type === 'boolean') : undefined;
  const titleField = inView.find((item) => item.type === 'text')?.id ?? view.fields[0];
  const value = (row: RecordRow, field: string | undefined): string => cellText(field === undefined ? undefined : row.values[field]);
  const name = (row: RecordRow): string => value(row, titleField) || 'This record';
  const details = (row: RecordRow): string => view.fields.filter((field) => field !== titleField && field !== boolean?.id && value(row, field) !== '').map((field) => `${fieldLabel(field)}: ${value(row, field)}`).join(' · ');
  // Enough to tell two rows with the same name apart.
  const full = (row: RecordRow): string => [name(row), details(row)].filter(Boolean).join(', ');
  return { boolean, name, details, full };
}
function RemoveRecord({ listTitle, label, gone, busy, onRemove, onClose }: { listTitle: string; label: string; gone: boolean; busy?: boolean; onRemove: () => Promise<boolean>; onClose: () => void }): ReactElement {
  const toast = useToast();
  const [failed, setFailed] = useState(false);
  const done = (): void => { toast({ body: `Removed from ${listTitle}`, uniqueID: 'record-removed' }); onClose(); };
  // The failed remove reached the server after all: the reloaded list no longer holds the record.
  useEffect(() => { if (failed && gone) done(); }, [failed, gone]); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = async (): Promise<void> => { setFailed(false); if (await onRemove()) done(); else setFailed(true); };
  const description = failed ? `Couldn’t remove ${label}. It’s still here, so you can try again.` : `${label} will be gone for good.`;
  return <AlertDialog isOpen title={`Remove from ${listTitle}?`} description={description} actionLabel="Remove" isActionLoading={busy}
    onOpenChange={(open) => { if (!open && !busy) onClose(); }} onAction={() => void confirm()} />;
}
function RecordList({ rows, text, busy, controls, onToggle }: { rows: RecordRow[]; text: ReturnType<typeof rowText>; busy?: boolean; controls?: (row: RecordRow) => ReactElement; onToggle?: (row: RecordRow, field: string, checked: boolean) => void }): ReactElement {
  const { boolean, name, details } = text;
  return <List hasDividers>{rows.map((row) => <ListItem key={row.id} label={name(row)} description={details(row) ? <>{details(row)}</> : undefined}
    startContent={boolean && <CheckboxInput label={`Complete ${name(row)}`} isLabelHidden value={row.values[boolean.id] === true} isDisabled={!onToggle || busy} onChange={(checked) => onToggle?.(row, boolean.id, checked)} />}
    endContent={controls?.(row)} />)}</List>;
}
function ViewHeader({ title, hasTabs, addLabel, isDisabled, onAdd }: { title: string; hasTabs: boolean; addLabel?: string; isDisabled?: boolean; onAdd: () => void }): ReactElement | null {
  if (hasTabs && !addLabel) return null;
  return <HStack gap={3} vAlign="center" hAlign="end" wrap="wrap">{!hasTabs && <StackItem size="fill"><Heading level={2}>{title}</Heading></StackItem>}
    {addLabel && <Button label={addLabel} variant="primary" isDisabled={isDisabled} onClick={onAdd} />}</HStack>;
}
function RowMenu({ label, busy, canEdit, canRemove, onEdit, onRemove }: { label: string; busy?: boolean; canEdit: boolean; canRemove: boolean; onEdit: () => void; onRemove: () => void }): ReactElement {
  const items = [...(canEdit ? [{ label: 'Edit', onClick: onEdit }] : []), ...(canRemove ? [{ label: 'Remove', onClick: onRemove }] : [])];
  return <MoreMenu label={label} presentation="adaptive" alignment="end" isDisabled={busy} items={items} />;
}
function EditRecord({ editing, table, listTitle, rows, createId, updateId, revision, busy, onSave, onClose }: { editing: RecordRow | 'new'; table: AppDefinition['tables'][number]; listTitle: string; rows: RecordRow[]; createId?: string; updateId?: string; revision?: number; busy?: boolean; onSave: NonNullable<Props['onAction']>; onClose: () => void }): ReactElement {
  const row = editing === 'new' ? undefined : editing;
  return <RecordEditor key={row?.id ?? 'new'} table={table} listTitle={listTitle} rows={rows} row={row} revision={revision ?? 1} action={row ? updateId : createId} busy={busy ?? false} onSave={onSave} onClose={onClose} />;
}
function viewActions(definition: AppDefinition, view: RecordView, onAction: Props['onAction']) {
  // A read-only view (no onAction) offers no action at all.
  const allowed = onAction ? definition.actions.filter((item) => view.actions.includes(item.id)) : [];
  const of = (operation: AppDefinition['actions'][number]['operation']) => allowed.find((item) => item.operation === operation);
  return { create: of('create'), update: of('update'), remove: of('delete') };
}
function RecordViewPanel({ view, definition, state, onAction, busy, revision, hasTabs }: Props & { view: RecordView; hasTabs: boolean }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const toast = useToast();
  const [editing, setEditing] = useState<RecordRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<RecordRow | null>(null);
  const table = definition.tables.find((item) => item.id === view.table);
  const rows = state[view.table] ?? [];
  const { create, update, remove } = viewActions(definition, view, onAction);
  const text = rowText(view, table);
  const toggleRow = async (id: string, row: RecordRow, field: string, checked: boolean): Promise<void> => {
    if (!await onAction?.({ operation: 'write', action: id, id: row.id, values: { ...row.values, [field]: checked } })) toast({ body: `Couldn’t update ${text.name(row)}. Try again.`, type: 'error' });
  };
  const toggle = update ? (row: RecordRow, field: string, checked: boolean): void => { void toggleRow(update.id, row, field, checked); } : undefined;
  const controls = update || remove ? (row: RecordRow): ReactElement => <RowMenu label={`Actions for ${text.full(row)}`} busy={busy} canEdit={Boolean(update)} canRemove={Boolean(remove)} onEdit={() => setEditing(row)} onRemove={() => setRemoving(row)} /> : undefined;
  const records = view.kind === 'checklist' || isMobile
    ? <RecordList rows={rows} text={text} busy={busy} controls={controls} onToggle={toggle} />
    : <RecordTable rows={rows} fields={view.fields} controls={controls} />;
  return <VStack gap={4}>
    <ViewHeader title={view.title} hasTabs={hasTabs} addLabel={create ? `Add to ${view.title}` : undefined} isDisabled={busy} onAdd={() => setEditing('new')} />
    {rows.length > 0 ? records : <EmptyState isCompact headingLevel={3} title="Nothing here yet" description={create ? 'Add your first one and it will show up here.' : undefined}
      icon={<img src="/brand/bob/bob-playful.webp" width={96} height={96} alt="" />} />}
    {editing && table && onAction && <EditRecord editing={editing} table={table} listTitle={view.title} rows={rows} createId={create?.id} updateId={update?.id} revision={revision} busy={busy} onSave={onAction} onClose={() => setEditing(null)} />}
    {removing && remove && onAction && <RemoveRecord listTitle={view.title} label={text.full(removing)} gone={!rows.some((item) => item.id === removing.id)} busy={busy} onRemove={() => onAction({ operation: 'delete', action: remove.id, id: removing.id })} onClose={() => setRemoving(null)} />}
  </VStack>;
}
export function AppRenderer(props: Props): ReactElement {
  const [local, setLocal] = useState<AppViewSelection>({ viewId: props.definition.views[0]?.id ?? '' });
  const requested = props.selection ?? local;
  const view = props.definition.views.find((item) => item.id === requested.viewId) ?? props.definition.views[0];
  const slideIndex = view?.kind === 'slides' ? Math.max(0, Math.min(requested.slideIndex ?? 0, view.slides.length - 1)) : undefined;
  const image = props.presentation === 'image';
  const hasTabs = !image && props.definition.views.length > 1;
  const select = (selection: AppViewSelection): void => { setLocal(selection); props.onSelectionChange?.(selection); };
  useEffect(() => {
    if (view && (requested.viewId !== view.id || requested.slideIndex !== slideIndex)) props.onSelectionChange?.({ viewId: view.id, ...(slideIndex === undefined ? {} : { slideIndex }) });
  }, [view?.id, requested.viewId, requested.slideIndex, slideIndex, props.onSelectionChange]);
  return <VStack gap={6}>
    {hasTabs && <TabList value={view?.id ?? ''} onChange={(viewId) => select({ viewId })} hasDivider>{props.definition.views.map((item) => <Tab key={item.id} value={item.id} label={item.title} />)}</TabList>}
    {view && !hasTabs && !('table' in view) && <Heading level={2}>{view.title}</Heading>}
    {view && 'table' in view && <RecordViewPanel key={view.table} {...props} hasTabs={hasTabs} view={view} onAction={image || view.table === props.lockedTable ? undefined : props.onAction} />}
    {view?.kind === 'dashboard' && <Metrics ids={view.metrics} metrics={props.metrics} />}
    {view?.kind === 'slides' && <Slides key={view.id} view={view} metrics={props.metrics} index={slideIndex ?? 0} onChange={(index) => select({ viewId: view.id, slideIndex: index })} image={image} />}
  </VStack>;
}
