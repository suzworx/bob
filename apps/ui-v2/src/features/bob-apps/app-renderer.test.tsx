import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppRenderer } from './app-renderer';
import { starterApp } from './app-starters';
import { RecordEditor } from './record-editor';
const dialogMethods = ['showModal', 'close'] as const;
const originalMethods = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => { dialogMethods.forEach((name, index) => { const original = originalMethods[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); }); });
describe('saved app renderer', () => {
  it('does not carry an open editor into another table view', () => {
    const definition = starterApp('checklist');
    definition.tables.push({ id: 'other', fields: [{ id: 'note', type: 'text' }] });
    definition.actions.push({ id: 'create_other', table: 'other', operation: 'create' });
    definition.views.push({ id: 'other', kind: 'table', title: 'Other records', table: 'other', fields: ['note'], actions: ['create_other'] });
    render(<AppRenderer definition={definition} state={{}} metrics={{ items: 0 }} onAction={vi.fn().mockResolvedValue(true)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Checklist' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unsent item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Other records' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Other records' }));
    expect((screen.getByRole('textbox', { name: 'Note' }) as HTMLInputElement).value).toBe('');
  });
  it('renders saved record text without executing markup', () => {
    const definition = starterApp('checklist');
    render(<AppRenderer definition={definition} state={{ items: [{ id: 'one', values: { title: '<script>bad()</script>', completed: false } }] }} metrics={{ items: 1 }} />);
    expect(screen.getByText('<script>bad()</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to Checklist' })).toBeNull();
  });
  it('uses the same live metrics for dashboard and slide views', () => {
    const definition = starterApp('budget');
    const { rerender } = render(<AppRenderer definition={definition} state={{}} metrics={{ items: 2, total: 150 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByText('150')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Presentation' }));
    expect(screen.getByText('150')).toBeTruthy();
    rerender(<AppRenderer definition={definition} state={{}} metrics={{ items: 3, total: 175 }} />);
    expect(screen.getByText('175')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next slide' }).getAttribute('disabled')).not.toBeNull();
  });
  it('keeps edits when a newer revision arrives and requires review before replacing it', () => {
    const table = starterApp('budget').tables[0];
    const save = vi.fn().mockResolvedValue(false);
    const row = { id: 'one', values: { title: 'First', amount: 10 } };
    const { rerender } = render(<RecordEditor table={table} listTitle="Expenses" rows={[row]} row={row} revision={1} action="update" busy={false} onSave={save} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'My edit' } });
    rerender(<RecordEditor table={table} listTitle="Expenses" rows={[{ ...row, values: { title: 'Remote edit', amount: 20 } }]} row={row} revision={2} action="update" busy={false} onSave={save} onClose={vi.fn()} />);
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('My edit');
    expect(screen.getByText('Title: Remote edit · Amount: 20')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits against latest data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ operation: 'write', action: 'update', id: 'one', values: { title: 'My edit', amount: 10 } }, 2);
  });
});
