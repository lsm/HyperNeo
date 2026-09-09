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
  mockTemplates,
} = vi.hoisted(() => ({
  mockAgents: { value: [] as SpaceAgent[] },
  mockLoading: { value: false },
  mockError: { value: null as string | null },
  mockSelectSpace: vi.fn().mockResolvedValue(undefined),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockTemplates: { value: [] as Array<{ key: string; displayName: string }> },
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
  },
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { agentTemplates: mockTemplates },
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
  });

  it('selects the space on mount', () => {
    render(<SpaceAgentsPage spaceId="space-1" />);
    expect(mockSelectSpace).toHaveBeenCalledWith('space-1');
  });

  it('shows an empty state when there are no agents', () => {
    const { getByText } = render(<SpaceAgentsPage spaceId="space-1" />);
    expect(getByText('No agents yet')).toBeTruthy();
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
