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

  it.each(['space-manager', 'coordinator'])(
    'does not offer deletion for the protected %s agent',
    (handle) => {
      mockAgents.value = [makeAgent(handle)];
      const { getByTestId, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

      fireEvent.click(getByTestId(`agent-row-${handle}`));
      expect(getByTestId('agent-detail')).toBeTruthy();
      expect(queryByTestId('agent-delete-button')).toBeNull();
    }
  );

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

  it('ignores a create that resolves after the form was replaced in the same space', async () => {
    let resolveCreate: (agent: SpaceAgent) => void = () => {};
    mockCreate.mockReturnValueOnce(
      new Promise<SpaceAgent>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const { getByTestId, queryByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'First' } });
    fireEvent.submit(getByTestId('agent-form'));

    fireEvent.click(getByText('Cancel'));
    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Second' } });

    resolveCreate(makeAgent('first'));
    await tick();

    expect(getByTestId('agent-form')).toBeTruthy();
    expect(queryByTestId('agent-detail')).toBeNull();
  });

  it('does not write a replaced submission error into the current form', async () => {
    let rejectCreate: (err: Error) => void = () => {};
    mockCreate.mockReturnValueOnce(
      new Promise<SpaceAgent>((_resolve, reject) => {
        rejectCreate = reject;
      })
    );
    const { getByTestId, queryByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'First' } });
    fireEvent.submit(getByTestId('agent-form'));

    fireEvent.click(getByText('Cancel'));
    fireEvent.click(getByTestId('new-agent-button'));

    rejectCreate(new Error('first submission failed'));
    await tick();

    expect(getByTestId('agent-form')).toBeTruthy();
    expect(queryByTestId('agent-form-error')).toBeNull();
  });

  it('sends description and autonomy level when creating', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    fireEvent.input(getByTestId('agent-description-input'), { target: { value: 'Takes notes' } });
    const sel_agent_autonomy_select = getByTestId('agent-autonomy-select') as HTMLSelectElement;
    sel_agent_autonomy_select.value = '3';
    fireEvent.change(sel_agent_autonomy_select);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Takes notes', autonomyLevel: 3 })
      )
    );
  });

  it('omits an unset autonomy level rather than sending zero', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].autonomyLevel).toBeUndefined();
  });

  it('offers status only when editing, and sends the chosen value', async () => {
    mockAgents.value = [makeAgent('alpha', { status: 'active' })];
    const { getByTestId, getByText, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    expect(queryByTestId('agent-status-select')).toBeNull();
    fireEvent.click(getByText('Cancel'));

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    expect(getByTestId('agent-status-select')).toBeTruthy();
    const sel_agent_status_select = getByTestId('agent-status-select') as HTMLSelectElement;
    sel_agent_status_select.value = 'paused';
    fireEvent.change(sel_agent_status_select);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        'alpha',
        expect.objectContaining({ status: 'paused' })
      )
    );
  });

  it('does not offer archived as an editable status', async () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));

    const options = [...getByTestId('agent-status-select').querySelectorAll('option')].map(
      (option) => option.value
    );
    expect(options).toEqual(['active', 'paused', 'disabled']);
  });

  it('offers protected agents only the active status', async () => {
    mockAgents.value = [makeAgent('space-manager')];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-space-manager'));
    fireEvent.click(getByText('Edit'));

    const options = [...getByTestId('agent-status-select').querySelectorAll('option')].map(
      (option) => option.value
    );
    expect(options).toEqual(['active']);
  });

  it('separates template default from an explicit unset autonomy on create', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    const options = [...getByTestId('agent-autonomy-select').querySelectorAll('option')].map(
      (option) => option.value
    );
    expect(options).toEqual(['', 'none', '1', '2', '3', '4', '5']);

    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    const sel_agent_autonomy_select = getByTestId('agent-autonomy-select') as HTMLSelectElement;
    sel_agent_autonomy_select.value = 'none';
    fireEvent.change(sel_agent_autonomy_select);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].autonomyLevel).toBeNull();
  });

  it('offers only a plain unset autonomy option when editing', async () => {
    mockAgents.value = [makeAgent('alpha', { autonomyLevel: 3 })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));

    const options = [...getByTestId('agent-autonomy-select').querySelectorAll('option')].map(
      (option) => option.value
    );
    expect(options).toEqual(['', '1', '2', '3', '4', '5']);

    const sel_agent_autonomy_select = getByTestId('agent-autonomy-select') as HTMLSelectElement;
    sel_agent_autonomy_select.value = '';
    fireEvent.change(sel_agent_autonomy_select);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        'alpha',
        expect.objectContaining({ autonomyLevel: null })
      )
    );
  });

  it('preselects the stored status when opening the editor', async () => {
    mockAgents.value = [makeAgent('alpha', { status: 'disabled' })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));

    expect((getByTestId('agent-status-select') as HTMLSelectElement).value).toBe('disabled');
  });

  it('does not silently reactivate a paused agent on an unrelated edit', async () => {
    mockAgents.value = [makeAgent('alpha', { status: 'paused' })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.input(getByTestId('agent-description-input'), { target: { value: 'note' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].status).toBe('paused');
  });

  it('preselects the stored autonomy level when opening the editor', async () => {
    mockAgents.value = [makeAgent('alpha', { autonomyLevel: 4 })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));

    expect((getByTestId('agent-autonomy-select') as HTMLSelectElement).value).toBe('4');
  });

  it('preselects unset autonomy when the agent has none', async () => {
    mockAgents.value = [makeAgent('alpha', { autonomyLevel: null })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));

    expect((getByTestId('agent-autonomy-select') as HTMLSelectElement).value).toBe('');
  });

  it('offers a model pool with no single-model mode toggle', async () => {
    const { getByTestId, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    expect(getByTestId('agent-model-pool-field')).toBeTruthy();
    expect(queryByTestId('agent-model-mode-single')).toBeNull();
    expect(queryByTestId('agent-model-mode-pool')).toBeNull();
  });

  it('seeds the pool from an agent that still has a single model', async () => {
    mockAgents.value = [makeAgent('alpha', { model: 'claude-opus-5', provider: 'anthropic' })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].modelPool).toEqual([
      { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('prefers an existing pool over the single model field', async () => {
    mockAgents.value = [
      makeAgent('alpha', {
        model: 'claude-opus-5',
        modelPool: [{ model: 'claude-sonnet-5', maxConcurrent: 2, weight: 60 }],
      }),
    ];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].modelPool).toEqual([
      { model: 'claude-sonnet-5', maxConcurrent: 2, weight: 60 },
    ]);
  });

  it('clears model and provider on save so the pool is authoritative', async () => {
    mockAgents.value = [makeAgent('alpha', { model: 'claude-opus-5', provider: 'anthropic' })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].model).toBeNull();
    expect(mockUpdate.mock.calls[0][1].provider).toBeNull();
  });

  it('sends a null pool when every entry is removed', async () => {
    mockAgents.value = [makeAgent('alpha')];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].modelPool).toBeNull();
  });

  it('omits the pool on create when none was configured', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].modelPool).toBeUndefined();
  });

  it('omits tools on create when defaults are inherited', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    expect(getByTestId('agent-tools-field')).toBeTruthy();
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].tools).toBeUndefined();
  });

  it('sends the chosen tools when a preset overrides the defaults', async () => {
    const { getByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Reader' } });
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('shows an agent as inheriting tools when it stores null', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: null })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tools).toBeNull();
  });

  it('round-trips a stored tool override on edit', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: ['Read', 'Grep', 'Glob'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('clears a tool override back to inherited', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: ['Read'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.click(getByTestId('tools-editor-preset-inherit-defaults'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tools).toBeNull();
  });

  it('keeps scoped Bash entries when a preset is applied', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: ['Read', 'Bash(gh pr view:*)'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash(gh pr view:*)',
    ]);
  });

  it('drops scoped entries when the override is cleared to inherited', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: ['Read', 'Bash(gh pr view:*)'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.click(getByTestId('tools-editor-preset-inherit-defaults'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tools).toBeNull();
  });

  it('does not accumulate duplicates when presets are switched repeatedly', async () => {
    mockAgents.value = [makeAgent('alpha', { tools: ['Read', 'Bash(ls:*)'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(getByTestId('tools-editor-preset-custom'));
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const sent = mockUpdate.mock.calls[0][1].tools as string[];
    expect(sent.filter((tool) => tool === 'Bash(ls:*)')).toHaveLength(1);
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('omits setting sources on create while inherited', async () => {
    const { getByTestId, queryByTestId } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    expect(getByTestId('agent-setting-sources-field')).toBeTruthy();
    expect(queryByTestId('agent-setting-sources-reset')).toBeNull();
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0].settingSources).toBeUndefined();
  });

  it('sends an override once a source is toggled', async () => {
    const { getByTestId, getByLabelText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('new-agent-button'));
    fireEvent.input(getByTestId('agent-name-input'), { target: { value: 'Scribe' } });
    const field = getByTestId('agent-setting-sources-field');
    const boxes = [...field.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    fireEvent.click(boxes[0]);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(Array.isArray(mockCreate.mock.calls[0][0].settingSources)).toBe(true);
    expect(mockCreate.mock.calls[0][0].settingSources).not.toContain('user');
  });

  it('shows an agent with stored sources as overridden and round-trips them', async () => {
    mockAgents.value = [makeAgent('alpha', { settingSources: ['project'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    expect(getByTestId('agent-setting-sources-reset')).toBeTruthy();
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].settingSources).toEqual(['project']);
  });

  it('resets an override back to inherited', async () => {
    mockAgents.value = [makeAgent('alpha', { settingSources: ['project'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.click(getByTestId('agent-setting-sources-reset'));
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].settingSources).toBeNull();
  });

  it('keeps an empty override distinct from inherited', async () => {
    mockAgents.value = [makeAgent('alpha', { settingSources: ['project'] })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    const field = getByTestId('agent-setting-sources-field');
    const checked = [...field.querySelectorAll('input[type="checkbox"]')].filter(
      (box) => (box as HTMLInputElement).checked
    ) as HTMLInputElement[];
    for (const box of checked) fireEvent.click(box);
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].settingSources).toEqual([]);
  });

  it('clears a description on edit rather than dropping the field', async () => {
    mockAgents.value = [makeAgent('alpha', { description: 'old' })];
    const { getByTestId, getByText } = render(<SpaceAgentsPage spaceId="space-1" />);

    fireEvent.click(getByTestId('agent-row-alpha'));
    fireEvent.click(getByText('Edit'));
    fireEvent.input(getByTestId('agent-description-input'), { target: { value: '' } });
    fireEvent.submit(getByTestId('agent-form'));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        'alpha',
        expect.objectContaining({ description: null })
      )
    );
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
