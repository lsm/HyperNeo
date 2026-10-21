import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: mockRequest }) },
}));

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

  it('marks this browser and offers no way to revoke or re-pair it from itself', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Desk browser'));
    expect(screen.getByText('This browser')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke Desk browser' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-pair Desk browser' })).toBeNull();
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

  it('re-pairs a device with a new code for the same kind and name, revoking the old credential', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    await waitFor(() => screen.getByText('Phone'));
    fireEvent.click(screen.getByRole('button', { name: 'Re-pair Phone' }));
    await waitFor(() => screen.getByText('NEWCODE234'));
    expect(invoked('device.pair.create')).toEqual([
      { name: 'device.pair.create', input: { kind: 'human', name: 'Phone' } },
    ]);
    expect(invoked('device.revoke')).toEqual([
      { name: 'device.revoke', input: { deviceId: 'phone-1' } },
    ]);
    expect(screen.getByRole('link', { name: `${location.origin}/pair#NEWCODE234` })).toBeTruthy();
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
