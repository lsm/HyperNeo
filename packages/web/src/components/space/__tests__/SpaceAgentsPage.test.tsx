import type { SpaceAgent } from '@hyperneo/shared';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgents,
  mockLoading,
  mockError,
  mockSelectSpace,
  mockCreate,
  mockUpdate,
  mockRemove,
  mockTeardown,
  mockTemplates,
  mockFetchTemplates,
  mockOnceConnected,
  mockDisposeOnceConnected,
} = vi.hoisted(() => ({
  mockAgents: { value: [] as SpaceAgent[] },
  mockLoading: { value: false },
  mockError: { value: null as string | null },
  mockSelectSpace: vi.fn().mockResolvedValue(undefined),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockTeardown: vi.fn(),
  mockTemplates: { value: [] as Array<{ key: string; displayName: string }> },
  mockFetchTemplates: vi.fn().mockResolvedValue(undefined),
  mockOnceConnected: vi.fn(),
  mockDisposeOnceConnected: vi.fn(),
}));

vi.mock('../../../lib/space-agent-store', () => ({
  spaceAgentStore: {
    agents: mockAgents,
    loading: mockLoading,
    error: mockError,
    selectSpace: mockSelectSpace,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
    teardown: mockTeardown,
  },
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { agentTemplates: mockTemplates, fetchTemplates: mockFetchTemplates },
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { onceConnected: mockOnceConnected },
}));

import { SpaceAgentsPage } from '../SpaceAgentsPage';

function makeAgent(id: string, overrides: Partial<SpaceAgent> = {}): SpaceAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: id,
    description: null,
    instructions: '',
    status: 'active',
    sessionId: null,
    autonomyLevel: null,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SpaceAgentsPage', () => {
  beforeEach(() => {
    mockAgents.value = [];
    mockLoading.value = false;
    mockError.value = null;
    mockTemplates.value = [];
    mockSelectSpace.mockClear();
    mockCreate.mockReset().mockResolvedValue(makeAgent('created'));
    mockUpdate.mockReset().mockResolvedValue(makeAgent('a'));
    mockRemove.mockReset().mockResolvedValue(undefined);
    mockTeardown.mockClear();
    mockFetchTemplates.mockReset().mockResolvedValue(undefined);
    mockDisposeOnceConnected.mockClear();
    mockOnceConnected.mockReset().mockReturnValue(mockDisposeOnceConnected);
  });

  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('selects the space on mount', () => {
    render(<SpaceAgentsPage spaceId="space-1" />);
    expect(mockSelectSpace).toHaveBeenCalledWith('space-1');
  });

  it('tears the store down on unmount', () => {
    const { unmount } = render(<SpaceAgentsPage spaceId="space-1" />);
    expect(mockTeardown).not.toHaveBeenCalled();

    unmount();
    expect(mockTeardown).toHaveBeenCalled();
  });

  it('loads the template library on mount so the create form can offer templates', () => {
    render(<SpaceAgentsPage spaceId="space-1" />);
    expect(mockFetchTemplates).toHaveBeenCalled();
  });

  it('renders when the template library cannot be loaded', () => {
    mockFetchTemplates.mockRejectedValueOnce(new Error('Not connected'));
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    expect(getByTestId('space-agents-page')).toBeTruthy();
  });

  it('retries the template load once the connection comes back', async () => {
    mockFetchTemplates.mockRejectedValueOnce(new Error('Not connected'));
    render(<SpaceAgentsPage spaceId="space-1" />);
    await tick();

    expect(mockOnceConnected).toHaveBeenCalledTimes(1);
    expect(mockFetchTemplates).toHaveBeenCalledTimes(1);

    mockOnceConnected.mock.calls[0][0]();
    expect(mockFetchTemplates).toHaveBeenCalledTimes(2);
  });

  it('does not arm a reconnect retry when the template load succeeds', async () => {
    render(<SpaceAgentsPage spaceId="space-1" />);
    await tick();

    expect(mockOnceConnected).not.toHaveBeenCalled();
  });

  it('drops the pending template retry on unmount', async () => {
    mockFetchTemplates.mockRejectedValueOnce(new Error('Not connected'));
    const { unmount } = render(<SpaceAgentsPage spaceId="space-1" />);
    await tick();

    unmount();
    expect(mockDisposeOnceConnected).toHaveBeenCalled();
  });

  it('reselects and tears down when the space changes', () => {
    const { rerender } = render(<SpaceAgentsPage spaceId="space-1" />);
    rerender(<SpaceAgentsPage spaceId="space-2" />);

    expect(mockTeardown).toHaveBeenCalled();
    expect(mockSelectSpace).toHaveBeenLastCalledWith('space-2');
  });

  it('closes an open editor when the space changes, so it cannot save to the old space', () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, getByText, queryByTestId, rerender } = render(
      <SpaceAgentsPage spaceId="space-1" />
    );

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    expect(getByTestId('agent-form')).toBeTruthy();

    mockAgents.value = [];
    rerender(<SpaceAgentsPage spaceId="space-2" />);

    expect(queryByTestId('agent-form')).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('dismisses a pending delete confirmation when the space changes', () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, queryByText, rerender } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByTestId('agent-delete-button'));
    expect(queryByText('Delete agent')).toBeTruthy();

    mockAgents.value = [];
    rerender(<SpaceAgentsPage spaceId="space-2" />);

    expect(queryByText('Delete agent')).toBeNull();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no agents', () => {
    const { getByText } = render(<SpaceAgentsPage spaceId="space-1" />);
    expect(getByText('No agents yet')).toBeTruthy();
  });

  it('does not claim the space is empty when the list failed to load', () => {
    mockError.value = 'boom';
    const { getByTestId, queryByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    expect(getByTestId('agents-load-error').textContent).toBe('boom');
    expect(queryByText('No agents yet')).toBeNull();
  });

  it('surfaces a load error', () => {
    mockError.value = 'boom';
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);
    expect(getByTestId('agents-load-error').textContent).toBe('boom');
  });

  it('lists agents by handle', () => {
    mockAgents.value = [makeAgent('alpha'), makeAgent('beta')];
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    expect(getByTestId('agent-row-alpha')).toBeTruthy();
    expect(getByTestId('agent-row-beta')).toBeTruthy();
  });

  it('hides archived agents from the list', () => {
    mockAgents.value = [makeAgent('alpha'), makeAgent('retired', { status: 'archived' })];
    const { getByTestId, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    expect(getByTestId('agent-row-alpha')).toBeTruthy();
    expect(queryByTestId('agent-row-retired')).toBeNull();
  });

  it('shows detail for the selected agent', () => {
    mockAgents.value = [makeAgent('alpha', { instructions: 'Be helpful.' })];
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    expect(getByTestId('agent-detail').textContent).toContain('Be helpful.');
  });

  it('creates an agent from the form', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Researcher' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ spaceId: 'space-1', displayName: 'Researcher' })
      )
    );
  });

  it('passes the chosen template key through', async () => {
    mockTemplates.value = [{ key: 'researcher.v1', displayName: 'Researcher' }];
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.change(getByTestId('agent-template-select'), {
      target: { value: 'researcher.v1' },
    });
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'From template' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ templateKey: 'researcher.v1' })
      )
    );
  });

  it('omits an unset template key rather than sending an empty string', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Blank' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].templateKey).toBeUndefined();
  });

  it('shows a create error and keeps the form open', async () => {
    mockCreate.mockRejectedValue(new Error('Handle "x" is reserved'));
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'X' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(getByTestId('agent-form-error').textContent).toBe('Handle "x" is reserved')
    );
    expect(getByTestId('agent-form')).toBeTruthy();
  });

  it('edits an existing agent without sending a handle', async () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, getByText, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    expect(queryByTestId('agent-handle-input')).toBeNull();

    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Renamed' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        'alpha',
        expect.objectContaining({
          displayName: 'Renamed',
        })
      )
    );
  });

  it('rejects an empty name on edit without calling the store', async () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: '   ' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(getByTestId('agent-form-error').textContent).toBe('Name is required')
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each([
    'space-manager',
    'coordinator',
  ])('does not offer deletion for the protected %s agent', (handle) => {
    mockAgents.value = [makeAgent(handle)];
    const { getByTestId, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId(`agent-row-${handle}`));
    expect(getByTestId('agent-detail')).toBeTruthy();
    expect(queryByTestId('agent-delete-button')).toBeNull();
  });

  it('ignores a create that resolves after the space changed', async () => {
    let resolveCreate: (agent: SpaceAgent) => void = () => {};
    mockCreate.mockReturnValueOnce(
      new Promise<SpaceAgent>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const { getByTestId, queryByTestId, rerender } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Slow' } });
    fireEvent.submit(getByTestId('agent-form'));

    rerender(<SpaceAgentsPage spaceId="space-2" />);
    fireEvent.click(getByTestId('new-agent-button'));
    expect(getByTestId('agent-form')).toBeTruthy();

    resolveCreate(makeAgent('slow', { spaceId: 'space-1' }));
    await tick();

    expect(getByTestId('agent-form')).toBeTruthy();
    expect(queryByTestId('agent-detail')).toBeNull();
  });

  it('does not write a stale save error into the new space form', async () => {
    let rejectUpdate: (err: Error) => void = () => {};
    mockAgents.value = [makeAgent('alpha')];
    mockUpdate.mockReturnValueOnce(
      new Promise<SpaceAgent>((_resolve, reject) => {
        rejectUpdate = reject;
      })
    );
    const { getByTestId, getByText, queryByTestId, rerender } = render(
      <SpaceAgentsPage spaceId="space-1" />
    );

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Renamed' } });
    fireEvent.submit(getByTestId('agent-form'));

    mockAgents.value = [];
    rerender(<SpaceAgentsPage spaceId="space-2" />);
    fireEvent.click(getByTestId('new-agent-button'));
    expect(getByTestId('agent-form')).toBeTruthy();

    rejectUpdate(new Error('space-1 failure'));
    await tick();

    expect(getByTestId('agent-form')).toBeTruthy();
    expect(queryByTestId('agent-form-error')).toBeNull();
  });

  it('deletes after confirmation', async () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByTestId('agent-delete-button'));
    fireEvent.click(getByTestId('confirm-delete-agent'));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('alpha'));
  });

  it('keeps the dialog open and shows the error when delete fails', async () => {
    mockAgents.value = [makeAgent('alpha')];
    mockRemove.mockRejectedValue(new Error('nope'));
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByTestId('agent-delete-button'));
    fireEvent.click(getByTestId('confirm-delete-agent'));

    await waitFor(() => expect(getByText('nope')).toBeTruthy());
  });
});
