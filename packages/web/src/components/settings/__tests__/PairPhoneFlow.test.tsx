import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: async () => ({ request: mockRequest }),
  },
}));

vi.mock('../../../lib/state.ts', async () => {
  const { signal } = await import('@preact/signals');
  return {
    globalSettings: signal<{ allowedHosts?: string[] } | null>({
      allowedHosts: ['mac.tailnet.ts.net'],
    }),
  };
});

import { PairPhoneFlow } from '../PairPhoneFlow.tsx';

type Invocation = { name: string; input: Record<string, unknown> };

const desk = {
  id: 'desk-1',
  name: 'Desk browser',
  kind: 'human',
  createdAt: 1,
  lastSeenAt: Date.now(),
  lastSeenHost: null as string | null,
  revokedAt: null as number | null,
  current: true,
};
const phone = { ...desk, id: 'phone-9', name: 'Kitchen iPhone', current: false };

function invoked(name: string): Invocation[] {
  return mockRequest.mock.calls
    .map(([, params]) => params as Invocation | undefined)
    .filter((call): call is Invocation => call?.name === name);
}

function daemon(replies: unknown[], devices: { current: unknown[] }) {
  let index = 0;
  mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
    if (!params) throw new Error(`unexpected call ${method}`);
    const { name } = params;
    if (name === 'device.pair.create') {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (name === 'device.list') return { ok: true, devices: devices.current };
    throw new Error(`unexpected ${name}`);
  });
}

const approved = (code: string, expiresAt = Date.now() + 600_000) => ({
  ok: true,
  codeId: `id-${code}`,
  code,
  expiresAt,
  approval: 'approved',
});

describe('PairPhoneFlow', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });
  afterEach(() => cleanup());

  it('shows the address and code after Start pairing, then confirms the paired phone by name', async () => {
    const devices = { current: [desk] };
    daemon([approved('NEWCODE234')], devices);
    const onPaired = vi.fn();
    render(<PairPhoneFlow pollMs={20} onPaired={onPaired} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('NEWCODE234');
    expect(screen.getByText(location.origin)).toBeTruthy();
    expect(screen.getByText(/mac\.tailnet\.ts\.net/)).toBeTruthy();
    expect(screen.getByText(/same Wi-Fi or Tailscale/)).toBeTruthy();
    expect(screen.getByText(/only works on this Mac/)).toBeTruthy();
    expect(invoked('device.pair.create')).toEqual([
      { name: 'device.pair.create', input: { kind: 'human' } },
    ]);
    devices.current = [desk, phone];
    await screen.findByText('Paired: Kitchen iPhone', undefined, { timeout: 3000 });
    expect(onPaired).toHaveBeenCalledOnce();
  });

  it('says when the code also needs Allow on an already paired device', async () => {
    const devices = { current: [desk] };
    daemon([{ ...approved('WAITCODE77'), approval: 'pending' }], devices);
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('WAITCODE77');
    expect(screen.getByText(/needs Allow on an already paired/)).toBeTruthy();
  });

  it('explains an expired code and starts over with a new one', async () => {
    const devices = { current: [desk] };
    daemon([approved('OLDCODE11', Date.now() + 60), approved('FRESHCODE2')], devices);
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText(/expired before the phone paired/, undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('FRESHCODE2');
  });

  it('passes through the daemon recovery guidance when no paired human can Allow', async () => {
    const devices = { current: [desk] };
    daemon(
      [
        {
          ok: false,
          reason:
            'no_human_device: no active human device can Allow this code. For lost-phone recovery, run hyperneo devices reset-human on the daemon machine, then hyperneo pair. The reset notifies Neo.',
        },
      ],
      devices
    );
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText(/reset-human/);
  });

  it('says when the daemon cannot be reached', async () => {
    const devices = { current: [desk] };
    daemon([new Error('socket closed')], devices);
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText(/Could not reach the daemon/);
  });

  it("confirms a phone that paired in the code's final moments instead of calling it expired", async () => {
    let lists = 0;
    mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
      if (!params) throw new Error(`unexpected call ${method}`);
      const { name } = params;
      if (name === 'device.pair.create') return approved('LATECODE55', Date.now() - 1);
      if (name === 'device.list') {
        lists += 1;
        return { ok: true, devices: lists === 1 ? [desk] : [desk, phone] };
      }
      throw new Error(`unexpected ${name}`);
    });
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('Paired: Kitchen iPhone', undefined, { timeout: 3000 });
    expect(screen.queryByText(/expired before the phone paired/)).toBeNull();
  });

  it('fails the start instead of confirming an existing device when the first device list fails', async () => {
    let lists = 0;
    mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
      if (!params) throw new Error(`unexpected call ${method}`);
      const { name } = params;
      if (name === 'device.pair.create') return approved('NEWCODE234');
      if (name === 'device.list') {
        lists += 1;
        if (lists === 1) throw new Error('socket closed');
        return { ok: true, devices: [desk] };
      }
      throw new Error(`unexpected ${name}`);
    });
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText(/Could not reach the daemon/);
    expect(screen.queryByText(/^Paired:/)).toBeNull();
  });

  it('stops polling when cancelled', async () => {
    const devices = { current: [desk] };
    daemon([approved('NEWCODE234')], devices);
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('NEWCODE234');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Start pairing' });
    const polls = invoked('device.list').length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(invoked('device.list').length).toBe(polls);
  });

  it('does not confirm a phone after Cancel while a poll is in flight', async () => {
    let resolvePoll: ((value: unknown) => void) | undefined;
    let lists = 0;
    mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
      if (!params) throw new Error(`unexpected call ${method}`);
      const { name } = params;
      if (name === 'device.pair.create') return approved('NEWCODE234');
      if (name === 'device.list') {
        lists += 1;
        if (lists === 1) return { ok: true, devices: [desk] };
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('NEWCODE234');
    await waitFor(() => expect(lists).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    resolvePoll?.({ ok: true, devices: [desk, phone] });
    await screen.findByRole('button', { name: 'Start pairing' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByText(/^Paired:/)).toBeNull();
  });

  it('keeps waiting when a non-human device appears, then confirms the phone', async () => {
    const relay = { ...desk, id: 'relay-1', name: 'Relay node', kind: 'relay', current: false };
    let lists = 0;
    mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
      if (!params) throw new Error(`unexpected call ${method}`);
      const { name } = params;
      if (name === 'device.pair.create') return approved('NEWCODE234');
      if (name === 'device.list') {
        lists += 1;
        if (lists === 1) return { ok: true, devices: [desk] };
        if (lists === 2) return { ok: true, devices: [desk, relay] };
        return { ok: true, devices: [desk, relay, phone] };
      }
      throw new Error(`unexpected ${name}`);
    });
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('NEWCODE234');
    await screen.findByText('Paired: Kitchen iPhone', undefined, { timeout: 3000 });
  });

  it('reports an unreachable daemon when polls keep failing instead of waiting for expiry', async () => {
    let lists = 0;
    mockRequest.mockImplementation(async (method: string, params?: Invocation) => {
      if (!params) throw new Error(`unexpected call ${method}`);
      const { name } = params;
      if (name === 'device.pair.create') return approved('NEWCODE234');
      if (name === 'device.list') {
        lists += 1;
        if (lists === 1) return { ok: true, devices: [desk] };
        throw new Error('socket closed');
      }
      throw new Error(`unexpected ${name}`);
    });
    render(<PairPhoneFlow pollMs={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start pairing' }));
    await screen.findByText('NEWCODE234');
    await screen.findByText(/Could not reach the daemon/, undefined, { timeout: 3000 });
  });
});
