import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  codexProjectFolder,
  createCodexDesktopAdapter,
} from '../../../../src/lib/drivers/codex-desktop-adapter';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

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
    });
  }

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
});
