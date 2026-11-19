import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppRenderer } from './app-renderer';
import type { AppCommand, AppDefinition, AppRecords } from './bob-apps-api';

const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock('@astryxdesign/core/Toast', async (original) => ({ ...await original<typeof import('@astryxdesign/core/Toast')>(), useToast: () => toast }));

const dialogMethods = ['showModal', 'show', 'close'] as const;
const originalMethods = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => { dialogMethods.forEach((name, index) => { const original = originalMethods[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); }); });
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, 'language'); shell.isMobile = false; toast.mockClear(); });

const fuel: AppDefinition = {
  schemaVersion: 1, title: 'Fuel log', lifecycle: 'keep',
  tables: [{ id: 'fill_ups', fields: [{ id: 'station', type: 'text' }, { id: 'litres', type: 'number' }, { id: 'full_tank', type: 'boolean' }] }],
  actions: [{ id: 'add', table: 'fill_ups', operation: 'create' }, { id: 'edit', table: 'fill_ups', operation: 'update' }, { id: 'remove', table: 'fill_ups', operation: 'delete' }],
  metrics: [], views: [{ id: 'log', kind: 'table', title: 'Fill-ups', table: 'fill_ups', fields: ['station', 'litres'], actions: ['add', 'edit', 'remove'] }],
};
const state: AppRecords = { fill_ups: [{ id: 'one', values: { station: 'Shell', litres: 41.5, full_tank: true } }] };
type Save = (command: AppCommand, revision?: number) => Promise<boolean>;
const view = (onAction: Save, records: AppRecords = state, revision = 3) => <AppRenderer definition={fuel} state={records} metrics={{}} onAction={onAction} revision={revision} />;
const setup = (onAction = vi.fn<Save>().mockResolvedValue(true)) => { render(view(onAction)); return onAction; };
const openRowMenu = () => fireEvent.click(screen.getByRole('button', { name: /^Actions for Shell/ }));
const form = () => screen.getByRole('dialog');
const openAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add to Fill-ups' }));
const clickSave = () => fireEvent.click(within(form()).getByRole('button', { name: 'Save' }));
const number = (name: string) => within(form()).getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;
const type = (input: HTMLInputElement, text: string) => { fireEvent.focus(input); fireEvent.change(input, { target: { value: text } }); fireEvent.blur(input); };
const savedLitres = (save: ReturnType<typeof vi.fn>) => (save.mock.calls[0]?.[0] as { values: { litres: number } }).values.litres;

describe('records on a phone', () => {
  it('lists records with their details and a menu, and no table', () => {
    shell.isMobile = true; setup();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Shell')).toBeTruthy();
    expect(screen.getByText('Litres: 41.5')).toBeTruthy();
    openRowMenu();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy();
  });
  it('opens entry in a sheet named for the view, and does not jump to the keyboard', () => {
    shell.isMobile = true; setup();
    openAdd();
    const sheet = screen.getByRole('dialog', { name: 'Add to Fill-ups' });
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(document.activeElement).not.toBe(within(sheet).getByRole('textbox', { name: 'Station' }));
  });
});

describe('titles and rows', () => {
  it('keeps the table on desktop, with one menu per row', () => {
    setup();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('cell', { name: '41.5' })).toBeTruthy();
  });
  it('tells rows with the same name apart in the menu and the confirmation', () => {
    const repeated = { fill_ups: [{ id: 'a', values: { station: 'Shell', litres: 10, full_tank: true } }, { id: 'b', values: { station: 'Shell', litres: 20, full_tank: true } }] };
    render(view(vi.fn<Save>(), repeated));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shell, Litres: 20' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(within(screen.getByRole('alertdialog')).getByText('Shell, Litres: 20 will be gone for good.')).toBeTruthy();
  });
  it('names a lone view by heading, and leaves that to the tab when there are tabs', () => {
    const { unmount } = render(view(vi.fn<Save>()));
    expect(screen.getByRole('heading', { name: 'Fill-ups' })).toBeTruthy();
    unmount();
    const tabbed = { ...fuel, metrics: [{ id: 'fills', table: 'fill_ups', operation: 'count' as const }], views: [...fuel.views, { id: 'totals', kind: 'dashboard' as const, title: 'Totals', metrics: ['fills'] }] };
    render(<AppRenderer definition={tabbed} state={state} metrics={{ fills: 1 }} />);
    expect(screen.queryByRole('heading', { name: 'Fill-ups' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Totals' }));
    expect(screen.queryByRole('heading', { name: 'Totals' })).toBeNull();
  });
});

describe('number fields', () => {
  it('marks number fields required and says which one needs fixing', () => {
    const save = setup();
    openAdd();
    expect(number('Litres').getAttribute('aria-required') ?? String(number('Litres').required)).toBe('true');
    clickSave();
    expect(within(form()).getByText('Litres needs a number, like 12.5.')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it.each([['0', 0], ['-3.5', -3.5], ['12.5', 12.5], ['1,234.5', 1234.5]])('saves %s', async (text, value) => {
    const save = setup();
    openAdd(); type(number('Litres'), text); clickSave();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(savedLitres(save)).toBe(value);
  });
  it('confirms an add naming the view, at the current revision, then closes', async () => {
    const save = setup();
    openAdd();
    fireEvent.change(within(form()).getByRole('textbox', { name: 'Station' }), { target: { value: 'BP' } });
    type(number('Litres'), '12.5'); clickSave();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ body: 'Added to Fill-ups' })));
    expect(save).toHaveBeenCalledWith({ operation: 'write', action: 'add', id: expect.stringMatching(/^r_/), values: { station: 'BP', litres: 12.5, full_tank: false } }, 3);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it.each(['41.5 l', 'abc', '1,5'])('refuses to save an edit when %s did not commit, rather than saving the old value', (text) => {
    const save = setup();
    openRowMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    type(number('Litres'), text);
    clickSave();
    expect(within(form()).getByText('Litres needs a number, like 12.5.')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it('reads a comma decimal on a comma-decimal phone and shows the example and value that way', async () => {
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true });
    const save = setup();
    openAdd(); clickSave();
    expect(within(form()).getByText('Litres needs a number, like 12,5.')).toBeTruthy();
    type(number('Litres'), '1,5');
    expect(number('Litres').value).toBe('1,5');
    clickSave();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(savedLitres(save)).toBe(1.5);
  });
  it.each(['ArrowUp', 'ArrowDown'])('%s on an empty number starts from zero, not a huge bound', async (key) => {
    const save = setup();
    openAdd();
    fireEvent.focus(number('Litres')); fireEvent.keyDown(number('Litres'), { key }); fireEvent.blur(number('Litres'));
    clickSave();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(savedLitres(save)).toBe(0);
  });
  it('ArrowUp steps a value by one', async () => {
    const save = setup();
    openAdd(); type(number('Litres'), '5');
    fireEvent.focus(number('Litres')); fireEvent.keyDown(number('Litres'), { key: 'ArrowUp' }); fireEvent.blur(number('Litres'));
    clickSave();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(savedLitres(save)).toBe(6);
  });
  it('turns away a number too large to store with a field error', () => {
    const save = setup();
    openAdd(); type(number('Litres'), '2000000000000'); clickSave();
    expect(within(form()).getByText('Litres is too large to save.')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it('clears a field error on focus, so the form holds still under a click on Save', () => {
    setup();
    openAdd(); clickSave();
    fireEvent.focus(number('Litres'));
    expect(within(form()).queryByText('Litres needs a number, like 12.5.')).toBeNull();
    const before = form().textContent;
    fireEvent.change(number('Litres'), { target: { value: '12.5' } }); fireEvent.blur(number('Litres'));
    expect(form().textContent).toBe(before);
  });
});

describe('keyboard', () => {
  it('focuses the first field on desktop and Enter saves a draft still being typed', async () => {
    const save = setup();
    openAdd();
    await waitFor(() => expect(document.activeElement).toBe(within(form()).getByRole('textbox', { name: 'Station' })));
    const input = number('Litres');
    input.focus(); fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(savedLitres(save)).toBe(7);
  });
  it('Enter does not save a draft that is not a number', () => {
    const save = setup();
    openAdd();
    const input = number('Litres');
    input.focus(); fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
    expect(within(form()).getByText('Litres needs a number, like 12.5.')).toBeTruthy();
  });
});

describe('leaving a form', () => {
  const closeImplicitly = () => fireEvent.click(within(form()).getByRole('button', { name: /close/i }));
  it('closes an untouched form straight away', () => {
    setup();
    openAdd(); closeImplicitly();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('asks before discarding what you typed, and keeps it if you stay', () => {
    setup();
    openAdd();
    fireEvent.change(within(form()).getByRole('textbox', { name: 'Station' }), { target: { value: 'BP' } });
    closeImplicitly();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
    expect((within(form()).getByRole('textbox', { name: 'Station' }) as HTMLInputElement).value).toBe('BP');
    closeImplicitly();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('failed saves', () => {
  it('holds the failure inside this attempt: a new form starts clean', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false); setup(save);
    openAdd(); expect(within(form()).queryByText(/Couldn’t save/)).toBeNull();
    type(number('Litres'), '1'); clickSave();
    await within(form()).findByText(/Couldn’t save this/);
    fireEvent.click(within(form()).getByRole('button', { name: 'Cancel' }));
    openAdd();
    expect(within(form()).queryByText(/Couldn’t save/)).toBeNull();
  });
  it('after a conflict shows the review, not the retry message, and clears on Keep', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false);
    const { rerender } = render(view(save));
    openRowMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    clickSave();
    await within(form()).findByText(/Couldn’t save this/);
    rerender(view(save, state, 4));
    expect(within(form()).queryByText(/Couldn’t save/)).toBeNull();
    expect(within(form()).getByText('Saved data changed while you were editing')).toBeTruthy();
    fireEvent.click(within(form()).getByRole('button', { name: 'Keep my edits against latest data' }));
    expect(within(form()).queryByText(/Couldn’t save/)).toBeNull();
    expect(within(form()).queryByText('Saved data changed while you were editing')).toBeNull();
  });
  it('treats an add as saved when the failed attempt turns out to be in the list', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false);
    const { rerender } = render(view(save));
    openAdd(); type(number('Litres'), '9'); clickSave();
    await within(form()).findByText(/Couldn’t save this/);
    const id = (save.mock.calls[0]?.[0] as { id: string }).id;
    rerender(view(save, { fill_ups: [...(state.fill_ups ?? []), { id, values: { station: '', litres: 9, full_tank: false } }] }, 4));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ body: 'Added to Fill-ups' }));
  });
  it('retries under the same record id', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false); setup(save);
    openAdd(); type(number('Litres'), '12.5'); clickSave();
    await within(form()).findByText(/Couldn’t save this/);
    clickSave();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect((save.mock.calls[1]?.[0] as { id: string }).id).toBe((save.mock.calls[0]?.[0] as { id: string }).id);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('removing a record', () => {
  const askRemove = () => { openRowMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' })); return screen.getByRole('alertdialog'); };
  it('asks first, then removes and confirms', async () => {
    const save = setup();
    const confirm = askRemove();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ operation: 'delete', action: 'remove', id: 'one' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ body: 'Removed from Fill-ups' })));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
  it('keeps the record when you cancel', () => {
    const save = setup();
    fireEvent.click(within(askRemove()).getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('says so in the dialog when the remove fails, and lets you try again', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false); setup(save);
    fireEvent.click(within(askRemove()).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('alertdialog')).findByText(/Couldn’t remove Shell/)).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });
  it('treats a failed remove as done when the record has gone', async () => {
    const save = vi.fn<Save>().mockResolvedValue(false);
    const { rerender } = render(view(save));
    fireEvent.click(within(askRemove()).getByRole('button', { name: 'Remove' }));
    await within(screen.getByRole('alertdialog')).findByText(/Couldn’t remove Shell/);
    rerender(view(save, { fill_ups: [] }, 4));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ body: 'Removed from Fill-ups' }));
  });
});

it('offers no add or row menu on a read-only app and explains an empty one', () => {
  render(<AppRenderer definition={fuel} state={{}} metrics={{}} />);
  expect(screen.queryByRole('button', { name: 'Add to Fill-ups' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Nothing here yet' })).toBeTruthy();
});
