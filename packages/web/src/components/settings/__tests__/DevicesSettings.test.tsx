import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockRequest, connected } = vi.hoisted(() => {
  let open: () => void = () => {};
  const state = {
    ready: Promise.resolve(),
    connectLater: () => {
      state.ready = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => open();
    },
  };
  return { mockRequest: vi.fn(), connected: state };
});

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: async () => {
      await connected.ready;
      return { request: mockRequest };
    },
  },
}));

const { mockUpdate } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
}));

vi.mock('../../../lib/state.ts', async () => {
  const { signal } = await import('@preact/signals');
  return { globalSettings: signal<{ allowedHosts?: string[] } | null>(null) };
});
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: mockUpdate }));

import { globalSettings } from '../../../lib/state.ts';
import { DevicesSettings } from '../DevicesSettings.tsx';

type Invocation = { name: string; input: Record<string, unknown> };

const phone = {
  id: 'phone-1',
  name: 'Phone',
  kind: 'human',
  createdAt: 1,
  lastSeenAt: Date.now() - 120_000,
  lastSeenHost: 'mac.tailnet.ts.net' as string | null,
  revokedAt: null as number | null,
  current: false,
};
const relay = {
  ...phone,
  id: 'relay-1',
  name: 'Relay on iMac',
  kind: 'relay',
  lastSeenHost: null as string | null,
};

function invoked(name: string): Invocation[] {
  return mockRequest.mock.calls
    .map(([, params]) => params as Invocation | undefined)
    .filter((call): call is Invocation => call?.name === name);
}

function daemon(state: { paired: boolean; pending?: unknown[] }) {
  const devices = [
    phone,
    relay,
    { ...phone, id: 'desk-1', name: 'Desk browser', lastSeenHost: '127.0.0.1:9283', current: true },
  ];
  let pending = state.pending ?? [];
  mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
    if (!params) throw new Error(`unexpected call ${method}`);
    const { name, input } = params;
    if (!state.paired && name !== 'device.pair.pending')
      return {
        ok: false,
        reason: 'not_paired: only a paired human device or the local CLI can manage devices.',
      };
    if (name === 'device.list') return { ok: true, devices };
    if (name === 'device.pair.pending') return { ok: true, pending };
    if (name === 'device.unpaired.list')
      return {
        ok: true,
        connections: [
          {
            client: 'browser',
            origin: 'https://evil.example',
            host: 'mac:9283',
            remoteAddress: '10.0.0.3',
            credentialRejected: true,
            count: 4,
            firstSeenAt: 1,
            lastSeenAt: Date.now(),
          },
        ],
      };
    if (name === 'device.would_refuse.list')
      return {
        ok: true,
        requests: [
          {
            reason: 'host_not_allowed',
            kind: 'ws',
            host: 'nas.lan:9283',
            origin: null,
            count: 7,
            firstSeenAt: 1,
            lastSeenAt: Date.now(),
          },
        ],
      };
    if (name === 'device.pair.approve' && input.codeId === 'expired')
      return { ok: false, reason: 'not_pending: no pending code with that id.' };
    if (name === 'device.pair.approve') {
      pending = [];
      return { ok: true };
    }
    if (name === 'device.revoke') {
      const index = devices.findIndex((device) => device.id === input.deviceId);
      devices[index] = { ...devices[index], revokedAt: Date.now() };
      return { ok: true };
    }
    if (name === 'device.pair.create')
      return {
        ok: true,
        codeId: 'code-9',
        code: 'NEWCODE234',
        expiresAt: Date.now() + 600_000,
        approval: 'approved',
      };
    throw new Error(`unexpected ${name}`);
  });
}

describe('DevicesSettings', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockUpdate.mockReset();
    mockUpdate.mockImplementation(async (updates: { allowedHosts: string[] }) => {
      (globalSettings as { value: unknown }).value = updates;
      return { success: true, settings: updates };
    });
    (globalSettings as { value: unknown }).value = { allowedHosts: ['lan.local'] };
  });
  afterEach(() => cleanup());

  it('asks an unpaired browser to pair before it can manage devices', async () => {
    daemon({ paired: false });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Pair this browser to manage devices.'));
    expect(screen.getByRole('link', { name: 'Pair this browser' }).getAttribute('href')).toBe(
      '/pair'
    );
  });

  it('loads once the connection to the daemon comes up after the tab opened', async () => {
    const open = connected.connectLater();
    daemon({ paired: true });
    render(<DevicesSettings />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await waitFor(() => screen.getByText('Relay on iMac'));
  });

  it('lists devices, unpaired connections and codes waiting for Allow, and allows one', async () => {
    daemon({
      paired: true,
      pending: [{ id: 'code-1', kind: 'human', name: 'Laptop', expiresAt: Date.now() + 300_000 }],
    });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Relay on iMac'));
    expect(screen.getByText('mac.tailnet.ts.net')).toBeTruthy();
    expect(screen.getByText('https://evil.example')).toBeTruthy();
    expect(screen.getByText('Unknown credential · 4 times')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Laptop' }));
    await waitFor(() => screen.getByText('No codes are waiting for Allow.'));
    expect(invoked('device.pair.approve')).toEqual([
      { name: 'device.pair.approve', input: { codeId: 'code-1' } },
    ]);
  });

  it('shows requests the Origin/Host checks would refuse, and edits the allowed hosts', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Host not allowed · WebSocket · 7 times'));
    expect(screen.getByText('lan.local')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Allowed host'), {
      target: { value: ' Mac.Tailnet.ts.net ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ allowedHosts: ['lan.local', 'mac.tailnet.ts.net'] })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove lan.local' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenLastCalledWith({ allowedHosts: ['mac.tailnet.ts.net'] })
    );
  });

  it('keeps a host another browser added when this one adds or removes one', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await screen.findByText('lan.local');
    (globalSettings as { value: unknown }).value = { allowedHosts: ['lan.local', 'other.lan'] };
    await screen.findByText('other.lan');
    fireEvent.input(screen.getByLabelText('Allowed host'), { target: { value: 'mac.ts.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        allowedHosts: ['lan.local', 'other.lan', 'mac.ts.net'],
      })
    );
  });

  it('marks this browser and offers no way to revoke or re-pair it from itself', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Desk browser'));
    expect(screen.getByText('This browser')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke Desk browser' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-pair Desk browser' })).toBeNull();
  });

  it('does not offer Allow for an expired code', async () => {
    daemon({
      paired: true,
      pending: [{ id: 'expired', kind: 'human', name: 'Old laptop', expiresAt: Date.now() }],
    });
    render(<DevicesSettings />);
    await screen.findByText('Old laptop');
    expect(screen.getByRole('button', { name: 'Allow Old laptop' })).toHaveProperty(
      'disabled',
      true
    );
    expect(invoked('device.pair.approve')).toEqual([]);
  });

  it('revokes a device after a second click', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Relay on iMac'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Relay on iMac' }));
    expect(invoked('device.revoke')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke Relay on iMac' }));
    await waitFor(() => screen.getByText('Revoked'));
    expect(invoked('device.revoke')).toEqual([
      { name: 'device.revoke', input: { deviceId: 'relay-1' } },
    ]);
  });

  it('requires explicit removal instead of revoking a device through a Re-pair shortcut', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await screen.findByText('Phone');
    expect(screen.queryByRole('button', { name: 'Re-pair Phone' })).toBeNull();
    expect(invoked('device.revoke')).toEqual([]);
    expect(screen.getByText(/Pairing is report-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }));
    await waitFor(() => expect(invoked('device.list')).toHaveLength(2));
  });

  it('adds a device of the chosen kind', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Phone'));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'relay' } });
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'iMac relay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make pairing code' }));
    await waitFor(() => screen.getByText('NEWCODE234'));
    expect(invoked('device.pair.create')).toEqual([
      { name: 'device.pair.create', input: { kind: 'relay', name: 'iMac relay' } },
    ]);
  });
});
