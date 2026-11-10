import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { navigateToSettings, updateGlobalSettings } = vi.hoisted(() => ({
  navigateToSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal(null) }));
vi.mock('../../../lib/router.ts', () => ({ navigateToSettings }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../ModelsSettings.tsx', () => ({ ModelsSettings: () => <h2>Coordinator</h2> }));
vi.mock('../NeoRulesSettings.tsx', () => ({ NeoRulesSettings: () => <h2>Standing rules</h2> }));
vi.mock('../NeoMutedSessionsSettings.tsx', () => ({
  NeoMutedSessionsSettings: () => <h2>Muted sessions</h2>,
}));

import { globalSettings } from '../../../lib/state.ts';
vi.mock('../NeoRelaySendersSettings.tsx', () => ({
  NeoRelaySendersSettings: () => <h2>Who may relay my words</h2>,
}));
import { NeoModelSettings } from '../NeoModelSettings.tsx';

const settle = (settings: unknown) => {
  (globalSettings as { value: GlobalSettings | null }).value = settings as GlobalSettings;
};

afterEach(() => {
  cleanup();
  navigateToSettings.mockClear();
});

test('orders coordinator, rules, relay senders, muted sessions and related settings', () => {
  settle({});
  render(<NeoModelSettings />);
  const titles = [
    'Coordinator',
    'Standing rules',
    'Who may relay my words',
    'Muted sessions',
    'Related settings',
  ].map((name) => screen.getByText(name));
  titles
    .slice(1)
    .forEach((title, index) =>
      expect(
        titles[index].compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    );
});

test('summarises worker settings without a second control', () => {
  settle({ neo: { workerPermissionMode: 'acceptEdits' }, workerSandbox: 'always' });
  render(<NeoModelSettings />);
  expect(
    screen.getByText('Claude worker permission: acceptEdits · Worker sandbox: always')
  ).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(updateGlobalSettings).not.toHaveBeenCalled();
});

test('marks an unset worker permission and an unset sandbox by their effective values', () => {
  settle({});
  render(<NeoModelSettings />);
  expect(
    screen.getByText('Claude worker permission: auto (not set) · Worker sandbox: off')
  ).toBeTruthy();
});

test('links to Sessions & Harness and to Coding pack settings', () => {
  settle({});
  render(<NeoModelSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Sessions & Harness →' }));
  expect(navigateToSettings).toHaveBeenLastCalledWith('harness');
  fireEvent.click(screen.getByRole('button', { name: 'Coding pack settings →' }));
  expect(navigateToSettings).toHaveBeenLastCalledWith('coding-pack');
});

test('shows no merge form on the Neo page', () => {
  settle({});
  render(<NeoModelSettings />);
  expect(screen.getByText('Merge rules, review bot and human sign-off')).toBeTruthy();
  expect(document.querySelectorAll('input, select, textarea')).toHaveLength(0);
});
