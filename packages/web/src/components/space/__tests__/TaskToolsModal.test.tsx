import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { TaskToolsModal } from '../TaskToolsModal';

const mockListRuntimeMcpServers = vi.fn();

vi.mock('../../../lib/api-helpers', () => ({
  listRuntimeMcpServers: (...args: unknown[]) => mockListRuntimeMcpServers(...args),
}));

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
  });

  it('shows not-started message when sessionId is null', () => {
    const { getByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId={null} agentLabel="Reviewer" />
    );
    expect(getByText('Agent tools will be available after the agent starts.')).toBeTruthy();
  });

  it('shows loading state while fetching', () => {
    mockListRuntimeMcpServers.mockReturnValue(new Promise(() => {}));
    const { getByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );
    expect(getByText('Loading tools...')).toBeTruthy();
  });

  it('shows tools after loading', async () => {
    mockListRuntimeMcpServers.mockResolvedValue({
      servers: [{ name: 'space-agent-tools' }, { name: 'custom-tool' }],
    });
    const { getByText, queryByText, container } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('Space coordination')).toBeTruthy();
    expect(container.textContent).toContain('custom-tool');
    expect(mockListRuntimeMcpServers).toHaveBeenCalledWith('sess-123');
  });

  it('shows empty state when no tools are registered', async () => {
    mockListRuntimeMcpServers.mockResolvedValue({ servers: [] });
    const { getByText, queryByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('No runtime tools registered for this agent.')).toBeTruthy();
  });

  it('shows error state when fetch fails', async () => {
    mockListRuntimeMcpServers.mockRejectedValue(new Error('Network error'));
    const { getByText, queryByText } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(queryByText('Loading tools...')).toBeNull();
    });

    expect(getByText('Network error')).toBeTruthy();
  });

  it('does not fetch when closed', () => {
    render(
      <TaskToolsModal isOpen={false} onClose={() => {}} sessionId="sess-123" agentLabel="Coder" />
    );
    expect(mockListRuntimeMcpServers).not.toHaveBeenCalled();
  });

  it('cancels in-flight request when sessionId changes', async () => {
    mockListRuntimeMcpServers.mockImplementation((sessionId: string) => {
      return Promise.resolve({ servers: [{ name: sessionId }] });
    });
    const { rerender } = render(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-a" agentLabel="Coder" />
    );

    rerender(
      <TaskToolsModal isOpen={true} onClose={() => {}} sessionId="sess-b" agentLabel="Coder" />
    );

    await waitFor(() => {
      expect(mockListRuntimeMcpServers).toHaveBeenCalledWith('sess-b');
    });
  });
});
