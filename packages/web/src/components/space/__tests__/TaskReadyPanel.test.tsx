import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockWorkflows, mockTasks, setPreferredWorkflow } = vi.hoisted(() => ({
  mockWorkflows: { value: [] as SpaceWorkflow[] },
  mockTasks: { value: [] as SpaceTask[] },
  setPreferredWorkflow: vi.fn(async () => ({})),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { workflows: mockWorkflows, tasks: mockTasks, setPreferredWorkflow },
}));

import { TaskReadyPanel } from '../TaskReadyPanel';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 2,
    title: 'Document the loader',
    description: '',
    status: 'open',
    priority: 'normal',
    dependsOn: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SpaceTask;
}

const coding = { id: 'wf-1', name: 'Coding', nodes: [] } as unknown as SpaceWorkflow;

function renderPanel(task: SpaceTask, canRunDirectly = true) {
  const handlers = { onRun: vi.fn(), onPublish: vi.fn(), onEdit: vi.fn() };
  const view = render(
    <TaskReadyPanel
      task={task}
      workspaceLabel="Docs"
      description="Add a README section for readConfig."
      canRunDirectly={canRunDirectly}
      busy={false}
      {...handlers}
    />
  );
  return { ...view, handlers };
}

describe('TaskReadyPanel', () => {
  afterEach(() => {
    cleanup();
    mockWorkflows.value = [];
    mockTasks.value = [];
    setPreferredWorkflow.mockClear();
  });

  it('makes Run the main action when the Space has no workflows', () => {
    const { getByTestId, handlers } = renderPanel(makeTask());
    expect(getByTestId('task-ready-title').textContent).toBe('Ready to run');
    expect(getByTestId('task-ready-description').textContent).toBe(
      'Add a README section for readConfig.'
    );
    fireEvent.click(getByTestId('task-run-button'));
    expect(handlers.onRun).toHaveBeenCalled();
  });

  it('explains the automatic start and offers Run without a workflow when workflows exist', () => {
    mockWorkflows.value = [coding];
    const { getByTestId, getByText } = renderPanel(makeTask({ preferredWorkflowId: 'wf-1' }));
    expect(getByTestId('task-ready-title').textContent).toBe('Starting soon');
    expect(getByText('Starts with Coding when a task slot is free.')).toBeTruthy();
    expect(getByTestId('task-run-button').textContent).toBe('Run without a workflow');
  });

  it('lists the tasks it waits on and says it starts once they are done', () => {
    mockWorkflows.value = [coding];
    mockTasks.value = [
      makeTask({ id: 'dep-1', taskNumber: 1, title: 'Rename the loader', status: 'draft' }),
    ];
    const { getByTestId, getByText } = renderPanel(makeTask({ dependsOn: ['dep-1'] }));
    expect(getByTestId('task-ready-title').textContent).toBe('Waiting');
    expect(getByTestId('task-dependencies').textContent).toContain('Rename the loader');
    expect(
      getByText('Starts with the best-matching workflow once the tasks it waits on are done.')
    ).toBeTruthy();
  });

  it('offers Publish for a draft and no Run', () => {
    const { getByTestId, queryByTestId, handlers } = renderPanel(
      makeTask({ status: 'draft' }),
      false
    );
    expect(getByTestId('task-ready-title').textContent).toBe('Draft');
    expect(queryByTestId('task-run-button')).toBeNull();
    fireEvent.click(getByTestId('task-publish-button'));
    expect(handlers.onPublish).toHaveBeenCalled();
  });

  it('saves a new preferred workflow and shows a failure', async () => {
    mockWorkflows.value = [coding];
    setPreferredWorkflow.mockRejectedValueOnce(new Error('Workflow is disabled'));
    const { getByTestId, findByTestId } = renderPanel(makeTask());
    fireEvent.change(getByTestId('task-workflow-select'), { target: { value: 'wf-1' } });

    await waitFor(() => expect(setPreferredWorkflow).toHaveBeenCalledWith('task-1', 'wf-1'));
    expect((await findByTestId('task-workflow-error')).textContent).toBe('Workflow is disabled');
  });
});
