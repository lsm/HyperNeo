import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { packWorkerStartFixture } from '../../helpers/pack-worker-start.ts';
import { describe, expect, spyOn, test } from 'bun:test';
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
  test('preserves .git in explicit repository and folder names', () => {
    expect(planNeoWorkerName('codex-desktop', { ...place, repoName: 'Notes.git' }, [])).toBe(
      'Codex notes.git 1'
    );
    expect(
      planNeoWorkerName('codex-desktop', { ...place, folder: '/projects/Notes.git' }, [])
    ).toBe('Codex notes.git 1');
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

test('direct and queue-driven starts share one naming lane for a default place', async () => {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const entered = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const titles: string[] = [];
  const visible: WorkSummary[] = [];
  let starts = 0;
  const adapter: WorkAdapter = {
    id: 'fixture',
    capabilities: ['find'],
    find: () => [
      {
        place,
        work: visible,
        adapters: ['fixture'],
        openCount: visible.length,
        archivedCount: 0,
        lastActivityAt: 1,
      },
    ],
  };
  const world = packWorkerStartFixture(db, {
    workerNames: createWorkerNameSource(() => [adapter], place),
    beforeStart: (todo) => {
      if (todo.title === 'Queued') queued.resolve();
    },
    invoke: async (name, input) => {
      if (name !== 'work.start') throw new Error(name);
      const id = `worker-${++starts}`;
      const title = String(input.title);
      titles.push(title);
      if (starts === 1) {
        entered.resolve();
        await release.promise;
      }
      const worker: WorkSummary = {
        ref: { adapter: 'fixture', id },
        place,
        title,
        status: 'running',
        lastActivityAt: 1,
      };
      visible.push(worker);
      return { kind: 'completed', value: { ok: true, value: worker } };
    },
  });
  let direct: Promise<unknown> | undefined;
  let fill: Promise<unknown> | undefined;
  try {
    await world.open();
    const askId = world.store.listOpenAsks()[0]!.id;
    const add = (id: string, title: string) => {
      const todo = world.store.addTodo(
        id,
        askId,
        {
          title,
          instruction: `Run the ${id} task.`,
          named: null,
          check: { pack: 'fixture', kind: 'result', params: {} },
          doneWhen: 'Synthetic result recorded',
          approvedAt: Date.now(),
          dependsOn: [],
        },
        Date.now()
      );
      world.sessions.create(todo.id, { verb: 'start', adapter: 'fixture', place });
      return todo;
    };
    direct = world.runner.start(add('direct', 'Direct').id);
    await entered.promise;
    add('queued', 'Queued');
    fill = world.runner.fill();
    await queued.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    await Promise.all([direct, fill]);
    expect(titles).toEqual(['fixture hyperneo 1', 'fixture hyperneo 2']);
  } finally {
    release.resolve();
    await Promise.allSettled([direct, fill]);
    db.close();
  }
});

test('a rejected start releases its lane and other places can start independently', async () => {
  const source = createWorkerNameSource(() => [], place);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failed = source.withStart('fixture', undefined, async () => {
    entered.resolve();
    await release.promise;
    throw new Error('Synthetic start failure');
  });
  const failure = failed.catch((error: Error) => error.message);
  await entered.promise;
  const next = source.withStart('fixture', place, async () => 'next');
  try {
    expect(
      await source.withStart('fixture', { ...place, folder: '/other' }, async () => 'other place')
    ).toBe('other place');
    expect(await source.withStart('hyperneo', place, async () => 'other engine')).toBe(
      'other engine'
    );
  } finally {
    release.resolve();
  }
  expect(await failure).toBe('Synthetic start failure');
  expect(await next).toBe('next');
});

test.each([undefined, 'Codex remote 7'])(
  'forwarded starts preserve their title without local naming: %s',
  async (name) => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    let reads = 0;
    const naming = createWorkerNameSource(
      () => [
        {
          id: 'fixture',
          capabilities: ['find'],
          find: () => {
            reads++;
            return [];
          },
        },
      ],
      place
    );
    const lane = spyOn(naming, 'withStart');
    const remote = { ...place, daemon: 'remote', machine: 'remote' };
    const world = packWorkerStartFixture(db, {
      workerNames: naming,
      invoke: async () => ({
        kind: 'completed',
        value: {
          ok: true,
          value: {
            ref: { adapter: 'fixture', id: 'remote-worker', daemon: 'remote' },
            place: remote,
            title: name ?? 'Forwarded task',
            status: 'running',
            lastActivityAt: 1,
          },
        },
      }),
    });
    try {
      await world.open();
      const askId = world.store.listOpenAsks()[0]!.id;
      const result = await world.invoke('neo.todo.add', {
        askId,
        ...world.draft('Forwarded task'),
        target: { verb: 'start', adapter: 'fixture', place: remote, ...(name ? { name } : {}) },
      });
      expect(result.todo.state).toBe('doing');
      expect(world.calls[0]!.input).toMatchObject({
        place: remote,
        title: name ?? 'Forwarded task',
      });
      expect(reads).toBe(0);
      expect(lane).not.toHaveBeenCalled();
      expect(world.operations.find((op) => op.name === 'neo.todo.add')!.description).toContain(
        'local starts'
      );
    } finally {
      lane.mockRestore();
      db.close();
    }
  }
);
