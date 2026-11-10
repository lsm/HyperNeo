import { afterEach, describe, expect, it, vi } from 'vitest';

const { navigateToSpaceTasks, error } = vi.hoisted(() => ({
  navigateToSpaceTasks: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../space-router.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../router.ts')),
}));
vi.mock('../router.ts', () => ({ navigateToSpaceTasks }));
vi.mock('../toast.ts', () => ({ toast: { error } }));

import { commandPaletteOpenSignal } from '../signals';
import { currentSpaceIdSignal } from '../space-signals';
import { SPACE_COMMANDS } from '../space-commands';

const viewTasks = SPACE_COMMANDS.find((command) => command.id === 'space.tasks')!;

describe('SPACE_COMMANDS', () => {
  afterEach(() => {
    currentSpaceIdSignal.value = null;
    commandPaletteOpenSignal.value = false;
    vi.clearAllMocks();
  });

  it('all belong to the Space extension', () => {
    expect(SPACE_COMMANDS.every((command) => command.extension === 'space')).toBe(true);
  });

  it('asks for a Space and leaves the palette open when none is open', () => {
    commandPaletteOpenSignal.value = true;

    void viewTasks.run();

    expect(error).toHaveBeenCalledWith('Open a space first');
    expect(commandPaletteOpenSignal.value).toBe(true);
    expect(navigateToSpaceTasks).not.toHaveBeenCalled();
  });

  it('closes the palette and opens the current Space', () => {
    commandPaletteOpenSignal.value = true;
    currentSpaceIdSignal.value = 'space-1';

    void viewTasks.run();

    expect(commandPaletteOpenSignal.value).toBe(false);
    expect(navigateToSpaceTasks).toHaveBeenCalledWith('space-1');
  });
});
