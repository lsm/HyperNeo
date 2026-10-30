import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
const spaces = signal([]);
vi.mock('../../../lib/space-store.ts', () => ({
  get spaceStore() {
    return { spacesWithTasks: spaces, initGlobalList: async () => {} };
  },
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
vi.mock('../../space/SpaceCreateDialog.tsx', () => ({ SpaceCreateDialog: () => null }));
vi.mock('../../../islands/BottomTabBar.tsx', () => ({ BottomTabBar: () => null }));
vi.mock('../../voice/VoiceRecordingIndicator.tsx', () => ({ VoiceRecordingIndicator: () => null }));
vi.mock('../../ui/MobileMenuButton.tsx', () => ({ MobileMenuButton: () => null }));

import MainContent from '../../../islands/MainContent.tsx';
import { locale } from '../../../lib/i18n/index.ts';
import {
  currentSessionIdSignal,
  currentSpaceIdSignal,
  currentSpaceCanonicalIdSignal,
  navSectionSignal,
  settingsSectionSignal,
  type SettingsSection,
} from '../../../lib/signals.ts';

const account = {
  id: 'synthetic-connection',
  provider: 'google',
  accountId: 'synthetic-account',
  email: 'one@example.test',
  scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
  health: 'reconnect_needed',
};
type Invocation = { name: string; input?: Record<string, unknown> };
let accounts: (typeof account)[];
let attempt: Record<string, unknown>;
let command: (call: Invocation) => unknown;
let popup: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };
const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=1';
const invocations = (name: string) =>
  request.mock.calls.map(([, data]) => data as Invocation).filter((data) => data.name === name);
function submitClient() {
  fireEvent.input(screen.getByLabelText('Desktop client ID'), {
    target: { value: 'synthetic-client' },
  });
  fireEvent.input(screen.getByLabelText('Client secret (optional)'), {
    target: { value: 'synthetic-secret' },
  });
  fireEvent.submit(screen.getByLabelText('Desktop client ID').closest('form')!);
}
function pending() {
  attempt = { state: 'pending' };
  return { ...attempt, authorizeUrl: consentUrl };
}

beforeEach(() => {
  locale.value = 'en';
  accounts = [];
  attempt = { state: 'missing' };
  command = () => pending();
  popup = { opener: {}, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  request.mockReset().mockImplementation(async (_method, data: Invocation) => {
    const { name } = data;
    if (name === 'connections.list') return { connections: accounts };
    if (name === 'connections.google.login') return attempt;
    if (name === 'connections.google.connect' || name === 'connections.google.disconnect')
      return command(data);
    throw new Error(`Unexpected operation ${name}`);
  });
  navSectionSignal.value = 'settings';
  settingsSectionSignal.value = 'connections' as SettingsSection;
  currentSessionIdSignal.value = null;
  currentSpaceIdSignal.value = null;
  currentSpaceCanonicalIdSignal.value = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('offers Connect Google from the Connections settings route on an empty instance', async () => {
  render(<MainContent />);
  expect(await screen.findByRole('button', { name: 'Connect Google' })).toBeTruthy();
  expect(screen.getByText('No accounts connected.')).toBeTruthy();
});

it('shows account health and granted access with reconnect and disconnect actions', async () => {
  accounts = [account];
  render(<MainContent />);
  expect(await screen.findByText('one@example.test')).toBeTruthy();
  expect(screen.getByText('Reconnect needed')).toBeTruthy();
  expect(screen.getByText('Read Gmail')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
});

it('submits client details only to the daemon and opens consent without storing the secret in the page', async () => {
  const first = render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  submitClient();
  await waitFor(() => expect(popup.location.href).toBe(consentUrl));
  expect(popup.opener).toBeNull();
  expect(invocations('connections.google.connect')[0].input).toEqual({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
  });
  expect(screen.queryByDisplayValue('synthetic-secret')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Finish signing in on Google.');
  accounts = [{ ...account, health: 'healthy' }];
  attempt = { state: 'complete' };
  await screen.findByText('Connected', {}, { timeout: 2500 });
  first.unmount();
  render(<MainContent />);
  expect(await screen.findByText('one@example.test')).toBeTruthy();
  expect(screen.getByText('Connected')).toBeTruthy();
});

it('reconnects by account id using stored client configuration', async () => {
  accounts = [account];
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(popup.location.href).toBe(consentUrl));
  expect(invocations('connections.google.connect')[0].input).toEqual({ connectionId: account.id });
  expect(screen.queryByLabelText('Desktop client ID')).toBeNull();
});

it('keeps the account and closes the blank popup when the daemon rejects a different identity', async () => {
  accounts = [account];
  command = () => {
    attempt = { state: 'failed', reason: 'account_mismatch' };
    return attempt;
  };
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  expect((await screen.findByRole('alert')).textContent).toContain('account_mismatch');
  expect(screen.getByText('one@example.test')).toBeTruthy();
  expect(popup.close).toHaveBeenCalledTimes(1);
});

it('asks for client configuration after disconnect erased it, preserving the reconnect account', async () => {
  accounts = [{ ...account, health: 'disconnected' }];
  command = () => ({ state: 'failed', reason: 'client_not_configured' });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  await screen.findByLabelText('Desktop client ID');
  command = () => pending();
  submitClient();
  await waitFor(() => expect(invocations('connections.google.connect')).toHaveLength(2));
  expect(invocations('connections.google.connect')[1].input).toEqual({
    connectionId: account.id,
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
  });
});

it.each([true, false])(
  'disconnects only the selected account and retains the disabled record (erase succeeds: %s)',
  async (ok) => {
    accounts = [account, { ...account, id: 'other', email: 'two@example.test', health: 'healthy' }];
    command = ({ input }) => {
      accounts = accounts.map((row) =>
        row.id === input?.connectionId ? { ...row, health: 'disconnected' } : row
      );
      return ok ? { ok } : { ok, reason: 'credential_delete_failed' };
    };
    render(<MainContent />);
    await screen.findByText('one@example.test');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]);
    expect(await screen.findByText('Disconnected')).toBeTruthy();
    expect(screen.getByText('two@example.test')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(invocations('connections.google.disconnect')[0].input).toEqual({
      connectionId: account.id,
    });
    if (!ok)
      expect((await screen.findByRole('alert')).textContent).toContain('credential_delete_failed');
  }
);

it('offers a consent link when the browser blocks the popup', async () => {
  vi.mocked(window.open).mockReturnValue(null);
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  submitClient();
  const link = await screen.findByRole('link', { name: 'Continue to Google' });
  expect(link.getAttribute('href')).toBe(consentUrl);
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('shows read failures and allows retrying an explicit connection', async () => {
  request.mockRejectedValue(new Error('synthetic connection unavailable'));
  render(<MainContent />);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'synthetic connection unavailable'
  );
  expect(screen.getByRole('button', { name: 'Connect Google' }).hasAttribute('disabled')).toBe(
    false
  );
});

it('translates connection controls, health and access', async () => {
  locale.value = 'zh-Hans';
  accounts = [account];
  render(<MainContent />);
  expect(await screen.findByRole('button', { name: '连接 Google' })).toBeTruthy();
  await screen.findByText('one@example.test');
  expect(screen.getByText('需要重新连接')).toBeTruthy();
  expect(screen.getByText('读取 Gmail')).toBeTruthy();
});
