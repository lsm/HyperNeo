import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { request, updateGlobalSettings } = vi.hoisted(() => ({
  request: vi.fn(),
  updateGlobalSettings: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/state.ts', () => ({
  globalSettings: signal(null),
  connectionState: signal('connected'),
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request }) },
}));
vi.mock('../../../lib/api-helpers.ts', () => ({
  listProviderAuthStatus: async () => ({ providers: [] }),
  updateGlobalSettings,
}));
import { NeoModelSettings } from '../NeoModelSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';

const neo = {
  standingRules: ['Keep PRs small'],
  packs: ['coding'],
  mutedSessions: ['codex::quiet'],
  autoDispatch: true,
};

function settle(workerPermissionMode?: string) {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { ...neo, ...(workerPermissionMode ? { workerPermissionMode } : {}) },
  } as GlobalSettings;
}

function workerSelect() {
  return screen.getByRole('combobox', { name: 'Claude worker permission' }) as HTMLSelectElement;
}

beforeEach(() => {
  updateGlobalSettings.mockClear();
  request.mockReset().mockResolvedValue({ models: [] });
});
afterEach(cleanup);

test.each([
  [undefined, 'auto', 'auto (not set)'],
  ['bypassPermissions', 'bypassPermissions', 'bypassPermissions'],
  ['auto', 'auto', 'auto'],
  ['acceptEdits', 'acceptEdits', 'acceptEdits'],
  ['default', 'default', 'default'],
])(
  'a saved %s worker permission shows its effective real name and opening writes nothing',
  (saved, value, label) => {
    settle(saved);
    render(<NeoModelSettings />);
    const select = workerSelect();
    expect(select.value).toBe(value);
    expect(select.options[select.selectedIndex].textContent).toBe(label);
    expect([...select.options].map((option) => option.value)).toEqual([
      'bypassPermissions',
      'auto',
      'acceptEdits',
      'default',
    ]);
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  }
);

test('shows no worker permission until the settings have loaded', () => {
  (globalSettings as { value: GlobalSettings | null }).value = null;
  render(<NeoModelSettings />);
  expect(screen.queryByRole('combobox', { name: 'Claude worker permission' })).toBeNull();
  expect(updateGlobalSettings).not.toHaveBeenCalled();
});

test('says it applies only to Claude workers Neo starts from now on', () => {
  settle();
  render(<NeoModelSettings />);
  expect(
    screen.getByText(
      'Claude Code workers Neo starts from now on use this mode; running sessions keep theirs.'
    )
  ).toBeTruthy();
});

test('picking a mode saves it without dropping the rest of the Neo settings', () => {
  settle('auto');
  render(<NeoModelSettings />);
  fireEvent.change(workerSelect(), { target: { value: 'acceptEdits' } });
  expect(updateGlobalSettings).toHaveBeenCalledWith({
    neo: { ...neo, workerPermissionMode: 'acceptEdits' },
  });
});

test('settings shows allowed worker sockets and removes only the selected entry', () => {
  settle();
  (globalSettings as { value: GlobalSettings | null }).value = {
    ...globalSettings.value!,
    workerUnixSockets: ['/synthetic/agent.sock', '/synthetic/db.sock'],
  };
  render(<NeoModelSettings />);
  expect(screen.getByText('/synthetic/agent.sock')).toBeTruthy();
  expect(screen.getByText('/synthetic/db.sock')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
  expect(updateGlobalSettings).toHaveBeenCalledWith({ workerUnixSockets: ['/synthetic/db.sock'] });
});

test('empty socket settings grant no access', () => {
  settle();
  render(<NeoModelSettings />);
  expect(screen.getByText('No sockets allowed')).toBeTruthy();
  expect(updateGlobalSettings).not.toHaveBeenCalled();
});

test('the worker sandbox shows off when unset and saves the chosen mode', async () => {
  settle();
  render(<NeoModelSettings />);
  const select = screen.getByRole('combobox', { name: 'Worker sandbox' }) as HTMLSelectElement;
  expect(select.value).toBe('off');
  expect([...select.options].map((option) => option.value)).toEqual(['off', 'always']);
  fireEvent.change(select, { target: { value: 'always' } });
  expect(updateGlobalSettings).toHaveBeenCalledWith({ workerSandbox: 'always' });
});
