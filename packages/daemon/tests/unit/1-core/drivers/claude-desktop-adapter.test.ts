import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  reuseLiveSessions,
  readLiveClaudeSessions,
  type ClaudeRecordCache,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

function record(id: string, fields: Record<string, unknown>) {
  return { sessionId: `local_${id}`, cliSessionId: `cli-${id}`, ...fields };
}

describe('claude-desktop adapter against the app session records', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-sessions-'));
    const write = (scope: string, value: Record<string, unknown> | string) => {
      mkdirSync(join(dir, scope), { recursive: true });
      const name =
        typeof value === 'string' ? 'local_broken.json' : `${String(value.sessionId)}.json`;
      writeFileSync(
        join(dir, scope, name),
        typeof value === 'string' ? value : JSON.stringify(value)
      );
    };
    write(
      'acct-a/scope-1',
      record('a1', {
        originCwd: '/focus/dolmen',
        cwd: '/focus/dolmen/.claude/worktrees/w1',
        title: 'lakehouse loader',
        isArchived: false,
        lastActivityAt: 30,
      })
    );
    write(
      'acct-a/scope-1',
      record('a2', {
        originCwd: '/focus/dolmen',
        title: 'old review',
        isArchived: true,
        lastActivityAt: 10,
      })
    );
    write(
      'acct-b/scope-2',
      record('b1', {
        originCwd: '/focus/fiso',
        title: 'fiso init',
        isArchived: true,
        lastActivityAt: 20,
      })
    );
    write(
      'acct-b/scope-2',
      record('b2', { cwd: '/focus/ops', title: 'woodpecker', lastActivityAt: 5 })
    );
    write('acct-b/scope-2', '{not json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(live = [{ sessionId: 'cli-a1', status: 'waiting' }]) {
    return createClaudeDesktopAdapter({
      sessionsDir: dir,
      machine: 'laptop',
      liveSessions: async () => live,
    });
  }

  test('lists every project the app shows, with its open sessions and live status', async () => {
    const groups = await adapter().find({ includeClosed: false, limit: 20 });
    const byName = new Map(groups.map((g) => [g.place.name, g]));
    expect(
      [...byName.values()]
        .map((g) => [g.place.folder, g.openCount, g.archivedCount, g.work.map((w) => w.title)])
        .sort()
    ).toEqual([
      ['/focus/dolmen', 1, 1, ['lakehouse loader']],
      ['/focus/fiso', 0, 1, []],
      ['/focus/ops', 1, 0, ['woodpecker']],
    ]);
    expect(byName.get('dolmen')?.work[0]).toEqual({
      ref: { adapter: 'claude-desktop', id: 'local_a1' },
      title: 'lakehouse loader',
      place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
      status: 'needs_you',
      lastActivityAt: 30,
      link: 'claude://claude.ai/epitaxy/local_a1',
    });
  });

  test('adds archived sessions as stopped when asked for closed work', async () => {
    const groups = await adapter([]).find({
      includeClosed: true,
      limit: 20,
      folder: '/focus/dolmen',
    });
    expect(groups[0].work.map((w) => [w.title, w.status])).toEqual([
      ['lakehouse loader', 'done'],
      ['old review', 'stopped'],
    ]);
  });

  test('matches sessions by title and projects by name, and has no Spaces', async () => {
    const find = (query: { text?: string; spaceId?: string }) =>
      adapter().find({ includeClosed: false, limit: 20, ...query });
    expect((await find({ text: 'loader' })).map((g) => g.work.map((w) => w.ref.id))).toEqual([
      ['local_a1'],
    ]);
    expect((await find({ text: 'fiso' })).map((g) => g.place.name)).toEqual(['fiso']);
    expect(await find({ spaceId: 'sp1' })).toEqual([]);
  });

  test('reparses only session files that changed since the last search', async () => {
    const cache: ClaudeRecordCache = new Map();
    const first = await readClaudeDesktopRecords(dir, cache);
    const path = join(dir, 'acct-a/scope-1/local_a1.json');
    const reused = cache.get(path);
    const untouched = cache.get(join(dir, 'acct-a/scope-1/local_a2.json'));
    writeFileSync(
      path,
      JSON.stringify(record('a1', { originCwd: '/focus/dolmen', title: 'renamed' }))
    );
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    rmSync(join(dir, 'acct-b/scope-2/local_b2.json'));
    const second = await readClaudeDesktopRecords(dir, cache);
    expect(first.map((r) => r.title).sort()).toEqual([
      'fiso init',
      'lakehouse loader',
      'old review',
      'woodpecker',
    ]);
    expect(second.map((r) => r.title).sort()).toEqual(['fiso init', 'old review', 'renamed']);
    expect(cache.get(path)).not.toBe(reused);
    expect(cache.get(join(dir, 'acct-a/scope-1/local_a2.json'))).toBe(untouched);
    expect(cache.has(join(dir, 'acct-b/scope-2/local_b2.json'))).toBe(false);
  });

  test('does not ask the CLI when every session is archived', async () => {
    let asked = false;
    const archivedOnly = mkdtempSync(join(tmpdir(), 'claude-archived-'));
    mkdirSync(join(archivedOnly, 'a/s'), { recursive: true });
    writeFileSync(
      join(archivedOnly, 'a/s/local_z.json'),
      JSON.stringify(record('z', { originCwd: '/focus/old', isArchived: true }))
    );
    await createClaudeDesktopAdapter({
      sessionsDir: archivedOnly,
      machine: 'laptop',
      liveSessions: async () => {
        asked = true;
        return [];
      },
    }).find({ includeClosed: true, limit: 20 });
    rmSync(archivedOnly, { recursive: true, force: true });
    expect(asked).toBe(false);
  });

  test('answers a Space search without reading records or asking the CLI', async () => {
    let asked = false;
    const groups = await createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'missing'),
      machine: 'laptop',
      liveSessions: async () => {
        asked = true;
        return [];
      },
    }).find({ includeClosed: false, limit: 20, spaceId: 'sp1' });
    expect(groups).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe('readLiveClaudeSessions', () => {
  function spawnWith(stdout: string): SpawnFn {
    return () => ({
      stdout: new Response(stdout).body,
      stderr: null,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    });
  }

  test('reads the live sessions claude agents reports', async () => {
    expect(
      await readLiveClaudeSessions(
        spawnWith('[{"pid":1,"sessionId":"cli-a1","status":"busy","name":"x"}]')
      )
    ).toEqual([{ sessionId: 'cli-a1', status: 'busy' }]);
  });

  test('treats a missing CLI or unreadable output as no live sessions', async () => {
    expect(await readLiveClaudeSessions(spawnWith('Usage: claude'))).toEqual([]);
    expect(
      await readLiveClaudeSessions(() => {
        throw new Error('ENOENT');
      })
    ).toEqual([]);
  });
});

describe('reuseLiveSessions', () => {
  test('asks the CLI again only after the reuse window', async () => {
    let reads = 0;
    let clock = 0;
    const live = reuseLiveSessions(
      async () => {
        reads++;
        return [];
      },
      () => clock,
      1_000
    );
    await live();
    clock = 999;
    await live();
    expect(reads).toBe(1);
    clock = 1_000;
    await live();
    expect(reads).toBe(2);
  });
});
