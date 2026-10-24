import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoDrawer } from '../NeoDrawer.tsx';

const { invoke, hub } = vi.hoisted(() => ({ invoke: vi.fn(), hub: {} }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => hub,
  },
}));
vi.mock('../../lib/operations.ts', () => ({ invokeOperation: invoke }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const drawer = (connection: 'connected' | 'disconnected' = 'connected') =>
  render(
    <NeoDrawer
      open
      onClose={() => {}}
      connection={connection}
      onReconnect={() => {}}
      onRefresh={() => {}}
    />
  );

describe('NeoDrawer', () => {
  it('lists pending devices after Connection and approves through the existing operation', async () => {
    const pending = { id: 'pending', kind: 'relay', name: 'Synthetic relay', expiresAt: 4e12 };
    invoke
      .mockResolvedValueOnce({ ok: true, pending: [pending] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, pending: [] });
    drawer();
    const allow = await screen.findByRole('button', { name: 'Allow Synthetic relay' });
    expect(
      [...document.querySelectorAll('section')].map((section) => section.getAttribute('aria-label'))
    ).toEqual(['Connection', 'Pending devices']);
    fireEvent.click(allow);
    await waitFor(() => expect(screen.queryByText('Synthetic relay')).toBeNull());
    expect(invoke).toHaveBeenCalledWith(hub, 'device.pair.approve', { codeId: 'pending' });
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a refusal without pretending the device was allowed', async () => {
    invoke
      .mockResolvedValueOnce({
        ok: true,
        pending: [{ id: 'pending', kind: 'daemon', name: 'Test daemon', expiresAt: 4e12 }],
      })
      .mockResolvedValueOnce({ ok: false, reason: 'not_pending: code expired' });
    drawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Test daemon' }));
    expect((await screen.findByRole('alert')).textContent).toContain('code expired');
    expect(screen.getByText('Test daemon')).toBeTruthy();
  });

  it('keeps disconnected drawers usable without fetching protected data', () => {
    drawer('disconnected');
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('explains pairing refusal and keeps platform-only controls out of web', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'not_paired: denied' });
    drawer();
    expect((await screen.findByRole('alert')).textContent).toContain('Settings → Devices');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Demo data (offline)')).toBeNull();
  });
});
