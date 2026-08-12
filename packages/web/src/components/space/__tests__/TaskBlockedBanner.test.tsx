/**
 * Unit tests for TaskBlockedBanner
 *
 * Tests:
 * - Renders fallback amber banner when blockReason is null
 * - Renders a minimal "reply via composer" hint for human_input_requested (full question renders in the thread)
 * - Renders execution_failed banner with Reopen and Cancel buttons
 * - Renders agent_crashed banner with Reopen and Cancel buttons
 * - Renders dependency_failed banner (informational)
 * - Renders workflow_invalid banner (informational)
 * - Reopen and Cancel buttons call onStatusTransition
 * - Shows result text when present
 * - Banner always shows even without result text
 */

import { describe, it, expect, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { SpaceTask } from '@hyperneo/shared';

import { TaskBlockedBanner } from '../TaskBlockedBanner';

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Test Task',
    description: '',
    status: 'blocked',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  } as SpaceTask;
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskBlockedBanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders fallback amber banner when blockReason is null', () => {
    const { getByTestId } = render(<TaskBlockedBanner task={makeTask()} spaceId="space-1" />);
    const banner = getByTestId('task-blocked-banner');
    // Tone is exposed via data-tone rather than a border class — the banner
    // composes the InlineStatusBanner primitive, so assertions target that
    // attribute instead of the legacy hand-rolled class string.
    expect(banner.getAttribute('data-tone')).toBe('amber');
    expect(banner.textContent).toContain('Blocked');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });

  it('renders a minimal "reply via composer" hint for human_input_requested', () => {
    // The full question renders in the thread; this banner is a safety net
    // that points the user to the composer in case the thread message is
    // missing. It must NOT duplicate the full question text.
    const task = makeTask({
      blockReason: 'human_input_requested',
      result: 'What color scheme do you prefer?',
    });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    const banner = getByTestId('task-blocked-banner');
    expect(banner.getAttribute('data-reason')).toBe('human_input_requested');
    expect(banner.textContent).toContain('composer');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
    // Deliberately not rendering task.result inside the banner.
    expect(banner.textContent).not.toContain('What color scheme');
  });

  it('renders execution_failed banner with Reopen and Cancel buttons', () => {
    const task = makeTask({
      blockReason: 'execution_failed',
      result: 'Process exited with code 1',
    });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    const banner = getByTestId('task-blocked-banner');
    expect(banner.getAttribute('data-tone')).toBe('red');
    expect(banner.textContent).toContain('Execution Failed');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });

  it('renders agent_crashed banner with Reopen and Cancel buttons', () => {
    const task = makeTask({ blockReason: 'agent_crashed' });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    const banner = getByTestId('task-blocked-banner');
    expect(banner.textContent).toContain('Agent Crashed');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });

  it('renders dependency_failed banner with Reopen and Cancel buttons', () => {
    const task = makeTask({ blockReason: 'dependency_failed' });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    const banner = getByTestId('task-blocked-banner');
    expect(banner.getAttribute('data-tone')).toBe('gray');
    expect(banner.textContent).toContain('Blocked by Dependency');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });

  it('renders workflow_invalid banner with Reopen and Cancel buttons', () => {
    const task = makeTask({ blockReason: 'workflow_invalid' });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    expect(getByTestId('task-blocked-banner').textContent).toContain('Invalid Workflow');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });

  it('Reopen and Cancel buttons call onStatusTransition', () => {
    const onTransition = vi.fn();
    const task = makeTask({ blockReason: 'execution_failed' });
    const { getByTestId } = render(
      <TaskBlockedBanner task={task} spaceId="space-1" onStatusTransition={onTransition} />
    );
    fireEvent.click(getByTestId('task-blocked-reopen-btn'));
    expect(onTransition).toHaveBeenCalledWith('in_progress');
    fireEvent.click(getByTestId('task-blocked-cancel-btn'));
    expect(onTransition).toHaveBeenCalledWith('cancelled');
  });

  it('shows result text when present', () => {
    const task = makeTask({ result: 'Something went wrong' });
    const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
    expect(getByTestId('task-blocked-message').textContent).toBe('Something went wrong');
  });

  it('banner renders even without result text', () => {
    const task = makeTask({ blockReason: 'execution_failed', result: null });
    const { getByTestId, queryByTestId } = render(
      <TaskBlockedBanner task={task} spaceId="space-1" />
    );
    expect(getByTestId('task-blocked-banner')).toBeTruthy();
    expect(queryByTestId('task-blocked-message')).toBeNull();
  });
});
