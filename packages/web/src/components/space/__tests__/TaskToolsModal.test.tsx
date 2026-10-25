import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/preact';
import { TaskToolsModal } from '../TaskToolsModal';

const mockInventoryRequest = vi.fn();
const inventoryEvents = new Map<string, (payload: unknown) => void>();
let connectionListener: ((state: string) => void) | null = null;
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request: mockInventoryRequest,
      onConnection: (callback: (state: string) => void) => {
        connectionListener = callback;
        return () => {
          connectionListener = null;
        };
      },
      onEvent: (name: string, callback: (payload: unknown) => void) => {
        inventoryEvents.set(name, callback);
        return () => inventoryEvents.delete(name);
      },
    }),
  },
}));

const observed = (names: string[] = []) => ({
  state: 'observed',
  tools: ['Read'],
  skills: [],
  plugins: [],
  mcpServers: names.map((name) => ({
    name,
    status: 'connected',
    tools: [{ name: 'navigate' }].map((tool) => tool.name),
  })),
});

vi.mock('../../ui/Modal', () => ({
  Modal: ({ children, isOpen, title }: { children: any; isOpen: boolean; title: string }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="mock-modal" data-title={title}>
        {children}
      </div>
    );
  },
}));

describe('TaskToolsModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    inventoryEvents.clear();
    connectionListener = null;
    mockInventoryRequest.mockResolvedValue(observed());
  });

  it('does not show configured-only servers as observed task tools', async () => {
    mockInventoryRequest.mockResolvedValue({
      state: 'not_running',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    const view = render(
      <TaskToolsModal isOpen onClose={() => {}} sessionId="task-session" agentLabel="Coder" />
    );
    await waitFor(() => expect(view.queryByText('Loading tools...')).toBeNull());
    expect(view.queryByText('configured-only')).toBeNull();
    expect(mockInventoryRequest).toHaveBeenCalledWith('session.getToolInventory', {
      sessionId: 'task-session',
    });
    expect(view.getByText(/session not running/)).toBeTruthy();
  });

  it('reports an unverified task provider instead of asserting no runtime tools', async () => {
    mockInventoryRequest.mockResolvedValue({
      state: 'unverified',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    const view = render(
      <TaskToolsModal isOpen onClose={() => {}} sessionId="task-session" agentLabel="Coder" />
    );
    await waitFor(() => expect(view.queryByText('Loading tools...')).toBeNull());
    expect(view.getByText(/provider cannot confirm/)).toBeTruthy();
  });

  it('shows not-started message when sessionId is null', () => {
    const { getByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId={null} agentLabel="Reviewer" />
    );
    expect(getByText('Start the agent to check its running tools.')).toBeTruthy();
  });

  it('shows loading state while fetching', () => {
    mockInventoryRequest.mockReturnValue(new Promise(() => {}));
    const { getByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );
    expect(getByText('Loading tools...')).toBeTruthy();
  });

  it('shows tools after loading', async () => {
    mockInventoryRequest.mockResolvedValue(observed(['agent-memory', 'custom-tool']));
    const { getByText, queryByText, container } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('Agent memory')).toBeTruthy();
    expect(container.textContent).toContain('custom-tool');
    expect(mockInventoryRequest).toHaveBeenCalledWith('session.getToolInventory', {
      sessionId: 'sess-123',
    });
    expect(container.textContent).toContain('Attached · 1 tool');
  });

  it('shows empty state when no tools are registered', async () => {
    mockInventoryRequest.mockResolvedValue(observed());
    const { getByText, queryByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('No MCP servers observed in this running session.')).toBeTruthy();
  });

  it('shows error state when fetch fails', async () => {
    mockInventoryRequest.mockRejectedValue(new Error('Private network diagnostic'));
    const { getByText, queryByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('Could not verify running tools. Try Refresh.')).toBeTruthy();
    expect(queryByText('Private network diagnostic')).toBeNull();
  });

  it('does not fetch when closed', () => {
    render(
      <TaskToolsModal isOpen={false} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );
    expect(mockInventoryRequest).not.toHaveBeenCalled();
  });

  it('cancels in-flight request when sessionId changes', async () => {
    let finish!: (result: ReturnType<typeof observed>) => void;
    mockInventoryRequest.mockImplementation((_method, { sessionId }: { sessionId: string }) => {
      return sessionId === 'sess-a'
        ? new Promise((done) => {
            finish = done;
          })
        : Promise.resolve(observed(['current-tool']));
    });
    const { rerender, getByText, queryByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-a" agentLabel="Coder" />
    );
    await waitFor(() =>
      expect(mockInventoryRequest).toHaveBeenCalledWith('session.getToolInventory', {
        sessionId: 'sess-a',
      })
    );

    rerender(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-b" agentLabel="Coder" />
    );

    await waitFor(() => expect(getByText('current-tool')).toBeTruthy());
    await act(async () => {
      finish(observed(['stale-tool']));
      await Promise.resolve();
    });
    expect(queryByText('stale-tool')).toBeNull();
    expect(getByText('current-tool')).toBeTruthy();
  });

  it('hides previous tool names when a refresh fails and recovers on a later read', async () => {
    mockInventoryRequest.mockResolvedValue(observed(['browser']));
    const view = render(
      <TaskToolsModal isOpen onClose={() => {}} sessionId="task" agentLabel="Coder" />
    );
    await waitFor(() => expect(view.getByText('Observed tool names (1)')).toBeTruthy());
    fireEvent.click(view.getByText('Observed tool names (1)'));
    expect(view.getByText('Read')).toBeTruthy();
    mockInventoryRequest.mockRejectedValue(new Error('Synthetic read failure'));
    fireEvent.click(view.getByRole('button', { name: 'Refresh running tools' }));
    await waitFor(() =>
      expect(view.getByText('Could not verify running tools. Try Refresh.')).toBeTruthy()
    );
    expect(view.queryByText('Observed tool names (1)')).toBeNull();
    expect(view.queryByText('Read')).toBeNull();
    expect(view.queryByText('browser')).toBeNull();
    mockInventoryRequest.mockResolvedValue(observed(['recovered-browser']));
    fireEvent.click(view.getByRole('button', { name: 'Refresh running tools' }));
    await waitFor(() => expect(view.getByText('recovered-browser')).toBeTruthy());
    expect(view.getByText('Observed tool names (1)')).toBeTruthy();
  });

  it('retains confirmed servers through a pending refresh', async () => {
    mockInventoryRequest.mockResolvedValue(observed(['browser']));
    const view = render(
      <TaskToolsModal isOpen onClose={() => {}} sessionId="task" agentLabel="Coder" />
    );
    await waitFor(() => expect(view.getByText('Attached · 1 tool')).toBeTruthy());
    let finish!: (result: ReturnType<typeof observed>) => void;
    mockInventoryRequest.mockReturnValue(
      new Promise((done) => {
        finish = done;
      })
    );
    fireEvent.click(view.getByRole('button', { name: 'Refresh running tools' }));
    await waitFor(() => expect(view.getByText('Refreshing tools...')).toBeTruthy());
    expect(view.getByText('browser')).toBeTruthy();
    expect(view.getByText('Attached · 1 tool')).toBeTruthy();
    await act(async () => {
      finish(observed());
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByText('browser')).toBeNull());
  });

  it('invalidates ended queries and reloads after reconnect', async () => {
    mockInventoryRequest.mockResolvedValue(observed(['browser']));
    const view = render(
      <TaskToolsModal isOpen onClose={() => {}} sessionId="task" agentLabel="Coder" />
    );
    await waitFor(() => expect(view.getByText('browser')).toBeTruthy());
    mockInventoryRequest.mockResolvedValue({ ...observed(), state: 'not_running', tools: [] });
    await act(() => inventoryEvents.get('session.toolInventory.changed')?.({ sessionId: 'task' }));
    await waitFor(() => expect(view.getByText(/session not running/)).toBeTruthy());
    await act(() => connectionListener?.('disconnected'));
    expect(view.getByText('Not connected. Running tools are unverified.')).toBeTruthy();
    mockInventoryRequest.mockResolvedValue(observed(['new-browser']));
    await act(() => connectionListener?.('connected'));
    await waitFor(() => expect(view.getByText('new-browser')).toBeTruthy());
  });

  it.each(['failed', 'pending', 'needs-auth', 'disabled', 'unverified'])(
    'does not claim attachment for %s',
    async (status) => {
      mockInventoryRequest.mockResolvedValue({
        ...observed(),
        mcpServers: [{ name: 'browser', status, tools: null }],
      });
      const view = render(
        <TaskToolsModal isOpen onClose={() => {}} sessionId="task" agentLabel="Coder" />
      );
      await waitFor(() => expect(view.getByText(/Configured but not attached yet/)).toBeTruthy());
      expect(view.queryByText(/Attached ·/)).toBeNull();
    }
  );
});
