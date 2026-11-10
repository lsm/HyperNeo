import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

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

function daemon(state: {
  paired: boolean;
  pending?: unknown[];
  terminalApproval?: boolean;
  currentId?: string;
}) {
  const devices = [
    phone,
    relay,
    {
      ...phone,
      id: state.currentId ?? 'desk-1',
      name: 'Desk browser',
      lastSeenHost: '127.0.0.1:9283',
      current: true,
    },
  ];
  let terminalApproval = state.terminalApproval ?? true;
  let pending = state.pending ?? [];
  mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
    if (!params) throw new Error(`unexpected call ${method}`);
    const { name, input } = params;
    if (!state.paired)
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
    if (name === 'device.pair.deny') {
      pending = [];
      return { ok: true };
    }
    if (name === 'device.revoke') {
      const index = devices.findIndex((device) => device.id === input.deviceId);
      devices[index] = { ...devices[index], revokedAt: Date.now() };
      return { ok: true };
    }
    if (name === 'device.pair.terminal_approval.get')
      return { ok: true, enabled: terminalApproval };
    if (name === 'device.pair.terminal_approval.set') {
      if (input.enabled && state.currentId?.startsWith('local-rpc:'))
        return {
          ok: false,
          reason: 'not_paired: only a paired phone or browser can turn it back on.',
        };
      terminalApproval = input.enabled as boolean;
      return { ok: true, enabled: terminalApproval };
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
  it('keeps the ready view and keeps polling after a background request fails', async () => {
    daemon({
      paired: true,
      pending: [
        {
          id: 'scan',
          kind: 'human',
          name: 'Phone',
          expiresAt: 4e12,
          twoWay: true,
          phoneConfirmed: false,
        },
      ],
    });
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      render(<DevicesSettings />);
      await screen.findByText('Waiting for the phone to confirm.');
      await waitFor(() =>
        expect(interval.mock.calls.some(([, delay]) => delay === 1000)).toBe(true)
      );
      const poll = interval.mock.calls.find(([, delay]) => delay === 1000)?.[0];
      expect(typeof poll).toBe('function');
      const request = mockRequest.getMockImplementation()!;
      let fail = true;
      mockRequest.mockImplementation(async (...args) => {
        if (fail) {
          fail = false;
          throw new Error('synthetic disconnected');
        }
        return request(...args);
      });
      if (typeof poll !== 'function') throw new Error('poll was not registered');
      await act(async () => {
        poll();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(fail).toBe(false));
      expect(screen.getByText('Waiting for the phone to confirm.')).toBeTruthy();
      const before = invoked('device.pair.pending').length;
      poll();
      await waitFor(() => expect(invoked('device.pair.pending').length).toBeGreaterThan(before));
      expect(screen.getByRole('button', { name: 'Allow Phone' })).toBeTruthy();
    } finally {
      interval.mockRestore();
    }
  });
  it('waits for the scanned phone before enabling Allow', async () => {
    daemon({
      paired: true,
      pending: [
        {
          id: 'scan',
          kind: 'human',
          name: 'Phone',
          expiresAt: 4e12,
          twoWay: true,
          phoneConfirmed: false,
        },
      ],
    });
    render(<DevicesSettings />);
    expect(await screen.findByText('Waiting for the phone to confirm.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Allow Phone' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny Phone' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
  it('asks for the phone code before allowing a confirmed two-way request', async () => {
    daemon({
      paired: true,
      pending: [
        {
          id: 'scan',
          kind: 'human',
          name: 'Phone',
          expiresAt: 4e12,
          twoWay: true,
          phoneConfirmed: true,
        },
      ],
    });
    render(<DevicesSettings />);
    const input = await screen.findByRole('textbox', { name: 'Code shown on Phone' });
    const allow = screen.getByRole('button', { name: 'Allow Phone' });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    for (const invalid of ['12345678', 'ABCDEFGH']) {
      fireEvent.input(input, { target: { value: invalid } });
      expect((allow as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.input(input, { target: { value: 'mrnv-jhmh' } });
    fireEvent.click(allow);
    await waitFor(() =>
      expect(invoked('device.pair.approve')).toEqual([
        { name: 'device.pair.approve', input: { codeId: 'scan', confirmCode: 'mrnv-jhmh' } },
      ])
    );
  });

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

  it('shows the submitted label as text and falls back to the code label', async () => {
    daemon({
      paired: true,
      pending: [
        {
          id: 'new',
          kind: 'human',
          name: 'Code label',
          requestedName: '<Browser label>',
          expiresAt: Date.now() + 300_000,
        },
        { id: 'old', kind: 'human', name: 'Old label', expiresAt: Date.now() + 300_000 },
      ],
    });
    const view = render(<DevicesSettings />);
    expect(await screen.findByText('<Browser label>')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow <Browser label>' })).toBeTruthy();
    expect(screen.getByText('Old label')).toBeTruthy();
    expect(view.container.querySelector('browser')).toBeNull();
  });

  it('denies a pending code from a button left of Allow', async () => {
    daemon({
      paired: true,
      pending: [{ id: 'code-1', kind: 'human', name: 'Laptop', expiresAt: Date.now() + 300_000 }],
    });
    render(<DevicesSettings />);
    const deny = await screen.findByRole('button', { name: 'Deny Laptop' });
    const allow = screen.getByRole('button', { name: 'Allow Laptop' });
    expect(deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(deny);
    await waitFor(() => screen.getByText('No codes are waiting for Allow.'));
    expect(invoked('device.pair.deny')).toEqual([
      { name: 'device.pair.deny', input: { codeId: 'code-1' } },
    ]);
    expect(invoked('device.pair.approve')).toEqual([]);
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

  it('shows a failed Allow above the sections, next to the code it was for', async () => {
    daemon({
      paired: true,
      pending: [{ id: 'expired', kind: 'human', name: 'Old laptop', expiresAt: Date.now() }],
    });
    render(<DevicesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Old laptop' }));
    const failure = await screen.findByText('not_pending: no pending code with that id.');
    const waiting = screen.getByText('Waiting for Allow');
    expect(
      failure.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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

  it('turns terminal approval off and back on from this paired browser', async () => {
    daemon({ paired: true });
    render(<DevicesSettings />);
    const toggle = await waitFor(() =>
      screen.getByRole('switch', { name: 'Allow from the terminal' })
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Allow from the terminal' }).getAttribute('aria-checked')
      ).toBe('false')
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Allow from the terminal' }));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Allow from the terminal' }).getAttribute('aria-checked')
      ).toBe('true')
    );
    expect(invoked('device.pair.terminal_approval.set').map((call) => call.input)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
  });

  it('cannot turn terminal approval back on from local tools and says why', async () => {
    daemon({ paired: true, terminalApproval: false, currentId: 'local-rpc:tools' });
    render(<DevicesSettings />);
    const toggle = await waitFor(() =>
      screen.getByRole('switch', { name: 'Allow from the terminal' })
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Turn this back on from a paired phone or browser.')).toBeTruthy();
    expect(invoked('device.pair.terminal_approval.set')).toEqual([]);
  });
});
