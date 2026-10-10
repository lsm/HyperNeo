import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexProjectFolder,
  createCodexDesktopAdapter,
} from '../../../../src/lib/drivers/codex-desktop-adapter';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { Database } from '../../../../src/storage/sqlite-compat';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const unusedSpawn: SpawnFn = () => {
  throw new Error('find never spawns');
};

describe('codexProjectFolder', () => {
  const roots = [
    { name: 'dolmen', folder: '/focus/dolmen', lastActiveAt: 1 },
    { name: 'a', folder: '/focus/a/neokai', lastActiveAt: 1 },
    { name: 'b', folder: '/focus/b/neokai', lastActiveAt: 1 },
  ];

  test('maps a Codex worktree to the one project root with its name', () => {
    expect(codexProjectFolder('/codex/worktrees/5096/dolmen', roots, '/codex/worktrees')).toBe(
      '/focus/dolmen'
    );
  });

  test('keeps the worktree when no root or several roots share its name', () => {
    expect(codexProjectFolder('/codex/worktrees/1/neokai', roots, '/codex/worktrees')).toBe(
      '/codex/worktrees/1/neokai'
    );
    expect(codexProjectFolder('/codex/worktrees/1/other', roots, '/codex/worktrees')).toBe(
      '/codex/worktrees/1/other'
    );
    expect(codexProjectFolder('/focus/elsewhere', roots, '/codex/worktrees')).toBe(
      '/focus/elsewhere'
    );
  });
});

describe('codex-desktop adapter against a Codex state database', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-state-'));
    statePath = join(dir, 'state_5.sqlite');
    const db = new Database(statePath);
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER)`);
    db.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT,
      first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER)`);
    db.exec(`INSERT INTO projects VALUES ('p1', 'dolmen', 1), ('p2', 'superpipe', 2)`);
    db.exec(
      `INSERT INTO project_roots VALUES ('p1', 0, '/focus/dolmen'), ('p2', 0, '/focus/superpipe')`
    );
    const insert = db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      't1',
      'dolmen-codex',
      '',
      '',
      '/codex/worktrees/5096/dolmen',
      'vscode',
      0,
      NOW - 1000
    );
    insert.run('t2', '', '', 'fix the loader please', '/focus/dolmen', 'cli', 0, NOW - 3_600_000);
    insert.run('t3', 'old', '', '', '/focus/dolmen', 'vscode', 1, NOW - 7_200_000);
    insert.run(
      't4',
      'review',
      '',
      '',
      '/focus/dolmen',
      '{"subagent":{"other":"guardian"}}',
      0,
      NOW
    );
    insert.run('t5', 'gone', '', '', '/tmp/scratch', 'exec', 1, NOW - 9_000_000);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter() {
    return createCodexDesktopAdapter({
      statePath,
      worktreesDir: '/codex/worktrees',
      machine: 'laptop',
      now: () => NOW,
      spawn: unusedSpawn,
      appServer: () => Promise.reject(new Error('not used')),
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'abcd1234-0000',
    });
  }

  test('finds a thread by what was said in it and shows the matching snippet', async () => {
    const searched: string[] = [];
    const found = await createCodexDesktopAdapter({
      statePath,
      worktreesDir: '/codex/worktrees',
      machine: 'laptop',
      now: () => NOW,
      spawn: unusedSpawn,
      appServer: () => Promise.reject(new Error('not used')),
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'abcd1234-0000',
      searchChats: async (text) => {
        searched.push(text);
        return [
          {
            kind: 'codex',
            sessionId: 't2',
            taskId: null,
            hits: 3,
            lastHitAt: NOW - 3_600_000,
            score: 100.05,
            snippets: [
              {
                match: 'exact',
                messageId: 'm9',
                sessionId: 't2',
                role: 'assistant',
                at: NOW,
                text: 'moved the otter loader',
              },
            ],
          },
        ];
      },
    }).find({ text: 'otter', includeClosed: false, limit: 20 });
    expect(searched).toEqual(['otter']);
    expect(found.flatMap((group) => group.work)).toMatchObject([
      {
        ref: { adapter: 'codex-desktop', id: 't2' },
        hits: 3,
        snippets: [
          { text: 'moved the otter loader', handle: { sessionId: 't2', messageId: 'm9' } },
        ],
      },
    ]);
  });

  test('lists Codex projects with their open threads, worktrees folded into the project', async () => {
    const groups = await adapter().find({ includeClosed: false, limit: 20 });
    expect(
      groups.map((g) => [
        g.place.name,
        g.openCount,
        g.archivedCount,
        g.work.map((w) => [w.title, w.status]),
      ])
    ).toEqual([
      [
        'dolmen',
        2,
        1,
        [
          ['dolmen-codex', 'running'],
          ['fix the loader please', 'done'],
        ],
      ],
      ['superpipe', 0, 0, []],
    ]);
    expect(groups[0].work[0]).toMatchObject({
      ref: { adapter: 'codex-desktop', id: 't1' },
      place: { machine: 'laptop', folder: '/focus/dolmen' },
      link: 'codex://threads/t1',
    });
  });

  test('keeps every open thread when archived ones are added', async () => {
    const db = new Database(statePath);
    const insert = db.prepare(
      `INSERT INTO threads VALUES (?, 'old', '', '', '/focus/x', 'vscode', 1, ?)`
    );
    for (let n = 0; n < 600; n++) insert.run(`a${n}`, NOW + n);
    db.close();
    const groups = await adapter().find({
      includeClosed: true,
      limit: 20,
      folder: '/focus/dolmen',
      text: 'loader',
    });
    expect(groups.map((g) => g.work.map((w) => w.ref.id))).toEqual([['t2']]);
  });

  test('adds archived threads and folders holding only those when asked for closed work', async () => {
    const groups = await adapter().find({ includeClosed: true, limit: 20 });
    expect(groups.map((g) => [g.place.folder, g.work.length])).toEqual([
      ['/focus/dolmen', 3],
      ['/focus/superpipe', 0],
      ['/tmp/scratch', 1],
    ]);
  });

  test('matches threads by title and projects by name, and has no Spaces', async () => {
    const find = (query: { text?: string; spaceId?: string }) =>
      adapter().find({ includeClosed: false, limit: 20, ...query });
    expect((await find({ text: 'loader' })).map((g) => g.work.map((w) => w.ref.id))).toEqual([
      ['t2'],
    ]);
    expect((await find({ text: 'superpipe' })).map((g) => g.place.name)).toEqual(['superpipe']);
    expect(await find({ spaceId: 'sp1' })).toEqual([]);
  });

  test('names a thread with no name, title or message', async () => {
    const db = new Database(statePath);
    db.exec(
      `INSERT INTO threads VALUES ('t6', NULL, NULL, NULL, '/focus/superpipe', 'vscode', 0, ${NOW})`
    );
    db.close();
    const groups = await adapter().find({ includeClosed: false, limit: 20, text: 'superpipe' });
    expect(groups[0].work.map((w) => w.title)).toEqual(['Untitled thread']);
  });

  test('titles a thread by one short line of its first message, not the whole prompt', async () => {
    const prompt = `<system>\nYou are a bridge.\n${'filler '.repeat(5000)}Pick a font.`;
    const db = new Database(statePath);
    db.prepare(
      `INSERT INTO threads VALUES ('t7', NULL, ?, NULL, '/focus/superpipe', 'vscode', 0, ${NOW})`
    ).run(prompt);
    db.close();
    expect(await adapter().find({ includeClosed: false, limit: 20, text: 'font' })).toEqual([]);
    const groups = await adapter().find({ includeClosed: false, limit: 20, text: 'superpipe' });
    const title = groups[0].work.find((w) => w.ref.id === 't7')?.title;
    expect(title).toBe(`<system> You are a bridge. ${'filler '.repeat(7)}fill`);
  });

  test('skips or fills rows with missing values instead of failing the search', async () => {
    const db = new Database(statePath);
    db.exec(`INSERT INTO projects VALUES ('p3', NULL, NULL)`);
    db.exec(`INSERT INTO project_roots VALUES ('p3', 0, '/focus/nameless'), ('p3', 1, NULL)`);
    db.exec(`INSERT INTO threads VALUES ('t7', 'stray', '', '', NULL, 'vscode', 0, ${NOW}),
      ('t8', 'odd', '', '', '/focus/nameless', NULL, NULL, NULL)`);
    db.close();
    const groups = await adapter().find({
      includeClosed: false,
      limit: 20,
      folder: '/focus/nameless',
    });
    expect(groups).toEqual([
      expect.objectContaining({
        place: { machine: 'laptop', folder: '/focus/nameless', name: 'nameless' },
        openCount: 1,
        work: [expect.objectContaining({ title: 'odd', lastActivityAt: 0, status: 'done' })],
      }),
    ]);
  });

  test('answers a Space search without opening the state database', async () => {
    const groups = await createCodexDesktopAdapter({
      statePath: join(dir, 'missing.sqlite'),
      worktreesDir: '/codex/worktrees',
      machine: 'laptop',
      now: () => NOW,
      spawn: unusedSpawn,
      appServer: () => Promise.reject(new Error('not used')),
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'abcd1234-0000',
    }).find({ includeClosed: false, limit: 20, spaceId: 'sp1' });
    expect(groups).toEqual([]);
  });
});
