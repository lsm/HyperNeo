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
vi.mock('../../voice/VoiceRecordingIndicator.tsx', () => ({ VoiceRecordingIndicator: () => null }));
vi.mock('../../ui/MobileMenuButton.tsx', () => ({ MobileMenuButton: () => null }));

import MainContent from '../../../islands/MainContent.tsx';
import { locale } from '../../../lib/i18n/index.ts';
import {
  currentSessionIdSignal,
  navSectionSignal,
  settingsSectionSignal,
  type SettingsSection,
} from '../../../lib/signals.ts';
import { currentSpaceIdSignal, currentSpaceCanonicalIdSignal } from '../../../lib/space-signals.ts';

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
    if (data.input === undefined) throw new Error('Invalid input: expected object');
    if (name === 'connections.list') return { connections: accounts };
    if (name === 'connections.google.login' || name === 'connections.microsoft.login')
      return attempt;
    if (/^connections\.(google|microsoft)\.(connect|disconnect)$/.test(name)) return command(data);
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

it('connects Microsoft with only an application client ID and polls its own sign-in', async () => {
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Microsoft' }));
  const clientId = await screen.findByLabelText('Application (client) ID');
  expect(screen.queryByLabelText('Client secret (optional)')).toBeNull();
  fireEvent.input(clientId, { target: { value: 'synthetic-microsoft-client' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Microsoft' }));
  await waitFor(() => expect(popup.location.href).toBe(consentUrl));
  expect(invocations('connections.microsoft.connect')[0].input).toEqual({
    clientId: 'synthetic-microsoft-client',
  });
  expect(invocations('connections.google.connect')).toHaveLength(0);
  expect(screen.getByRole('status').textContent).toContain('Finish signing in on Microsoft.');
  await waitFor(() => expect(invocations('connections.microsoft.login').length).toBeGreaterThan(0));
});

it('shows a pending Microsoft sign-in after the settings page reloads', async () => {
  request.mockImplementation(async (_method, data: Invocation) => {
    if (data.name === 'connections.list') return { connections: [] };
    if (data.name === 'connections.microsoft.login') return { state: 'pending' };
    if (data.name === 'connections.google.login') return { state: 'missing' };
    throw new Error(`Unexpected operation ${data.name}`);
  });
  render(<MainContent />);
  expect((await screen.findByRole('status')).textContent).toContain(
    'Finish signing in on Microsoft.'
  );
  await waitFor(
    () => expect(invocations('connections.microsoft.login').length).toBeGreaterThanOrEqual(3),
    {
      timeout: 1800,
    }
  );
});

it('shows a Microsoft failure after reload even if Google previously completed', async () => {
  request.mockImplementation(async (_method, data: Invocation) => {
    if (data.name === 'connections.list') return { connections: [] };
    if (data.name === 'connections.microsoft.login')
      return { state: 'failed', reason: 'account_mismatch' };
    if (data.name === 'connections.google.login') return { state: 'complete' };
    throw new Error(`Unexpected operation ${data.name}`);
  });
  render(<MainContent />);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Sign in with the same Microsoft account to reconnect.'
  );
});

it('starts Microsoft with an empty client ID after switching from Google', async () => {
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  fireEvent.input(screen.getByLabelText('Desktop client ID'), {
    target: { value: 'synthetic-google-client' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Microsoft' }));
  expect((screen.getByLabelText('Application (client) ID') as HTMLInputElement).value).toBe('');
});

it('drops a Google client secret typed before switching to Connect Microsoft', async () => {
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  fireEvent.input(screen.getByLabelText('Client secret (optional)'), {
    target: { value: 'synthetic-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Microsoft' }));
  fireEvent.input(screen.getByLabelText('Application (client) ID'), {
    target: { value: 'synthetic-microsoft-client' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Microsoft' }));
  await waitFor(() => expect(invocations('connections.microsoft.connect')).toHaveLength(1));
  expect(invocations('connections.microsoft.connect')[0].input).toEqual({
    clientId: 'synthetic-microsoft-client',
  });
});

it('opens an empty Microsoft reconnect form after entering Google credentials', async () => {
  accounts = [{ ...account, provider: 'microsoft' }];
  command = () => ({ state: 'failed', reason: 'client_not_configured' });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  fireEvent.input(screen.getByLabelText('Desktop client ID'), {
    target: { value: 'synthetic-google-client' },
  });
  fireEvent.input(screen.getByLabelText('Client secret (optional)'), {
    target: { value: 'synthetic-secret' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Application (client) ID') as HTMLInputElement).value).toBe('')
  );
});

it('keeps Google pending and its consent link while opening Microsoft setup', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  request.mockImplementation(async (_method, data: Invocation) => {
    if (data.name === 'connections.list') return { connections: [] };
    if (data.name === 'connections.google.login') return attempt;
    if (data.name === 'connections.microsoft.login') return { state: 'missing' };
    if (data.name === 'connections.google.connect') return pending();
    throw new Error(`Unexpected operation ${data.name}`);
  });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  submitClient();
  expect((await screen.findByRole('status')).textContent).toContain('Finish signing in on Google.');
  expect(screen.getByRole('link', { name: 'Continue to Google' })).toBeTruthy();
  const connect = screen.getByRole('button', { name: 'Connect Microsoft' });
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.click(connect);
  await screen.findByLabelText('Application (client) ID');
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Finish signing in on Google.')
  );
  expect(screen.getByRole('link', { name: 'Continue to Google' })).toBeTruthy();
  const previousPolls = invocations('connections.google.login').length;
  attempt = { state: 'failed', reason: 'account_mismatch' };
  expect((await screen.findByRole('alert', {}, { timeout: 2500 })).textContent).toContain(
    'Sign in with the same Google account to reconnect.'
  );
  await waitFor(() =>
    expect(invocations('connections.google.login').length).toBeGreaterThanOrEqual(previousPolls + 2)
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Sign in with the same Google account to reconnect.'
  );
});

it('clears Google credentials when Microsoft reconnect fails with a mismatched account', async () => {
  accounts = [{ ...account, provider: 'microsoft' }];
  command = () => ({ state: 'failed', reason: 'account_mismatch' });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  fireEvent.input(screen.getByLabelText('Desktop client ID'), {
    target: { value: 'synthetic-google-client' },
  });
  fireEvent.input(screen.getByLabelText('Client secret (optional)'), {
    target: { value: 'synthetic-secret' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  expect((await screen.findByRole('alert')).textContent).toContain('same Microsoft account');
  expect((screen.getByLabelText('Application (client) ID') as HTMLInputElement).value).toBe('');
});

it('shows Microsoft consent when starting it during a pending Google sign-in', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  let googlePending = false;
  let microsoftPending = false;
  request.mockImplementation(async (_method, data: Invocation) => {
    if (data.name === 'connections.list') return { connections: [] };
    if (data.name === 'connections.google.login')
      return { state: googlePending ? 'pending' : 'missing' };
    if (data.name === 'connections.microsoft.login')
      return { state: microsoftPending ? 'pending' : 'missing' };
    if (data.name === 'connections.google.connect') {
      googlePending = true;
      return { state: 'pending', authorizeUrl: consentUrl };
    }
    if (data.name === 'connections.microsoft.connect') {
      microsoftPending = true;
      return { state: 'pending', authorizeUrl: 'https://example.test/microsoft' };
    }
    throw new Error(`Unexpected operation ${data.name}`);
  });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  submitClient();
  await screen.findByRole('link', { name: 'Continue to Google' });
  const connect = screen.getByRole('button', { name: 'Connect Microsoft' });
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.click(connect);
  fireEvent.input(screen.getByLabelText('Application (client) ID'), {
    target: { value: 'synthetic-microsoft-client' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Microsoft' }));
  const link = await screen.findByRole('link', { name: 'Continue to Microsoft' });
  expect(link.getAttribute('href')).toBe('https://example.test/microsoft');
  expect(screen.getByRole('status').textContent).toContain('Finish signing in on Microsoft.');
});

it('keeps a Google secret out of a Microsoft reconnect that reuses the open form', async () => {
  accounts = [{ ...account, provider: 'microsoft' }];
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  fireEvent.input(screen.getByLabelText('Client secret (optional)'), {
    target: { value: 'synthetic-secret' },
  });
  command = () => ({ state: 'failed', reason: 'client_not_configured' });
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  const clientId = await screen.findByLabelText('Application (client) ID');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue to Microsoft' }).hasAttribute('disabled')
    ).toBe(false)
  );
  command = () => pending();
  fireEvent.input(clientId, { target: { value: 'synthetic-microsoft-client' } });
  const submit = screen.getByRole('button', { name: 'Continue to Microsoft' });
  await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(invocations('connections.microsoft.connect')).toHaveLength(2));
  expect(invocations('connections.microsoft.connect')[1].input).toEqual({
    connectionId: account.id,
    clientId: 'synthetic-microsoft-client',
  });
});

it('clears a Google failure when the person switches to Connect Microsoft', async () => {
  accounts = [account];
  command = () => ({ state: 'failed', reason: 'account_mismatch' });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Google connection failed');
  const connect = screen.getByRole('button', { name: 'Connect Microsoft' });
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.click(connect);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('reconnects and disconnects a Microsoft account through Microsoft operations', async () => {
  accounts = [
    {
      ...account,
      provider: 'microsoft',
      scopes: ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite', 'Calendars.Read'],
      health: 'healthy',
    },
  ];
  command = () => {
    attempt = { state: 'failed', reason: 'account_mismatch' };
    return attempt;
  };
  render(<MainContent />);
  expect(await screen.findByText('Read Outlook mail and manage drafts')).toBeTruthy();
  expect(screen.getByText('Read Outlook calendars')).toBeTruthy();
  expect(screen.getByText('Basic profile')).toBeTruthy();
  expect(screen.getByText('Stay connected')).toBeTruthy();
  expect(screen.queryByText('offline_access')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Sign in with the same Microsoft account to reconnect.'
  );
  expect(invocations('connections.microsoft.connect')[0].input).toEqual({
    connectionId: account.id,
  });
  command = () => ({ ok: true });
  const disconnect = screen.getByRole('button', { name: 'Disconnect' });
  await waitFor(() => expect(disconnect.hasAttribute('disabled')).toBe(false));
  fireEvent.click(disconnect);
  await waitFor(() =>
    expect(invocations('connections.microsoft.disconnect')[0]?.input).toEqual({
      connectionId: account.id,
    })
  );
  expect(invocations('connections.google.connect')).toHaveLength(0);
  expect(invocations('connections.google.disconnect')).toHaveLength(0);
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
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Sign in with the same Google account to reconnect.'
  );
  expect(screen.getByText('one@example.test')).toBeTruthy();
  await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
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

function capturePoll() {
  const polls: Array<() => void> = [];
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 15000 || delay === 1000)
      polls.push(() => {
        if (typeof callback === 'function') callback(...args);
      });
    return interval(callback, delay, ...args);
  });
  return () => polls.at(-1)!();
}

it('clears a temporary read error when polling recovers without another action', async () => {
  const poll = capturePoll();
  accounts = [account];
  request.mockRejectedValueOnce(new Error('synthetic transient read outage'));
  render(<MainContent />);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'synthetic transient read outage'
  );
  poll();
  await screen.findByText('one@example.test');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('preserves a failed action notice while successful polling adds fresh account data', async () => {
  const poll = capturePoll();
  accounts = [account];
  command = () => ({ ok: false, reason: 'credential_delete_failed' });
  render(<MainContent />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  await screen.findByRole('alert');
  accounts = [account, { ...account, id: 'other', email: 'two@example.test' }];
  poll();
  await screen.findByText('two@example.test');
  expect(screen.getByRole('alert').textContent).toContain('credential_delete_failed');
});
