import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/state.ts', () => ({
  globalSettings: signal(null),
  connectionState: signal('connected'),
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request }) },
}));
import { NeoRelaySendersSettings } from '../NeoRelaySendersSettings.tsx';
import { connectionState, globalSettings } from '../../../lib/state.ts';
const saved = { sender: 'claude-code:synthetic-session', name: 'Saved relay' };
const recent = {
  sender: 'codex-desktop:synthetic-thread',
  name: 'Recent relay',
  lastMessageAt: '2026-11-10T00:00:00Z',
};
beforeEach(() => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { relaySenders: [saved] },
  } as GlobalSettings;
  connectionState.value = 'connected';
  request
    .mockReset()
    .mockImplementation(async (_method, { name }) =>
      name === 'neo.relaySenders.recent'
        ? { senders: [{ ...saved, lastMessageAt: recent.lastMessageAt }, recent] }
        : { ok: true }
    );
});
afterEach(cleanup);
function section() {
  render(<NeoRelaySendersSettings />);
  return within(screen.getByRole('region', { name: 'Who may relay my words' }));
}

test('shows stored names and sender refs and offers only unconfigured recent senders', async () => {
  const ui = section();
  expect(ui.getByText(saved.name)).toBeTruthy();
  expect(ui.getByText(saved.sender)).toBeTruthy();
  expect(await ui.findByRole('option', { name: `${recent.name} · ${recent.sender}` })).toBeTruthy();
  expect(ui.queryByRole('option', { name: `${saved.name} · ${saved.sender}` })).toBeNull();
  expect(ui.queryByRole('textbox')).toBeNull();
  expect(
    request.mock.calls.filter(([, data]) => data.name === 'neo.relaySenders.set')
  ).toHaveLength(0);
});
test('adds the selected exact sender and name without sending the message timestamp', async () => {
  const ui = section();
  await ui.findByRole('option', { name: `${recent.name} · ${recent.sender}` });
  fireEvent.change(ui.getByRole('combobox', { name: 'Recent sender' }), {
    target: { value: recent.sender },
  });
  fireEvent.click(ui.getByRole('button', { name: 'Add sender', exact: true }));
  await waitFor(() => expect(ui.getAllByRole('listitem')).toHaveLength(2));
  expect(request).toHaveBeenCalledWith('operation.invoke', {
    name: 'neo.relaySenders.set',
    input: { relaySenders: [saved, { sender: recent.sender, name: recent.name }] },
  });
  expect(ui.queryByRole('option', { name: `${recent.name} · ${recent.sender}` })).toBeNull();
});
test('removes only the chosen saved sender', async () => {
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: `Remove ${saved.name}` }));
  await waitFor(() => expect(ui.queryByText(saved.sender)).toBeNull());
  expect(request).toHaveBeenCalledWith('operation.invoke', {
    name: 'neo.relaySenders.set',
    input: { relaySenders: [] },
  });
});
test('a rejected save retains the saved list and shows the refusal', async () => {
  request.mockImplementation(async (_method, { name }) =>
    name === 'neo.relaySenders.recent'
      ? { senders: [recent] }
      : { ok: false, reason: 'Local user required.' }
  );
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: `Remove ${saved.name}` }));
  expect((await ui.findByRole('alert')).textContent).toContain('Local user required.');
  expect(ui.getByText(saved.sender)).toBeTruthy();
});
test('empty history and disconnected settings do not offer an add action', async () => {
  request.mockResolvedValue({ senders: [] });
  const ui = section();
  await ui.findByText('No recent senders available.');
  expect((ui.getByRole('button', { name: 'Add sender' }) as HTMLButtonElement).disabled).toBe(true);
  connectionState.value = 'disconnected';
  await waitFor(() =>
    expect(
      (ui.getByRole('button', { name: `Remove ${saved.name}` }) as HTMLButtonElement).disabled
    ).toBe(true)
  );
});

test('reconnecting reloads candidates and clears a failed read', async () => {
  request.mockRejectedValueOnce(new Error('Recent sender read failed.'));
  const ui = section();
  expect((await ui.findByRole('alert')).textContent).toContain('Recent sender read failed.');
  connectionState.value = 'disconnected';
  await waitFor(() => expect((ui.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true));
  connectionState.value = 'connected';
  await ui.findByRole('option', { name: `${recent.name} · ${recent.sender}` });
  expect(ui.queryByRole('alert')).toBeNull();
});
