// @ts-nocheck
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    fetchTaskGroup: vi.fn(),
    updateTask: vi.fn(),
  },
}));

import { TaskGroupPagination } from '../SpaceTasks';

afterEach(() => {
  cleanup();
});

describe('TaskGroupPagination', () => {
  it('renders "Showing 1–10 of 25" on the first page', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={0}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect(getByTestId('task-group-range').textContent).toBe('Showing 1–10 of 25');
  });

  it('renders the correct range on a middle page', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={10}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect(getByTestId('task-group-range').textContent).toBe('Showing 11–20 of 25');
  });

  it('renders the correct range on the last (partial) page', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={20}
        limit={10}
        total={25}
        pageSize={5}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect(getByTestId('task-group-range').textContent).toBe('Showing 21–25 of 25');
  });

  it('renders "Showing 0–0 of 0" when there are no results', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={0}
        limit={10}
        total={0}
        pageSize={0}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect(getByTestId('task-group-range').textContent).toBe('Showing 0–0 of 0');
  });

  it('disables the Prev button at offset=0', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={0}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect((getByTestId('task-group-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('task-group-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables Prev when offset > 0', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={10}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect((getByTestId('task-group-prev') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Next when offset + limit >= total', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={20}
        limit={10}
        total={25}
        pageSize={5}
        onPrev={() => {}}
        onNext={() => {}}
      />
    );
    expect((getByTestId('task-group-next') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('task-group-prev') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables both buttons when isLoading=true', () => {
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={10}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={() => {}}
        isLoading
      />
    );
    expect((getByTestId('task-group-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('task-group-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('invokes onPrev when Prev is clicked', () => {
    const onPrev = vi.fn();
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={10}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={onPrev}
        onNext={() => {}}
      />
    );
    fireEvent.click(getByTestId('task-group-prev'));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('invokes onNext when Next is clicked', () => {
    const onNext = vi.fn();
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={0}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={() => {}}
        onNext={onNext}
      />
    );
    fireEvent.click(getByTestId('task-group-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onPrev when the disabled Prev button is clicked', () => {
    const onPrev = vi.fn();
    const { getByTestId } = render(
      <TaskGroupPagination
        offset={0}
        limit={10}
        total={25}
        pageSize={10}
        onPrev={onPrev}
        onNext={() => {}}
      />
    );
    fireEvent.click(getByTestId('task-group-prev'));
    expect(onPrev).not.toHaveBeenCalled();
  });
});
