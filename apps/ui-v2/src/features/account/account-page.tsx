import { BRAND } from '@/lib/brand';
import { useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Link } from '@astryxdesign/core/Link';
import { ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { createStaticSource, Typeahead, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import { getSupabaseSetup } from '@/lib/auth/supabase-client';
import { browserTimeZone, fetchWithAuth, useSession } from '@/lib/auth/use-session';
import { accountDisplayName } from '@/lib/display-name';
import { DeleteAllMemoriesSection } from '@/features/memory/delete-all-memories';
import { NotificationSettingsSection } from '@/features/notifications/notification-settings';
import { UsageSection } from '@/features/usage/usage-section';
import { AppearanceControl } from '../../app/appearance-control';
import { GroupedList } from '@/app/grouped-list';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '@/app/page-width';
import { navigateTo, useLocationHash } from '@/app/routes';
import { DeleteAccountSection } from './account-delete-section';

const NAME_MAX = 60;
const NAME_ERROR = 'Display name must be 1 to 60 characters.';
const SAVE_ERROR = "Your name couldn't be saved.";
const RESET_ERROR = "The reset link couldn't be sent.";
const NO_CLIENT_NOTE = "Your name and password can't be changed when you're signed in this way.";
const ZONE_SAVE_ERROR = "Your time zone couldn't be saved.";
const ZONE_NO_CLIENT_NOTE = "Your time zone can't be changed when you're signed in this way.";
const EXPORT_ERROR = "Your data couldn't be exported.";
const SIGN_OUT_EVERYWHERE_ERROR = "Other devices may still be signed in. Try again.";
const EXPORT_LIMITED = 'You just exported your data. Try again in a minute.';

// IANA has renamed these zones, but V8 still lists them only by the old ID. The
// label leads with today's name so both spellings match; the saved value stays
// the listed ID, which every `Intl` accepts.
const RENAMED_ZONES: Readonly<Record<string, string>> = {
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

function zoneItem(zone: string): SearchableItem {
  const current = RENAMED_ZONES[zone];
  const label = current ? `${current} (${zone})` : zone;
  return { id: zone, label: label.replaceAll('_', ' ') };
}

// Every IANA zone this browser knows, plus UTC, which V8 leaves out of the list.
const ZONE_SOURCE = createStaticSource(['UTC', ...Intl.supportedValuesOf('timeZone')].map(zoneItem));

// Resolves the Supabase client on mount; null while in flight, unavailable,
// or on the local dev sign-in path (getSupabaseSetup never returns 'ready').
function useAccountSetup(): { client: SupabaseClient | null; loaded: boolean } {
  const [state, setState] = useState<{ client: SupabaseClient | null; loaded: boolean }>({
    client: null,
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    void getSupabaseSetup().then((setup) => {
      if (!cancelled) {
        setState({ client: setup.status === 'ready' ? setup.client : null, loaded: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

// The settings template's info row: label and supporting text, the action
// beside them; the Section draws the divider. The row wraps so a phone never clips the action.
function InfoRow({
  label,
  description,
  action,
  children,
}: {
  label: string;
  description: string;
  action?: ReactNode;
  /** Banners and notes under the row. */
  children?: ReactNode;
}): ReactElement {
  // A phone takes the compact row step (8px a side, not 16px), so rows sit closer together.
  const { isMobile } = useAppShellMobile();
  // On a phone the row is one item of the section's grouped card: label, description, action.
  if (isMobile) {
    return (
      <ListItem
        label={label}
        description={
          <VStack gap={2}>
            <Text type="supporting">{description}</Text>
            {children}
          </VStack>
        }
        endContent={action}
      />
    );
  }
  return (
    <>
      <VStack gap={3} paddingBlock={isMobile ? 2 : 4}>
        <HStack gap={3} hAlign="between" vAlign="start" wrap="wrap">
          <VStack gap={0}>
            <Text type="body" weight="semibold" display="block">
              {label}
            </Text>
            <Text type="supporting" display="block">
              {description}
            </Text>
          </VStack>
          {action}
        </HStack>
        {children}
      </VStack>
    </>
  );
}

// The template's ExpandableRow: collapsed, an InfoRow with Edit (none without onEdit);
// expanded, the field with Save and Cancel. The notice shows in both states.
function ExpandableRow({
  label,
  value,
  isExpanded,
  onEdit,
  onSave,
  onCancel,
  isSaving,
  isSaveDisabled,
  notice,
  children,
}: {
  label: string;
  value: string;
  isExpanded: boolean;
  onEdit: (() => void) | undefined;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  isSaveDisabled: boolean;
  notice: ReactNode;
  /** The field shown while expanded. */
  children: ReactNode;
}): ReactElement {
  const { isMobile } = useAppShellMobile();
  if (!isExpanded) {
    const edit = onEdit && <Button label="Edit" variant="ghost" size="sm" onClick={onEdit} />;
    return (
      <InfoRow label={label} description={value} action={edit}>
        {notice}
      </InfoRow>
    );
  }
  const actions = (
    <HStack gap={2} wrap="wrap">
      <Button label="Save" variant="primary" isLoading={isSaving} isDisabled={isSaveDisabled} onClick={onSave} />
      <Button label="Cancel" variant="ghost" isDisabled={isSaving} onClick={onCancel} />
    </HStack>
  );
  // On a phone the editor stays inside the section's grouped card, as the row's description.
  if (isMobile) {
    return (
      <ListItem
        label={label}
        description={
          <VStack gap={3}>
            {notice}
            {children}
            {actions}
          </VStack>
        }
      />
    );
  }
  return (
    <>
      <VStack gap={4} paddingBlock={4}>
        <Text type="body" weight="semibold" display="block">
          {label}
        </Text>
        {notice}
        {children}
        {actions}
      </VStack>
    </>
  );
}

function ProfileSection({
  client,
  savedName,
}: {
  client: SupabaseClient | null;
  savedName: string;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(savedName);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'error'; message: string } | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const toast = useToast();

  const save = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      setStatus({ type: 'error', message: NAME_ERROR });
      return;
    }
    setStatus(undefined);
    setFailed(false);
    setSaving(true);
    try {
      const { error } = await client!.auth.updateUser({ data: { name: trimmed, full_name: trimmed } });
      if (!error) {
        toast({ body: 'Name saved', isAutoHide: true, uniqueID: 'settings-name-saved' });
        setIsEditing(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const cancel = (): void => {
    setDraft(savedName);
    setStatus(undefined);
    setFailed(false);
    setIsEditing(false);
  };

  return (
    <ExpandableRow
      label="Display name"
      value={draft.trim() || 'Not set'}
      isExpanded={isEditing}
      onEdit={client ? () => setIsEditing(true) : undefined}
      onSave={() => void save()}
      onCancel={cancel}
      isSaving={saving}
      isSaveDisabled={draft.trim() === savedName}
      notice={
        client ? (
          failed && <RetryBanner title={SAVE_ERROR} onRetry={() => void save()} />
        ) : (
          <Text type="supporting">{NO_CLIENT_NOTE}</Text>
        )
      }
    >
      <TextInput
        label="Display name"
        isLabelHidden
        description="Your name as your spaces see it. It also sets your @handle."
        value={draft}
        onChange={(value) => setDraft(value.slice(0, NAME_MAX))}
        onEnter={() => void save()}
        status={status}
      />
    </ExpandableRow>
  );
}

function TimeZoneSection({
  client,
  savedZone,
}: {
  client: SupabaseClient | null;
  savedZone: string | null;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<SearchableItem | null>(zoneItem(savedZone ?? browserTimeZone()));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const toast = useToast();

  const save = async (): Promise<void> => {
    if (!client || !draft) return;
    setFailed(false);
    setSaving(true);
    try {
      const { error } = await client.auth.updateUser({ data: { time_zone: draft.id } });
      // A fresh access token carries the new zone to the server on the next request.
      if (!error) await client.auth.refreshSession();
      if (!error) {
        toast({ body: 'Time zone saved', isAutoHide: true, uniqueID: 'settings-zone-saved' });
        setIsEditing(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const cancel = (): void => {
    setDraft(zoneItem(savedZone ?? browserTimeZone()));
    setFailed(false);
    setIsEditing(false);
  };

  return (
    <ExpandableRow
      label="Time zone"
      value={draft?.label ?? 'Not set'}
      isExpanded={isEditing}
      onEdit={client ? () => setIsEditing(true) : undefined}
      onSave={() => void save()}
      onCancel={cancel}
      isSaving={saving}
      isSaveDisabled={!draft || draft.id === savedZone}
      notice={
        client ? (
          failed && <RetryBanner title={ZONE_SAVE_ERROR} onRetry={() => void save()} />
        ) : (
          <Text type="supporting">{ZONE_NO_CLIENT_NOTE}</Text>
        )
      }
    >
      <Typeahead
        label="Your time zone"
        isLabelHidden
        description={`${BRAND.name} and the app use it for today, due dates and times.`}
        placeholder="Search time zones"
        searchSource={ZONE_SOURCE}
        value={draft}
        onChange={setDraft}
        hasEntriesOnFocus
        debounceMs={0}
      />
    </ExpandableRow>
  );
}

function SignInSecuritySection({
  client,
  email,
}: {
  client: SupabaseClient | null;
  email: string | null;
}): ReactElement {
  const { signOutEverywhere } = useSession();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const sendReset = async (): Promise<void> => {
    if (!client || !email) return;
    setSending(true);
    setResetFailed(false);
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset`,
      });
      if (error) setResetFailed(true);
      else toast({ body: 'Check your email for a reset link', isAutoHide: true, uniqueID: 'settings-reset-sent' });
    } catch {
      setResetFailed(true);
    } finally {
      setSending(false);
    }
  };

  // A failed global revoke keeps this device signed in, so the person can see
  // it failed and try again; success signs this device out too.
  const confirmSignOutEverywhere = async (): Promise<void> => {
    setSigningOutEverywhere(true);
    setSignOutFailed(false);
    try {
      const ok = await signOutEverywhere();
      setSignOutDialogOpen(false);
      if (!ok) setSignOutFailed(true);
    } finally {
      setSigningOutEverywhere(false);
    }
  };

  return (
    <>
      <InfoRow
        label="Password"
        description="We’ll email you a link to set a new password."
        action={
          client && (
            <Button
              label="Email me a reset link"
              size="sm"
              isLoading={sending}
              isDisabled={!email}
              onClick={() => void sendReset()}
            />
          )
        }
      >
        {resetFailed && <RetryBanner title={RESET_ERROR} onRetry={() => void sendReset()} />}
      </InfoRow>
      <InfoRow
        label="Sign out everywhere"
        description="Sign out on every device, including this one."
        action={
          <Button label="Sign out everywhere" variant="ghost" size="sm" onClick={() => setSignOutDialogOpen(true)} />
        }
      >
        {signOutFailed && (
          <RetryBanner title={SIGN_OUT_EVERYWHERE_ERROR} onRetry={() => void confirmSignOutEverywhere()} />
        )}
      </InfoRow>
      <AlertDialog
        isOpen={signOutDialogOpen}
        onOpenChange={(isOpen) => {
          if (!signingOutEverywhere) setSignOutDialogOpen(isOpen);
        }}
        title="Sign out everywhere?"
        description="You'll be signed out on every device, including this one, and need to sign in again."
        actionLabel="Sign out everywhere"
        isActionLoading={signingOutEverywhere}
        onAction={() => void confirmSignOutEverywhere()}
      />
    </>
  );
}

type ExportOutcome = 'done' | 'rate_limited' | 'error';

// GET /api/account/export answers the caller's own data as a JSON attachment;
// the bearer token rules out a plain link, so the file is saved from a blob.
async function downloadAccountExport(): Promise<ExportOutcome> {
  const response = await fetchWithAuth('/api/account/export');
  if (response.status === 429) return 'rate_limited';
  if (!response.ok) return 'error';
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'bob-export.json';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'done';
}

function ExportSection(): ReactElement {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<'rate_limited' | 'error' | null>(null);

  const runExport = async (): Promise<void> => {
    setExporting(true);
    setProblem(null);
    try {
      const outcome = await downloadAccountExport();
      if (outcome === 'done') toast({ body: 'Your data was downloaded', isAutoHide: true, uniqueID: 'settings-export' });
      else setProblem(outcome);
    } catch {
      setProblem('error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <InfoRow
      label="Export"
      description="Download what you’ve created: conversations, memories, and the tasks, notes, events, reminders and timers you added. Other members’ content is not included."
      action={<Button label="Export my data" size="sm" isLoading={exporting} onClick={() => void runExport()} />}
    >
      {problem === 'rate_limited' && <Banner status="info" title={EXPORT_LIMITED} />}
      {problem === 'error' && <RetryBanner title={EXPORT_ERROR} onRetry={() => void runExport()} />}
    </InfoRow>
  );
}

// The sections, in page order; each id is the #hash that deep-links to it.
export const SETTINGS_SECTIONS = [
  'profile', 'appearance', 'notifications', 'usage', 'security', 'data', 'delete',
] as const;
type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/** The section the hash names, or null. (Google accounts live on /integrations.) */
export function settingsTarget(hash: string): SettingsSectionId | null {
  const id = hash.replace(/^#/, '');
  return (SETTINGS_SECTIONS as readonly string[]).includes(id) ? (id as SettingsSectionId) : null;
}

// Scrolls to the hash's section on load and whenever the hash changes, so a
// deep link, a reload and Back all land on the same section.
function useScrollToSection(): void {
  const hash = useLocationHash();
  useEffect(() => {
    const target = settingsTarget(hash);
    if (target === null) return;
    // After the sections have rendered.
    const frame = window.requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [hash]);
}

// One settings Section (template `settings`, block SectionWithDividers): a
// heading and its rows; the id is the deep-link target.
function SettingsSection({
  id,
  title,
  description,
  isLast = false,
  isGrouped = false,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  description?: string;
  isLast?: boolean;
  /** Its rows are all list items: on a phone they sit in one grouped card. */
  isGrouped?: boolean;
  children: ReactNode;
}): ReactElement {
  const { isMobile } = useAppShellMobile();
  const pagePadding = usePagePadding();
  if (isMobile && isGrouped) {
    // A plain stack, not a Section: the grouped card is itself a Section, and nesting two
    // Sections let the card escape the page gutter (rows at x 7 on a 390px phone).
    return (
      <VStack id={id} paddingInline={pagePadding} paddingBlock={3}>
        <GroupedList label={title}>{children}</GroupedList>
      </VStack>
    );
  }
  return (
    // Section escapes the Layout's gutter and re-applies only its own, so it carries
    // the same gutter inline to keep headings on the page title's line. On a phone the
    // headings step down one level (accessibilityLevel keeps the outline at 2) and sections
    // take the compact block step; desktop leaves the block unset.
    <Section
      id={id}
      aria-labelledby={`${id}-heading`}
      variant="transparent"
      paddingInline={pagePadding}
      paddingBlock={isMobile ? 3 : undefined}
      dividers={isLast ? undefined : ['bottom']}
    >
      <VStack gap={1}>
        <Heading level={isMobile ? 3 : 2} accessibilityLevel={2} id={`${id}-heading`}>
          {title}
        </Heading>
        {description !== undefined && <Text type="supporting">{description}</Text>}
      </VStack>
      {children}
    </Section>
  );
}

/** An inline failure with one way forward. */
function RetryBanner({ title, onRetry }: { title: string; onRetry: () => void }): ReactElement {
  return <Banner status="error" title={title} endContent={<Button label="Try again" size="sm" onClick={onRetry} />} />;
}

function inAppLink(path: string): (event: MouseEvent) => void {
  return (event) => {
    event.preventDefault();
    navigateTo(path);
  };
}

/**
 * Settings: one scrolling page in the app's one frame (PAGE_WIDTH), every
 * section deep-linked by #hash (/settings#usage). No second rail.
 */
export function SettingsPage(): ReactElement {
  const { session } = useSession();
  const { client } = useAccountSetup();
  const email = session?.user.email ?? null;
  const savedName = accountDisplayName(session?.user) ?? '';
  const storedZone: unknown = session?.user.user_metadata?.time_zone;
  const savedZone = typeof storedZone === 'string' ? storedZone : null;
  useScrollToSection();
  const pagePadding = usePagePadding();

  return (
    <Layout
      height="fill"
      padding={pagePadding}
      contentWidth={PAGE_WIDTH}
      header={
        <LayoutHeader>
          <VStack gap={1}>
            <PageTitle>Settings</PageTitle>
            <Text type="supporting">{email ?? 'Signed in'}</Text>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent label="Settings">
          <VStack gap={0}>
            <SettingsSection id="profile" title="Profile" isGrouped>
              <ProfileSection client={client} savedName={savedName} />
              <TimeZoneSection client={client} savedZone={savedZone} />
            </SettingsSection>
            <SettingsSection id="appearance" title="Appearance" isGrouped>
              <InfoRow label="Theme" description="Follow your device, or always light or dark." action={<AppearanceControl />} />
            </SettingsSection>
            <SettingsSection id="notifications" title="Notifications" isGrouped>
              <NotificationSettingsSection />
            </SettingsSection>
            <SettingsSection id="usage" title="Usage" description="Counts and times only, never what you said. Only you can see this.">
              <UsageSection />
            </SettingsSection>
            <SettingsSection id="security" title="Sign-in and security" isGrouped>
              <SignInSecuritySection client={client} email={email} />
            </SettingsSection>
            <SettingsSection id="data" title="Your data">
              <ExportSection />
              <DeleteAllMemoriesSection />
              <InfoRow
                label="Devices"
                description={`The ${BRAND.assistantName} devices paired to your account.`}
                action={
                  <Link href="/devices" onClick={inAppLink('/devices')}>
                    Open Devices
                  </Link>
                }
              />
              <InfoRow
                label="Integrations"
                description={`The Google accounts and other services ${BRAND.assistantName} can use.`}
                action={
                  <Link href="/integrations" aria-label="Open Integrations" onClick={inAppLink('/integrations')}>
                    Open Integrations
                  </Link>
                }
              />
            </SettingsSection>
            <SettingsSection id="delete" title="Delete account" isLast>
              <DeleteAccountSection email={email} />
            </SettingsSection>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
