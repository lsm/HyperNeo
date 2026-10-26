import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings, Session } from '@hyperneo/shared';

const { request, hub } = vi.hoisted(() => {
  const request = vi.fn();
  return { request, hub: { current: { request } as { request: typeof request } | null } };
});
vi.mock('../../../lib/state.ts', () => ({
  globalSettings: signal(null),
  connectionState: signal('connected'),
  sessions: signal([]),
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => hub.current },
}));
import { NeoMutedSessionsSettings } from '../NeoMutedSessionsSettings.tsx';
import { globalSettings, sessions } from '../../../lib/state.ts';

const known = 'hyperneo::s-1';
const unknown = 'hyperneo::gone';
const codex = 'codex-desktop:mac-mini:thread-9';

function settle(mutedSessions: string[]) {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { mutedSessions },
  } as GlobalSettings;
}

beforeEach(() => {
  hub.current = { request };
  settle([known, unknown, codex]);
  (sessions as unknown as { value: Session[] }).value = [
    { id: 's-1', title: 'Fix login' } as Session,
  ];
  request.mockReset().mockImplementation(async (_method, { input }) => ({
    ok: true,
    mutedSessions: [known, unknown, codex].filter((key) => key !== input.key),
  }));
});
afterEach(cleanup);

function section() {
  render(<NeoMutedSessionsSettings />);
  return within(screen.getByRole('region', { name: 'Neo muted sessions' }));
}

test('lists every muted key, naming only the sessions existing data resolves', () => {
  const rows = section().getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain('Fix login');
  expect(rows[0].textContent).toContain(known);
  expect(rows[1].textContent).toContain(unknown);
  expect(rows[2].textContent).toContain(codex);
  expect(rows[2].textContent).not.toContain('Fix login');
});

test('unmuting sends the original key and removes only that row once it succeeds', async () => {
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: `Unmute ${codex}` }));
  await waitFor(() => expect(ui.getAllByRole('listitem')).toHaveLength(2));
  expect(request).toHaveBeenCalledWith('operation.invoke', {
    name: 'neo.session.mute',
    input: { key: codex, muted: false },
  });
  expect(ui.queryByText(codex)).toBeNull();
  expect(ui.getByText(unknown)).toBeTruthy();
});

test('a refused unmute keeps the row and shows the reason', async () => {
  request.mockResolvedValueOnce({ ok: false, reason: 'Only the local human can unmute.' });
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: 'Unmute Fix login' }));
  expect(await ui.findByText('Only the local human can unmute.')).toBeTruthy();
  expect(ui.getAllByRole('listitem')).toHaveLength(3);
});

test('a failed request keeps the row and shows the error', async () => {
  request.mockRejectedValueOnce(new Error('Request timed out'));
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: `Unmute ${unknown}` }));
  expect(await ui.findByText('Request timed out')).toBeTruthy();
  expect(ui.getAllByRole('listitem')).toHaveLength(3);
});

test('while disconnected an unmute sends nothing and keeps the row', async () => {
  hub.current = null;
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: `Unmute ${codex}` }));
  expect(await ui.findByText('Reconnect before unmuting a session.')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  expect(ui.getAllByRole('listitem')).toHaveLength(3);
});

test('says when nothing is muted', () => {
  settle([]);
  expect(section().getByText('No muted sessions.')).toBeTruthy();
});
