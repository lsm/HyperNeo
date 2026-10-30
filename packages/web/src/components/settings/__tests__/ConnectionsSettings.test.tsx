import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
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
let accounts: (typeof account)[];

beforeEach(() => {
  locale.value = 'en';
  accounts = [];
  request.mockReset().mockImplementation(async (_method, { name }) => {
    if (name === 'connections.list') return { connections: accounts };
    if (name === 'connections.google.login') return { state: 'missing' };
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
