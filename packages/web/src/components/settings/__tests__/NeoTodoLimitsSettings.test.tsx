import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { updateGlobalSettings, toastError } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(async () => undefined),
  toastError: vi.fn(),
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal(null) }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../../../lib/toast.ts', () => ({ toast: { error: toastError } }));
import { NeoTodoLimitsSettings } from '../NeoTodoLimitsSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';

const neo = { standingRules: ['Keep PRs small'], packs: ['coding'] };

function settle(extra: Record<string, number> = {}) {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { ...neo, ...extra },
  } as GlobalSettings;
}

const input = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;

beforeEach(() => {
  updateGlobalSettings.mockClear();
  toastError.mockClear();
});
afterEach(cleanup);

test('unset limits show the defaults the queue uses, and opening writes nothing', () => {
  settle();
  render(<NeoTodoLimitsSettings />);
  expect(input('Running steps in total').value).toBe('6');
  expect(input('Running steps per project').value).toBe('3');
  expect(updateGlobalSettings).not.toHaveBeenCalled();
});

test('a new limit saves into Neo settings and keeps the other Neo fields', () => {
  settle({ maxRunningTodos: 4 });
  render(<NeoTodoLimitsSettings />);
  expect(input('Running steps in total').value).toBe('4');
  const perProject = input('Running steps per project');
  perProject.value = '2';
  fireEvent.change(perProject);
  expect(updateGlobalSettings).toHaveBeenCalledWith({
    neo: { ...neo, maxRunningTodos: 4, maxRunningTodosPerProject: 2 },
  });
});

test('zero or a fraction is refused and the field returns to the current limit', () => {
  settle({ maxRunningTodos: 4 });
  render(<NeoTodoLimitsSettings />);
  for (const bad of ['0', '2.5']) {
    const total = input('Running steps in total');
    total.value = bad;
    fireEvent.change(total);
    expect(total.value).toBe('4');
  }
  expect(updateGlobalSettings).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledTimes(2);
});
