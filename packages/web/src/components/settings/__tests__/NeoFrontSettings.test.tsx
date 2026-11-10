import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const { save, connection } = vi.hoisted(() => ({
  save: vi.fn(),
  connection: { hub: 'hub' as string | null },
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal({ neo: {} }) }));
vi.mock('../../../lib/operations.ts', () => ({ invokeOperation: save }));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => connection.hub },
}));
import { NeoFrontSettings } from '../NeoFrontSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';
beforeEach(() => {
  (globalSettings as { value: unknown }).value = {
    neo: { packs: ['stale-pack'], workerPermissionMode: 'default' },
  };
  connection.hub = 'hub';
  save.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);
test('one default-off switch covers text and voice', async () => {
  render(<NeoFrontSettings />);
  const toggle = screen.getByRole('checkbox', {
    name: 'Fast replies for text and voice',
  }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  toggle.checked = !toggle.checked;
  fireEvent.change(toggle);
  await waitFor(() => expect(save).toHaveBeenCalledWith('hub', 'neo.front.set', { enabled: true }));
});

test.each([false, true])('failed saves restore the saved switch value %s', async (enabled) => {
  (globalSettings as { value: unknown }).value = { neo: { front: { enabled } } };
  save.mockRejectedValueOnce(new Error('Transport unavailable'));
  render(<NeoFrontSettings />);
  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  toggle.checked = !toggle.checked;
  fireEvent.change(toggle);
  await screen.findByRole('alert');
  await waitFor(() => expect(toggle.checked).toBe(enabled));
  expect(toggle.disabled).toBe(false);
});
test.each([false, true])('daemon refusals restore the saved switch value %s', async (enabled) => {
  (globalSettings as { value: unknown }).value = { neo: { front: { enabled } } };
  save.mockResolvedValueOnce({ ok: false });
  render(<NeoFrontSettings />);
  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  toggle.checked = !toggle.checked;
  fireEvent.change(toggle);
  await screen.findByRole('alert');
  await waitFor(() => expect(toggle.checked).toBe(enabled));
});
test.each([false, true])(
  'a disconnected hub restores the saved switch value %s',
  async (enabled) => {
    (globalSettings as { value: unknown }).value = { neo: { front: { enabled } } };
    connection.hub = null;
    render(<NeoFrontSettings />);
    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    toggle.checked = !toggle.checked;
    fireEvent.change(toggle);
    await screen.findByRole('alert');
    expect(toggle.checked).toBe(enabled);
    expect(save).not.toHaveBeenCalled();
  }
);

test('the switch follows saved settings updates', async () => {
  render(<NeoFrontSettings />);
  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  (globalSettings as { value: unknown }).value = { neo: { front: { enabled: true } } };
  await waitFor(() => expect(toggle.checked).toBe(true));
});
