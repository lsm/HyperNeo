import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppMcpServer } from '@hyperneo/shared';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));

import { AppMcpOAuthRow } from '../AppMcpOAuthRow.tsx';
import { locale } from '../../../lib/i18n/index.ts';

type Invocation = { name: string; input?: Record<string, unknown> };
const consentUrl = 'http://127.0.0.1:18347/authorize?synthetic=1';
let health: string;
const server = (active: boolean): AppMcpServer => ({
  id: 'row-1',
  name: 'fixture',
  sourceType: 'http',
  url: 'http://127.0.0.1:18347/mcp',
  enabled: true,
  source: 'user',
  auth: { kind: 'oauth', preset: 'test', generation: 1, active },
});
const invocations = (name: string) =>
  request.mock.calls.map(([, data]) => data as Invocation).filter((data) => data.name === name);

beforeEach(() => {
  locale.value = 'en';
  health = 'healthy';
  request.mockImplementation(async (_method: string, { name }: Invocation) => {
    if (name === 'mcp.registry.status') return { health, scopes: ['read'] };
    if (name === 'mcp.registry.reconnect' || name === 'mcp.registry.connect')
      return { authorizeUrl: consentUrl };
    if (name === 'mcp.registry.disconnect') return { ok: true };
    throw new Error(`unexpected ${name}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppMcpOAuthRow', () => {
  it.each([
    ['healthy', 'Connected'],
    ['reconnect_needed', 'Reconnect needed'],
    ['disconnected', 'Disconnected'],
  ])('shows %s health read from the status operation', async (state, label) => {
    health = state;
    render(<AppMcpOAuthRow server={server(true)} />);
    expect(await screen.findByText(label)).toBeTruthy();
    expect(invocations('mcp.registry.status')).toEqual([
      { name: 'mcp.registry.status', input: { id: 'row-1' } },
    ]);
  });

  it('opens consent from Reconnect in a new window', async () => {
    const popup = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<AppMcpOAuthRow server={server(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(popup.location.href).toBe(consentUrl));
    expect(popup.opener).toBeNull();
    expect(invocations('mcp.registry.reconnect')).toEqual([
      { name: 'mcp.registry.reconnect', input: { id: 'row-1' } },
    ]);
  });

  it('disconnects and offers no Disconnect on an inactive row', async () => {
    const { rerender } = render(<AppMcpOAuthRow server={server(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(invocations('mcp.registry.disconnect')).toEqual([
        { name: 'mcp.registry.disconnect', input: { id: 'row-1' } },
      ])
    );
    health = 'disconnected';
    rerender(<AppMcpOAuthRow server={server(false)} />);
    expect(await screen.findByText('Disconnected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('connects a row that has never connected with the preset status names', async () => {
    request.mockImplementation(async (_method: string, { name }: Invocation) =>
      name === 'mcp.registry.status'
        ? { health: 'disconnected', scopes: [], preset: 'test' }
        : { authorizeUrl: consentUrl }
    );
    const popup = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<AppMcpOAuthRow server={{ ...server(false), auth: undefined }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(popup.location.href).toBe(consentUrl));
    expect(invocations('mcp.registry.connect')).toEqual([
      { name: 'mcp.registry.connect', input: { id: 'row-1', preset: 'test' } },
    ]);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('shows nothing for an HTTP row without OAuth and without a matching preset', async () => {
    request.mockResolvedValue({ health: 'disconnected', scopes: [] });
    const { container } = render(<AppMcpOAuthRow server={{ ...server(false), auth: undefined }} />);
    await waitFor(() => expect(invocations('mcp.registry.status')).toHaveLength(1));
    expect(container.textContent).toBe('');
  });

  it('shows the failure reason when Reconnect returns no consent URL', async () => {
    request.mockImplementation(async (_method: string, { name }: Invocation) =>
      name === 'mcp.registry.status' ? { health, scopes: [] } : { reason: 'connect_pending' }
    );
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<AppMcpOAuthRow server={server(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('connect_pending');
  });
});
