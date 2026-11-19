import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

it('shows Bob for the synthetic assistant but preserves protocol and real member identities', async () => {
  window.history.replaceState(null, '', '/?brand=bob');
  vi.resetModules();
  const { mentionToken, mentionDescription } = await import('./mentions');
  const assistant = { user_id: 'bob', role: 'assistant', display_name: 'Bob', handle: 'bob', email: null };
  expect(mentionToken(assistant)).toMatchObject({ label: 'Bob', value: '@bob' });
  expect(mentionDescription(assistant)).toBe('Ask Bob');
  const person = { ...assistant, user_id: 'person-1', role: 'member', display_name: 'Ole Xa' };
  expect(mentionToken(person)).toMatchObject({ label: 'Ole Xa', value: '@bob' });
  expect(mentionDescription(person)).toBe('@bob');
});
