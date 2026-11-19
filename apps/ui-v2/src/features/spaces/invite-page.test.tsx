import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvitePage } from '@/features/spaces/invite-page';

vi.mock('@/features/spaces/use-invitation');
vi.mock('@/lib/auth/use-session', () => ({ useSession: vi.fn() }));
vi.mock('../account/sign-in', () => ({
  SignIn: () => <div data-testid="sign-in">Sign in heading</div>,
}));
vi.mock('../../app/routes', () => ({
  navigateTo: vi.fn(),
}));

const mockUseInvitation = vi.mocked(
  (await import('@/features/spaces/use-invitation')).useInvitation,
);
const mockUseSession = vi.mocked((await import('@/lib/auth/use-session')).useSession);
const mockNavigateTo = vi.mocked((await import('../../app/routes')).navigateTo);

beforeEach(() => {
  mockUseSession.mockReturnValue({
    status: 'signed-in',
    session: null,
    unavailable: null,
    signOut: vi.fn(),
    signOutEverywhere: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InvitePage', () => {
  it('shows loading spinner with aria label', () => {
    mockUseInvitation.mockReturnValue({
      preview: null,
      loading: true,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByLabelText('Loading your invitation…')).toBeTruthy();
  });

  it('shows preview and accepts invitation', async () => {
    const user = userEvent.setup();
    const acceptFn = vi.fn(async () => null);
    mockUseInvitation.mockReturnValue({
      preview: {
        space_name: 'Test Family',
        space_kind: 'group',
        inviter_display_name: 'Alice',
        exposes_history: true,
        role: 'member',
        expires_at: Date.UTC(2026, 9, 20, 12, 0, 0),
      },
      loading: false,
      error: null,
      accepting: false,
      accept: acceptFn,
      outcome: null,
      retry: vi.fn(),
    });

    const { rerender } = render(<InvitePage token="test-token" />);

    expect(screen.getByText('Test Family')).toBeTruthy();
    expect(screen.getByText(/You're invited to a shared space by Alice/)).toBeTruthy();
    expect(
      screen.getByText(/Joining lets every member see this space's full conversation history/),
    ).toBeTruthy();

    const acceptButton = screen.getByRole('button', { name: /Accept/ });
    await user.click(acceptButton);

    expect(acceptFn).toHaveBeenCalled();

    mockUseInvitation.mockReturnValue({
      preview: { space_name: 'Test Family', space_kind: 'group', inviter_display_name: 'Alice', exposes_history: true, role: 'member', expires_at: Date.UTC(2026, 9, 20, 12, 0, 0) },
      loading: false,
      error: null,
      accepting: false,
      accept: acceptFn,
      outcome: 'accepted',
      retry: vi.fn(),
    });

    rerender(<InvitePage token="test-token" />);

    expect(screen.getByText("You're in! Welcome to Test Family.")).toBeTruthy();
    expect(screen.getByRole('button', { name: /Go to your space/ })).toBeTruthy();
  });

  it('shows the waitlist hint on a signed-out preview, alongside Accept', () => {
    mockUseSession.mockReturnValue({
      status: 'signed-out',
      session: null,
      unavailable: null,
      signOut: vi.fn(),
      signOutEverywhere: vi.fn(),
    });
    mockUseInvitation.mockReturnValue({
      preview: {
        space_name: 'Test Family',
        space_kind: 'group',
        inviter_display_name: 'Alice',
        exposes_history: true,
        role: 'member',
        expires_at: Date.UTC(2026, 9, 20, 12, 0, 0),
      },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByRole('button', { name: /Accept/ })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Join the waitlist/ });
    expect(link.getAttribute('href')).toBe('https://heybob.xyz');
    expect(screen.getByText(/Bob is invite-only/)).toBeTruthy();
  });

  it('shows no waitlist hint on a signed-in preview', () => {
    mockUseInvitation.mockReturnValue({
      preview: {
        space_name: 'Test Family',
        space_kind: 'group',
        inviter_display_name: 'Alice',
        exposes_history: true,
        role: 'member',
        expires_at: Date.UTC(2026, 9, 20, 12, 0, 0),
      },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByRole('button', { name: /Accept/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Join the waitlist/ })).toBeNull();
  });

  it('shows already-a-member message', () => {
    mockUseInvitation.mockReturnValue({
      preview: { space_name: 'Test Family', space_kind: 'group', inviter_display_name: 'Alice', exposes_history: true, role: 'member', expires_at: Date.UTC(2026, 9, 20, 12, 0, 0) },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: 'already_member',
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/You're already a member of Test Family/)).toBeTruthy();
  });

  it('shows not_usable error', () => {
    mockUseInvitation.mockReturnValue({
      preview: null,
      loading: false,
      error: {
        kind: 'not_usable',
        message: "This invitation can't be used. It may have expired, been revoked, or already been used.",
      },
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByText("This invitation isn't available")).toBeTruthy();
    expect(screen.getByText(/expired, been revoked, or already been used/)).toBeTruthy();
  });

  it('shows wrong_account error with preview', () => {
    mockUseInvitation.mockReturnValue({
      preview: { space_name: 'Test Family', space_kind: 'group', inviter_display_name: 'Alice', exposes_history: true, role: 'member', expires_at: Date.UTC(2026, 9, 20, 12, 0, 0) },
      loading: false,
      error: {
        kind: 'wrong_account',
        message: 'This invitation was sent to a different account. Sign in with that account, or ask for a new invite.',
      },
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByText('Test Family')).toBeTruthy();
    expect(screen.getByText(/different account/)).toBeTruthy();
  });

  it('shows network_error with retry', async () => {
    const user = userEvent.setup();
    const retryFn = vi.fn();
    mockUseInvitation.mockReturnValue({
      preview: null,
      loading: false,
      error: {
        kind: 'network_error',
        message: "Couldn't reach the server. Check your connection and try again.",
      },
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: retryFn,
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByText("This invitation isn't available")).toBeTruthy();
    expect(screen.getByText(/Couldn't reach the server/)).toBeTruthy();

    const retryButton = screen.getByRole('button', { name: /Try again/ });
    await user.click(retryButton);

    expect(retryFn).toHaveBeenCalled();
  });

  it('renders sign-in when sign_in_required', () => {
    mockUseSession.mockReturnValue({
      status: 'signed-out',
      session: null,
      unavailable: null,
      signOut: vi.fn(),
      signOutEverywhere: vi.fn(),
    });
    const retry = vi.fn();
    mockUseInvitation.mockReturnValue({
      preview: null,
      loading: false,
      error: { kind: 'sign_in_required', message: 'Sign in to continue.' },
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry,
    });

    render(<InvitePage token="test-token" />);

    expect(screen.getByTestId('sign-in')).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();
  });

  it('reloads the invitation once signed in on the invite page, instead of staying on sign-in', () => {
    const retry = vi.fn();
    mockUseInvitation.mockReturnValue({
      preview: {
        space_name: 'Test Family',
        space_kind: 'group',
        inviter_display_name: 'Alice',
        exposes_history: true,
        role: 'member',
        expires_at: Date.UTC(2026, 9, 20, 12, 0, 0),
      },
      loading: false,
      error: { kind: 'sign_in_required', message: 'Sign in to continue.' },
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry,
    });

    render(<InvitePage token="test-token" />);

    expect(screen.queryByTestId('sign-in')).toBeNull();
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Accept/ })).toBeTruthy();
  });

  it('navigates to /spaces on accept success', async () => {
    const user = userEvent.setup();
    mockUseInvitation.mockReturnValue({
      preview: { space_name: 'Test Family', space_kind: 'group', inviter_display_name: 'Alice', exposes_history: true, role: 'member', expires_at: Date.UTC(2026, 9, 20, 12, 0, 0) },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: 'accepted',
      retry: vi.fn(),
    });

    render(<InvitePage token="test-token" />);

    const linkButton = screen.getByRole('button', { name: /Go to your space/ });
    await user.click(linkButton);

    expect(mockNavigateTo).toHaveBeenCalledWith('/spaces');
  });
});

// #859: the preview must tell the invitee the role on offer and when the offer
// ends. The DTO carries `role` and `expires_at` (epoch ms).
describe('InvitePage offered role and expiry (#859)', () => {
  const EXPIRES_AT = Date.UTC(2026, 9, 20, 12, 0, 0);

  function showPreview(role: 'admin' | 'member'): void {
    mockUseInvitation.mockReturnValue({
      preview: {
        space_name: 'Test Family',
        space_kind: 'group',
        inviter_display_name: 'Alice',
        exposes_history: false,
        role,
        expires_at: EXPIRES_AT,
      },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 12, 0, 0)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('#859 shows the admin role on offer and the absolute expiry date', () => {
    showPreview('admin');
    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/as (an )?admin/i)).toBeTruthy();
    expect(screen.getByText(/October 20, 2026|20 October 2026|Oct 20, 2026|20 Oct 2026/)).toBeTruthy();
  });

  it('#859 shows the member role on offer and invents no invited email', () => {
    showPreview('member');
    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/as (a )?member/i)).toBeTruthy();
    expect(screen.getByText(/October 20, 2026|20 October 2026|Oct 20, 2026|20 Oct 2026/)).toBeTruthy();
    expect(screen.queryByText(/@/)).toBeNull();
  });
});

// #859 compatibility: an older API returns the four-field preview. Role and
// expiry are optional and each renders only when supplied.
describe('InvitePage optional role and expiry (#859)', () => {
  const EXPIRES_AT = Date.UTC(2026, 9, 20, 12, 0, 0);
  const BASE = {
    space_name: 'Test Family',
    space_kind: 'group',
    inviter_display_name: 'Alice',
    exposes_history: false,
  };

  function showPreview(extra: { role?: 'admin' | 'member'; expires_at?: number }): void {
    mockUseInvitation.mockReturnValue({
      preview: { ...BASE, ...extra },
      loading: false,
      error: null,
      accepting: false,
      accept: vi.fn(),
      outcome: null,
      retry: vi.fn(),
    });
  }

  it('#859 old four-field preview renders without a role or an expiry and does not throw', () => {
    showPreview({});
    render(<InvitePage token="test-token" />);

    expect(screen.getByText('Test Family')).toBeTruthy();
    expect(screen.queryByText(/you'll join as/i)).toBeNull();
    expect(screen.queryByText(/expires/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('#859 shows only the role when expires_at is missing', () => {
    showPreview({ role: 'admin' });
    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/join as an admin/i)).toBeTruthy();
    expect(screen.queryByText(/expires/i)).toBeNull();
  });

  it('#859 shows only the UTC expiry date when role is missing', () => {
    showPreview({ expires_at: EXPIRES_AT });
    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/expires on October 20, 2026 \(UTC\)/i)).toBeTruthy();
    expect(screen.queryByText(/you'll join as/i)).toBeNull();
  });

  it('#859 an expiry outside the JS Date range does not crash and invents no date', () => {
    showPreview({ role: 'member', expires_at: 1e20 });
    render(<InvitePage token="test-token" />);

    expect(screen.getByText(/join as a member/i)).toBeTruthy();
    expect(screen.queryByText(/expires/i)).toBeNull();
  });
});
