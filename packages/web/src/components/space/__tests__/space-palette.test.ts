import { afterEach, describe, expect, it, vi } from 'vitest';

const { navigateToSpace, navigateToSpaceTask } = vi.hoisted(() => ({
  navigateToSpace: vi.fn(),
  navigateToSpaceTask: vi.fn(),
}));

vi.mock('../../../lib/space-router.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../lib/router.ts')),
}));
vi.mock('../../../lib/router.ts', () => ({ navigateToSpace, navigateToSpaceTask }));

import { openSpaceSearchResult, spacePaletteItems, warmSpacePalette } from '../space-palette';
import { registerWebExtension, type SpaceWebExtension } from '../../../lib/web-extensions';

const task = { id: 'task-1', title: 'Ship docs', description: '', taskNumber: 7, updatedAt: 2 };
const space = {
  id: 'space-1',
  slug: 'alpha',
  name: 'Alpha',
  description: '',
  workspacePath: '/work/alpha',
  status: 'active',
  updatedAt: 1,
  tasks: [task],
};
const initGlobalList = vi.fn(async () => {});

function loadSpaces(spaces: unknown[]) {
  registerWebExtension('space', {
    store: { spacesWithTasks: { value: spaces }, initGlobalList },
  } as unknown as SpaceWebExtension);
}

describe('spacePaletteItems', () => {
  afterEach(() => {
    registerWebExtension('space', null);
    vi.clearAllMocks();
  });

  it('lists nothing when Space is off', () => {
    registerWebExtension('space', null);

    expect(spacePaletteItems('alpha')).toEqual([]);
  });

  it('finds a Space and a task, and opens each', () => {
    loadSpaces([space]);

    const [spaceItem] = spacePaletteItems('alpha');
    const [taskItem] = spacePaletteItems('ship');
    spaceItem.open();
    taskItem.open();

    expect(spaceItem).toMatchObject({ group: 'spaces', title: 'Alpha', subtitle: 'alpha' });
    expect(taskItem).toMatchObject({ group: 'tasks', subtitle: 'Alpha · Task #7' });
    expect(navigateToSpace).toHaveBeenCalledWith('alpha');
    expect(navigateToSpaceTask).toHaveBeenCalledWith('alpha', 'task-1');
  });

  it('leaves out archived Spaces', () => {
    loadSpaces([{ ...space, status: 'archived', tasks: [] }]);

    expect(spacePaletteItems('')).toEqual([]);
  });
});

describe('warmSpacePalette', () => {
  afterEach(() => {
    registerWebExtension('space', null);
    vi.clearAllMocks();
  });

  it('loads the Space list', () => {
    loadSpaces([]);

    warmSpacePalette();

    expect(initGlobalList).toHaveBeenCalled();
  });
});

describe('openSpaceSearchResult', () => {
  afterEach(() => vi.clearAllMocks());

  it('opens a task result that names its Space', () => {
    expect(openSpaceSearchResult({ taskId: 'task-1', spaceId: 'alpha' })).toBe(true);
    expect(navigateToSpaceTask).toHaveBeenCalledWith('alpha', 'task-1');
  });

  it('declines a result with no Space', () => {
    expect(openSpaceSearchResult({ taskId: 'task-1' })).toBe(false);
    expect(navigateToSpaceTask).not.toHaveBeenCalled();
  });
});
