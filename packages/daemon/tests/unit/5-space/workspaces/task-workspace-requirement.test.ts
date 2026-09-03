import { describe, expect, test } from 'bun:test';
import {
  isExplicitWorkspaceSelection,
  requireTaskWorkspaceSelection,
} from '../../../../src/lib/space/workspaces/task-workspace-requirement.ts';

type Row = { path: string; label: string | null; isPrimary: boolean };

function makeStores(
  primaryPath: string | null,
  rows: Row[]
): {
  spaces: { getSpace: () => { workspacePath: string } | null };
  workspaces: { listBySpace: () => Row[] };
} {
  return {
    spaces: { getSpace: () => (primaryPath ? { workspacePath: primaryPath } : null) },
    workspaces: { listBySpace: () => rows },
  };
}

describe('requireTaskWorkspaceSelection', () => {
  test('passes with a single registered workspace and no explicit selection', async () => {
    const stores = makeStores('/primary', [{ path: '/primary', label: '', isPrimary: true }]);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-1',
        hasExplicitSelection: false,
      })
    ).resolves.toBeUndefined();
  });

  test('passes with no rows and only the implicit primary', async () => {
    const stores = makeStores('/primary', []);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-1',
        hasExplicitSelection: false,
      })
    ).resolves.toBeUndefined();
  });

  test('passes with multiple workspaces when an explicit selection is provided', async () => {
    const stores = makeStores('/primary', [
      { path: '/primary', label: '', isPrimary: true },
      { path: '/docs', label: 'docs', isPrimary: false },
    ]);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-1',
        hasExplicitSelection: true,
      })
    ).resolves.toBeUndefined();
  });

  test('rejects with the registered list when multiple workspaces exist and none is selected', async () => {
    const stores = makeStores('/primary', [
      { path: '/primary', label: '', isPrimary: true },
      { path: '/docs', label: 'docs', isPrimary: false },
    ]);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-1',
        hasExplicitSelection: false,
      })
    ).rejects.toThrow(
      'Space space-1 has multiple registered workspaces; a task workspace is required. ' +
        'Registered workspaces: (/primary) (primary), "docs" (/docs). ' +
        'Pass workspace (label or path) when creating or updating the task, pin the goal (update_goal workspace_path), or set the schedule workspace.'
    );
  });

  test('appends the implicit primary when rows seed only secondaries', async () => {
    const stores = makeStores('/primary', [{ path: '/docs', label: 'docs', isPrimary: false }]);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-1',
        hasExplicitSelection: false,
      })
    ).rejects.toThrow('(/primary) (primary), "docs" (/docs)');
  });

  test('throws when the space is missing', async () => {
    const stores = makeStores(null, []);
    await expect(
      requireTaskWorkspaceSelection({
        ...stores,
        spaceId: 'space-gone',
        hasExplicitSelection: false,
      })
    ).rejects.toThrow('Space not found: space-gone');
  });
});

describe('isExplicitWorkspaceSelection', () => {
  test('accepts non-empty strings only', () => {
    expect(isExplicitWorkspaceSelection('/docs')).toBe(true);
    expect(isExplicitWorkspaceSelection('docs')).toBe(true);
    expect(isExplicitWorkspaceSelection('')).toBe(false);
    expect(isExplicitWorkspaceSelection('   ')).toBe(false);
    expect(isExplicitWorkspaceSelection(null)).toBe(false);
    expect(isExplicitWorkspaceSelection(undefined)).toBe(false);
  });
});
