import { cleanup, render, waitFor, act, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, GetSessionToolInventoryResponse } from '@hyperneo/shared';
import { skillsStore } from '../../lib/skills-store.ts';
import { ToolsModal } from '../ToolsModal.tsx';

const backend = vi.hoisted(() => ({
  request: vi.fn(),
  event: new Map<string, (...args: unknown[]) => void>(),
  connection: null as null | ((state: string) => void),
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request: backend.request,
      onEvent: (name: string, callback: (...args: unknown[]) => void) => {
        backend.event.set(name, callback);
        return () => backend.event.delete(name);
      },
      onConnection: (callback: (state: string) => void) => {
        backend.connection = callback;
        return () => {
          backend.connection = null;
        };
      },
    }),
  },
}));
vi.mock('../../lib/api-helpers.ts', () => ({
  listRuntimeMcpServers: async () => ({ servers: [{ name: 'configured-only' }] }),
}));
vi.mock('../../lib/skills-store.ts', async () => {
  const { signal } = await import('@preact/signals');
  return { skillsStore: { skills: signal([]), subscribe: async () => {}, unsubscribe: () => {} } };
});

const session = {
  id: 'one',
  title: 'Synthetic inbox',
  config: {},
  metadata: {},
  status: 'active',
  workspacePath: '/synthetic',
} as Session;
const closed = {
  state: 'not_running',
  tools: [],
  skills: [],
  plugins: [],
  mcpServers: [],
} satisfies GetSessionToolInventoryResponse;
const attached = (count = 1): GetSessionToolInventoryResponse => ({
  ...closed,
  state: 'observed',
  tools: ['Read'],
  mcpServers: [
    {
      name: 'browser-alias',
      status: 'connected',
      tools: Array.from({ length: count }, (_, i) => `tool${i}`),
    },
  ],
});
let response: GetSessionToolInventoryResponse | Promise<GetSessionToolInventoryResponse>;

beforeEach(() => {
  response = closed;
  backend.event.clear();
  backend.request.mockReset();
  backend.request.mockImplementation(async (name: string) => {
    if (name === 'session.getToolInventory') return response;
    if (name === 'session.mcp.list')
      return {
        entries: [
          {
            server: {
              id: 'browser',
              name: 'browser-server',
              enabled: true,
              sourceType: 'stdio',
              command: 'synthetic',
              args: [],
              source: 'builtin',
            },
            enabled: true,
            source: 'registry',
          },
        ],
      };
    if (name === 'globalTools.getConfig') return { config: {} };
    throw new Error(`Unexpected RPC ${name}`);
  });
  skillsStore.skills.value = [
    {
      id: 'wrapper',
      name: 'browser-alias',
      displayName: 'Synthetic Browser',
      description: '',
      sourceType: 'mcp_server',
      config: { type: 'mcp_server', appMcpServerId: 'browser' },
      enabled: false,
      builtIn: true,
      validationStatus: 'valid',
      createdAt: 0,
    },
    {
      id: 'playwright',
      name: 'playwright',
      displayName: 'Playwright',
      description: '',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'playwright' },
      enabled: true,
      builtIn: true,
      validationStatus: 'valid',
      createdAt: 0,
    },
  ];
});
afterEach(cleanup);

describe('ToolsModal observed running inventory', () => {
  it('does not present configured-only runtime servers as attached', async () => {
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(backend.request).toHaveBeenCalledWith('session.getToolInventory', { sessionId: 'one' })
    );
    expect(view.queryByText('configured-only')).toBeNull();
    expect(view.queryByText('Active in this session')).toBeNull();
    expect(view.getByTestId('skill-runtime-playwright').textContent).toMatch(
      /not attached yet.*session not running/i
    );
  });

  it('shows actual attachment even when the current configured wrapper is off', async () => {
    response = attached();
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain(
        'Attached · 1 tools'
      )
    );
  });

  it('calls loaded Playwright instructions instructions, without certifying browser tools', async () => {
    response = { ...closed, state: 'observed', skills: ['playwright'], plugins: ['playwright'] };
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-playwright').textContent).toMatch(
        /Instructions loaded.*prerequisites unverified/
      )
    );
  });

  it('invalidates the open panel when its query ends and refreshes after reconnect', async () => {
    response = attached();
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain('Attached')
    );
    response = closed;
    await act(() => backend.event.get('session.toolInventory.changed')?.({ sessionId: 'one' }));
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-playwright').textContent).toMatch(
        /session not running/i
      )
    );
    response = attached(2);
    await act(() => backend.connection?.('connected'));
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain(
        'Attached · 2 tools'
      )
    );
  });

  it('ignores a late read from the previously displayed session', async () => {
    let finish!: (value: GetSessionToolInventoryResponse) => void;
    response = new Promise((done) => {
      finish = done;
    });
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(backend.request).toHaveBeenCalledWith('session.getToolInventory', { sessionId: 'one' })
    );
    response = attached(2);
    view.rerender(<ToolsModal isOpen onClose={() => {}} session={{ ...session, id: 'two' }} />);
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain(
        'Attached · 2 tools'
      )
    );
    await act(async () => {
      finish(attached(1));
      await Promise.resolve();
    });
    expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain(
      'Attached · 2 tools'
    );
  });

  it('can refresh an unverified provider without promising next-respawn attachment', async () => {
    response = { ...closed, state: 'unverified' };
    const view = render(<ToolsModal isOpen onClose={() => {}} session={session} />);
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-playwright').textContent).toMatch(
        /provider cannot confirm/i
      )
    );
    expect(view.queryByText(/next respawn/)).toBeNull();
    response = attached();
    fireEvent.click(view.getByRole('button', { name: 'Refresh running tools' }));
    await waitFor(() =>
      expect(view.getByTestId('skill-runtime-browser-alias').textContent).toContain('Attached')
    );
  });
});
