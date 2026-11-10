import { describe, expect, test } from 'bun:test';
import { planNeoWorkerName } from '../../../../src/lib/neo/worker-name.ts';
import { createWorkerNameSource } from '../../../../src/lib/drivers/worker-names.ts';
import type { WorkAdapter, WorkSummary } from '../../../../src/lib/drivers/types.ts';

const place = { machine: 'synthetic', folder: '/projects/HyperNeo', name: 'Project' };
describe('planNeoWorkerName', () => {
  test.each([
    ['codex-desktop', 'Codex'],
    ['claude-desktop', 'Claude Code'],
    ['claude-code', 'Claude Code'],
    ['hyperneo', 'HyperNeo'],
  ])('names %s after the project', (adapter, label) => {
    expect(planNeoWorkerName(adapter, place, [])).toBe(`${label} hyperneo 1`);
  });
  test('numbers skip names already taken and use the smallest free number', () => {
    expect(
      planNeoWorkerName('codex-desktop', place, [
        'Codex hyperneo 1',
        'Codex hyperneo 3',
        'Claude Code hyperneo 2',
      ])
    ).toBe('Codex hyperneo 2');
  });
  test('prefers the repository name to a worktree folder', () => {
    expect(
      planNeoWorkerName(
        'codex-desktop',
        { ...place, repoName: 'Research', folder: '/worktrees/abc' },
        []
      )
    ).toBe('Codex research 1');
    expect(
      planNeoWorkerName(
        'codex-desktop',
        { ...place, remotes: ['git@github.com:example/Research.git'] },
        []
      )
    ).toBe('Codex research 1');
  });
});

test('reads complete same-adapter/place names while leaving other places and stopped workers out', async () => {
  const worker = (title: string, patch: Partial<WorkSummary> = {}): WorkSummary => ({
    ref: { adapter: 'codex-desktop', id: title },
    title,
    place,
    status: 'running',
    lastActivityAt: 1,
    ...patch,
  });
  let all: true | undefined;
  const work = [
    ...Array.from({ length: 25 }, (_, i) => worker(`Codex hyperneo ${i + 1}`)),
    worker('stopped', { status: 'stopped' }),
    worker('elsewhere', { place: { ...place, folder: '/another/project' } }),
    worker('other engine', { ref: { adapter: 'hyperneo', id: 'other' } }),
  ];
  const adapter: WorkAdapter = {
    id: 'codex-desktop',
    capabilities: ['find'],
    find: (query) => {
      all = query.all;
      return [
        {
          place,
          work,
          adapters: ['codex-desktop'],
          openCount: work.length,
          archivedCount: 0,
          lastActivityAt: 1,
        },
      ];
    },
  };
  const read = createWorkerNameSource(() => [adapter], place);
  const naming = await read('codex-desktop');
  expect(all).toBe(true);
  expect(naming.taken).toHaveLength(25);
  expect(planNeoWorkerName('codex-desktop', naming.place, naming.taken)).toBe('Codex hyperneo 26');
});
