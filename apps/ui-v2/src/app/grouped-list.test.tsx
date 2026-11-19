import { render, screen, within } from '@testing-library/react';
import { ListItem } from '@astryxdesign/core/List';
import { describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});

import { GroupedList } from './grouped-list';

function renderList(): void {
  render(
    <GroupedList label="Overdue" count="2 items" action={<a href="/all">See all</a>}>
      <ListItem label="Pay rent" description="Due Friday" />
      <ListItem label="Call Mara" />
    </GroupedList>,
  );
}

describe.each([[true, 'phone'], [false, 'desktop']])('GroupedList on %s (%s)', (isMobile) => {
  it('labels the list and shows the count, action and rows', () => {
    shell.isMobile = isMobile;
    renderList();
    const list = screen.getByRole('list', { name: /Overdue/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('2 items')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all' })).toBeTruthy();
  });
});

describe('GroupedList card', () => {
  it('wraps the rows in a muted section on a phone only', () => {
    shell.isMobile = true;
    const { container, unmount } = render(<GroupedList label="Facts"><ListItem label="One" /></GroupedList>);
    expect(container.querySelector('.astryx-section[data-variant="muted"]')).not.toBeNull();
    unmount();
    shell.isMobile = false;
    const desktop = render(<GroupedList label="Facts"><ListItem label="One" /></GroupedList>);
    expect(desktop.container.querySelector('.astryx-section')).toBeNull();
  });

  it('puts the label above the card on a phone, outside it, and names the list by it', () => {
    shell.isMobile = true;
    const { container } = render(<GroupedList label="Facts" count="6 saved"><ListItem label="One" /></GroupedList>);
    const card = container.querySelector('.astryx-section[data-variant="muted"]');
    const label = screen.getByText('Facts');
    if (card === null) throw new Error('the phone card is missing');
    expect(card.contains(label)).toBe(false);
    expect(card.contains(screen.getByText('6 saved'))).toBe(false);
    expect(card.contains(screen.getByRole('list', { name: 'Facts' }))).toBe(true);
    expect(label.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Both the label row and the card are Sections, so both escape the page gutter the
  // same way wherever the list sits, and the label stays inside the card's edges.
  it('puts the phone label row in its own transparent section, apart from the card', () => {
    shell.isMobile = true;
    const { container } = render(<GroupedList label="Facts" count="6 saved"><ListItem label="One" /></GroupedList>);
    const row = screen.getByText('Facts').closest('.astryx-section[data-variant="transparent"]');
    if (row === null) throw new Error('the label row has no transparent section');
    expect(row.contains(screen.getByText('6 saved'))).toBe(true);
    expect(row.contains(container.querySelector('.astryx-section[data-variant="muted"]'))).toBe(false);
  });

  it('keeps the label in the List header on desktop', () => {
    shell.isMobile = false;
    render(<GroupedList label="Facts"><ListItem label="One" /></GroupedList>);
    const list = screen.getByRole('list', { name: 'Facts' });
    const header = document.getElementById(list.getAttribute('aria-labelledby') ?? '');
    expect(header?.textContent).toContain('Facts');
  });

  it('keeps the count beside the label on desktop, with no fill item between them', () => {
    shell.isMobile = false;
    render(<GroupedList label="Facts" count="6 saved"><ListItem label="One" /></GroupedList>);
    const label = screen.getByRole('heading', { name: 'Facts' });
    const count = screen.getByText('6 saved');
    expect(count.parentElement).toBe(label.parentElement);
  });
});
