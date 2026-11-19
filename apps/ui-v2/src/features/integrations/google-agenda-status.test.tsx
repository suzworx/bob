import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNTS_PATH, GoogleAgendaStatus } from './google-agenda-row';

const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('../../app/routes', () => ({ navigateTo }));
const source = { account_id: 'a', calendar_id: 'c', last_success_at: null };

it('links a reconnect warning to the Integrations page', async () => {
  render(<GoogleAgendaStatus state={{ remote_items: [], sources: [{ ...source, state: 'reconnect_required' }] }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Fix in Integrations' }));
  expect(navigateTo).toHaveBeenCalledWith(GOOGLE_ACCOUNTS_PATH);
  expect(GOOGLE_ACCOUNTS_PATH).toBe('/integrations');
});

it('offers no fix when Google was only slow', () => {
  render(<GoogleAgendaStatus state={{ remote_items: [], sources: [{ ...source, state: 'partial' }] }} />);
  expect(screen.queryByRole('button', { name: 'Fix in Integrations' })).toBeNull();
});
