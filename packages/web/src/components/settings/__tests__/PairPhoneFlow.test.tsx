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
  beforeEach(() => mockRequest.mockReset());
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
});
