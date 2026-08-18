// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockCreateTask = vi.fn();
const mockCreateSchedule = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    get createTask() {
      return mockCreateTask;
    },
    get createSchedule() {
      return mockCreateSchedule;
    },
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    get success() {
      return mockToastSuccess;
    },
    get error() {
      return mockToastError;
    },
  },
}));

vi.mock('../../ui/Modal', () => ({
  Modal: ({ isOpen, children, title, onClose }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label={title}>
        <button onClick={onClose} aria-label="Close modal">
          X
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick, type, loading, disabled }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

import { SpaceCreateTaskDialog } from '../SpaceCreateTaskDialog';

const TASK_MOCK = {
  id: 'task-1',
  spaceId: 'space-1',
  title: 'Test task',
  description: '',
  status: 'open',
  priority: 'normal',
  taskType: 'coding',
  dependsOn: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const SCHEDULE_MOCK = {
  id: 'sched-1',
  spaceId: 'space-1',
  title: 'Scheduled task',
  description: '',
  priority: 'normal',
  triggerType: 'cron',
  cronExpression: '@daily',
  runAt: null,
  timezone: 'UTC',
  status: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('SpaceCreateTaskDialog', () => {
  let onClose;
  let onCreated;

  beforeEach(() => {
    cleanup();
    onClose = vi.fn();
    onCreated = vi.fn();
    mockCreateTask.mockReset();
    mockCreateSchedule.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<SpaceCreateTaskDialog isOpen={false} onClose={onClose} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders dialog when isOpen is true', () => {
    const { getByRole } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
    expect(getByRole('dialog')).toBeTruthy();
  });

  it('shows title required indicator', () => {
    const { getByText } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
    expect(getByText('Title')).toBeTruthy();
    expect(getByText('*')).toBeTruthy();
  });

  it('shows validation error when title is empty', async () => {
    const { getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form);
    expect(await findByText('Task title is required')).toBeTruthy();
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('calls spaceStore.createTask with correct params on submit', async () => {
    mockCreateTask.mockResolvedValue(TASK_MOCK);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} onCreated={onCreated} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My new task' },
    });

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(mockCreateTask).toHaveBeenCalledWith({
        title: 'My new task',
        description: '',
        priority: 'normal',
      });
    });
  });

  it('calls onCreated and closes on success', async () => {
    mockCreateTask.mockResolvedValue(TASK_MOCK);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} onCreated={onCreated} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My task' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(TASK_MOCK);
      expect(onClose).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Test task'));
    });
  });

  it('shows error message when createTask fails', async () => {
    mockCreateTask.mockRejectedValue(new Error('Server error'));

    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'Failing task' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form'));

    expect(await findByText('Server error')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows error when no space is selected (createTask throws)', async () => {
    mockCreateTask.mockRejectedValue(new Error('No space selected'));

    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My task' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form'));

    expect(await findByText('No space selected')).toBeTruthy();
  });

  it('calls onClose when Cancel is clicked', () => {
    const { getByText } = render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('sends correct priority when changed', async () => {
    mockCreateTask.mockResolvedValue(TASK_MOCK);

    const { getByPlaceholderText, getByRole, getAllByRole } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'Urgent task' },
    });

    const selects = getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'urgent' } });

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'urgent',
        })
      );
    });
  });

  it('shows schedule options when toggle is checked', () => {
    const { getByLabelText, getByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    const toggle = getByLabelText('Schedule this task');
    fireEvent.click(toggle);
    expect(getByText('One-time')).toBeTruthy();
    expect(getByText('Recurring')).toBeTruthy();
  });

  it('hides schedule options when toggle is unchecked', () => {
    const { getByLabelText, queryByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    const toggle = getByLabelText('Schedule this task');
    fireEvent.click(toggle);
    expect(queryByText('One-time')).toBeTruthy();
    fireEvent.click(toggle);
    expect(queryByText('One-time')).toBeNull();
  });

  it('shows runAt input for one-time trigger', () => {
    const { getByLabelText, getByText, container } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('One-time'));
    expect(container.querySelector('input[type="datetime-local"]')).toBeTruthy();
  });

  it('shows cron input for recurring trigger', () => {
    const { getByLabelText, getByText, getByPlaceholderText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    expect(getByPlaceholderText('0 9 * * 1')).toBeTruthy();
  });

  it('shows validation error when one-time runAt is missing', async () => {
    const { getByLabelText, getByText, getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('One-time'));
    fireEvent.submit(getByRole('dialog').querySelector('form'));
    expect(await findByText('Run date/time is required')).toBeTruthy();
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it('shows validation error when one-time runAt is in the past', async () => {
    const { getByLabelText, getByText, getByPlaceholderText, getByRole, findByText, container } =
      render(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('One-time'));

    const dtInput = container.querySelector('input[type="datetime-local"]');
    const past = new Date(Date.now() - 172800000);
    const pad = (n) => String(n).padStart(2, '0');
    const pastValue = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
    fireEvent.input(dtInput, { target: { value: pastValue } });

    fireEvent.submit(getByRole('dialog').querySelector('form'));
    expect(await findByText('Run time must be in the future')).toBeTruthy();
  });

  it('shows validation error when cron expression is empty', async () => {
    const { getByLabelText, getByText, getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.submit(getByRole('dialog').querySelector('form'));
    expect(await findByText('Cron expression is required')).toBeTruthy();
  });

  it('shows validation error when cron expression is invalid', async () => {
    const { getByLabelText, getByText, getByPlaceholderText, getByRole, findAllByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.input(getByPlaceholderText('0 9 * * 1'), {
      target: { value: 'not-a-cron' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form'));
    const errors = await findAllByText('Invalid cron expression');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts @daily preset as valid cron', async () => {
    mockCreateSchedule.mockResolvedValue(SCHEDULE_MOCK);

    const { getByLabelText, getByText, getByPlaceholderText, getByRole } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.click(getByText('@daily'));

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My scheduled task',
          triggerType: 'cron',
          cronExpression: '@daily',
        })
      );
    });
  });

  it('calls spaceStore.createSchedule for one-time schedule', async () => {
    mockCreateSchedule.mockResolvedValue({
      ...SCHEDULE_MOCK,
      triggerType: 'at',
      runAt: Date.now() + 3600000,
    });

    const { getByLabelText, getByText, getByPlaceholderText, getByRole, container } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('One-time'));

    const dtInput = container.querySelector('input[type="datetime-local"]');
    const future = new Date(Date.now() + 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    const futureValue = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    fireEvent.input(dtInput, { target: { value: futureValue } });

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My scheduled task',
          triggerType: 'at',
          cronExpression: null,
        })
      );
    });
  });

  it('shows success toast after creating schedule', async () => {
    mockCreateSchedule.mockResolvedValue(SCHEDULE_MOCK);

    const { getByLabelText, getByText, getByPlaceholderText, getByRole } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.click(getByText('@daily'));

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Scheduled task'));
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error when createSchedule fails', async () => {
    mockCreateSchedule.mockRejectedValue(new Error('Schedule conflict'));

    const { getByLabelText, getByText, getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.input(getByPlaceholderText('e.g., Implement authentication module'), {
      target: { value: 'My scheduled task' },
    });
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.click(getByText('@daily'));

    fireEvent.submit(getByRole('dialog').querySelector('form'));

    expect(await findByText('Schedule conflict')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('button label changes to Create Schedule when scheduling enabled', () => {
    const { getByLabelText, getByText } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    expect(getByText('Create Task')).toBeTruthy();
    fireEvent.click(getByLabelText('Schedule this task'));
    expect(getByText('Create Schedule')).toBeTruthy();
  });

  it('resets schedule state when dialog is closed and reopened', () => {
    const { getByLabelText, getByText, queryByText, rerender } = render(
      <SpaceCreateTaskDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.click(getByLabelText('Schedule this task'));
    fireEvent.click(getByText('Recurring'));
    fireEvent.click(getByText('@daily'));
    expect(getByText('Create Schedule')).toBeTruthy();
    expect(queryByText('Cron expression')).toBeTruthy();

    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();

    rerender(<SpaceCreateTaskDialog isOpen={true} onClose={onClose} />);

    expect(getByText('Create Task')).toBeTruthy();
    expect(queryByText('Cron expression')).toBeNull();
    expect(queryByText('Schedule this task')).toBeTruthy();
  });
});
