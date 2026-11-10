import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { taskActivity, activateTaskNodeAgent, replaceOverlayHistory } = vi.hoisted(() => ({
  taskActivity: { value: new Map<string, unknown[]>() },
  activateTaskNodeAgent: vi.fn(),
  replaceOverlayHistory: vi.fn(),
}));

vi.mock('../../../lib/space-store.ts', () => ({
  spaceStore: { taskActivity, activateTaskNodeAgent },
}));
vi.mock('../../../lib/space-router.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../lib/router.ts')),
}));
vi.mock('../../../lib/router.ts', () => ({ replaceOverlayHistory }));

import { PendingAgentChat } from '../PendingAgentChat';

const pendingAgent = { taskId: 'task-1', agentName: 'Coder', workflowNodeId: 'node-1' };

describe('PendingAgentChat', () => {
  beforeEach(() => {
    taskActivity.value = new Map();
    activateTaskNodeAgent.mockReset();
    replaceOverlayHistory.mockReset();
  });

  afterEach(() => cleanup());

  const send = (text: string) => {
    fireEvent.input(screen.getByTestId('pending-agent-overlay-textarea'), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  };

  it('starts the agent with the first message and opens its session', async () => {
    activateTaskNodeAgent.mockResolvedValue({ sessionId: 'session-1' });
    render(<PendingAgentChat pendingAgent={pendingAgent} />);
    expect(screen.getByText("Coder hasn't started yet")).toBeTruthy();

    send('hello');

    await waitFor(() =>
      expect(replaceOverlayHistory).toHaveBeenCalledWith('session-1', 'Coder', undefined, {
        taskId: 'task-1',
        agentName: 'Coder',
        sessionId: 'session-1',
        workflowNodeId: 'node-1',
      })
    );
    expect(activateTaskNodeAgent.mock.calls[0].slice(0, 4)).toEqual([
      'task-1',
      'Coder',
      'hello',
      'node-1',
    ]);
  });

  it('shows that the message is queued until the session exists', async () => {
    activateTaskNodeAgent.mockResolvedValue({ sessionId: null });
    render(<PendingAgentChat pendingAgent={pendingAgent} />);

    send('hello');

    expect(await screen.findByText('Starting Coder…')).toBeTruthy();
  });

  it('says why when the agent cannot start', async () => {
    activateTaskNodeAgent.mockRejectedValue(new Error('no slot'));
    render(<PendingAgentChat pendingAgent={pendingAgent} />);

    send('hello');

    expect(await screen.findByText('Failed to start Coder: no slot')).toBeTruthy();
  });

  it('opens the session when a matching agent goes live', async () => {
    taskActivity.value = new Map([
      [
        'task-1',
        [
          {
            kind: 'node_agent',
            role: 'Coder',
            label: 'Coder 2',
            sessionId: 'live-1',
            nodeExecution: { status: 'in_progress', nodeId: 'node-1', nodeExecutionId: 'exec-1' },
          },
        ],
      ],
    ]);
    render(<PendingAgentChat pendingAgent={pendingAgent} />);

    await waitFor(() =>
      expect(replaceOverlayHistory).toHaveBeenCalledWith('live-1', 'Coder 2', undefined, {
        taskId: 'task-1',
        agentName: 'Coder',
        sessionId: 'live-1',
        nodeExecutionId: 'exec-1',
        workflowNodeId: 'node-1',
      })
    );
  });
});
