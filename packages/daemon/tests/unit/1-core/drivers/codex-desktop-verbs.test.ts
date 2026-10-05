import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexTurnState,
  createCodexDesktopAdapter,
} from '../../../../src/lib/drivers/codex-desktop-adapter';
import type { CodexAppServer } from '../../../../src/lib/drivers/codex-app-server';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { Database } from '../../../../src/storage/sqlite-compat';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
const heard = (text: string) =>
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const said = (text: string) =>
  line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });

describe('codexTurnState', () => {
  test('reads a finished turn and prefers its final message', () => {
    expect(
      codexTurnState([
        line('event_msg', { type: 'task_started' }),
        said('working on it'),
        line('event_msg', { type: 'task_complete', last_agent_message: 'Merged #569.' }),
        '',
      ])
    ).toEqual({ marker: 'task_complete', reply: 'Merged #569.' });
  });

  test('reads a running turn with the latest thing it said', () => {
    expect(
      codexTurnState([
        line('event_msg', { type: 'task_complete', last_agent_message: 'old' }),
        line('event_msg', { type: 'task_started' }),
        said('reading the repo'),
        '{"truncated',
      ])
    ).toEqual({ marker: 'task_started', reply: 'reading the repo' });
  });

  test('reports no turn when the tail holds none', () => {
    expect(codexTurnState([said('hello'), 'not json'])).toEqual({ marker: null, reply: 'hello' });
  });
});

describe('codex-desktop adapter status and send', () => {
  let dir: string;
  let statePath: string;
  let spawned: string[][];

  beforeEach(() => {
    spawned = [];
    dir = mkdtempSync(join(tmpdir(), 'codex-verbs-'));
    statePath = join(dir, 'state_5.sqlite');
    const running = join(dir, 'running.jsonl');
    const finished = join(dir, 'finished.jsonl');
    writeFileSync(
      running,
      [
        line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
        said('reading the repo'),
      ].join('\n')
    );
    writeFileSync(
      finished,
      [line('event_msg', { type: 'task_complete', last_agent_message: 'Done.' })].join('\n')
    );
    const db = new Database(statePath);
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER)`);
    db.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT,
      cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT)`);
    db.exec(`INSERT INTO projects VALUES ('p1', 'dolmen', 1)`);
    db.exec(`INSERT INTO project_roots VALUES ('p1', 0, '/focus/dolmen')`);
    const insert = db.prepare(`INSERT INTO threads VALUES (?, ?, '', '', ?, 'vscode', ?, ?, ?)`);
    insert.run('busy', 'loader', '/codex/worktrees/1/dolmen', 0, NOW - 600_000, running);
    insert.run('idle', 'parser', '/focus/dolmen', 0, NOW - 600_000, finished);
    insert.run('old', 'archived one', '/focus/dolmen', 1, NOW - 900_000, finished);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(
    exitCode = 0,
    stderr = '',
    appServer: () => Promise<CodexAppServer> = () => Promise.reject(new Error('not used'))
  ) {
    const spawn: SpawnFn = (args) => {
      spawned.push(args);
      return {
        stdout: null,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill: () => {},
      };
    };
    return createCodexDesktopAdapter({
      statePath,
      worktreesDir: '/codex/worktrees',
      machine: 'laptop',
      now: () => NOW,
      spawn,
      appServer,
      folderExists: () => true,
    });
  }

  const ref = (id: string) => ({ adapter: 'codex-desktop', id });

  test('stop interrupts the running turn through the shared app-server', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let closed = false;
    const server = async (): Promise<CodexAppServer> => ({
      call: async (method, params) => {
        calls.push([method, params]);
        return {};
      },
      close: () => {
        closed = true;
      },
    });
    expect(await adapter(0, '', server).stop?.(ref('busy'), user)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(calls).toEqual([['turn/interrupt', { threadId: 'busy', turnId: 'turn-1' }]]);
    expect(closed).toBe(true);
    expect(await adapter(0, '', server).stop?.(ref('idle'), user)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(calls).toHaveLength(1);
  });

  test('stop leaves threads Codex Desktop runs itself to the app', async () => {
    const server = async (): Promise<CodexAppServer> => ({
      call: async () => {
        throw new Error('turn/interrupt: {"code":-32600,"message":"thread not found: busy"}');
      },
      close: () => {},
    });
    expect(await adapter(0, '', server).stop?.(ref('busy'), user)).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: 'Codex Desktop runs thread busy itself; stop it in the app.',
    });
    expect(await adapter().stop?.(ref('busy'), user)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await adapter().stop?.(ref('nope'), user)).toMatchObject({ reason: 'not_found' });
  });

  test('status reads the turn from the rollout and places the thread in its project', async () => {
    expect(await adapter().status?.(ref('busy'))).toEqual({
      ok: true,
      value: {
        ref: ref('busy'),
        title: 'loader',
        place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
        status: 'running',
        lastActivityAt: NOW - 600_000,
        link: 'codex://threads/busy',
        lastReply: 'reading the repo',
      },
    });
    expect(await adapter().status?.(ref('idle'))).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'Done.' },
    });
    expect(await adapter().status?.(ref('nope'))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  const user = { from: 'user', caller: { source: 'rpc' as const } };

  test('send queues the message and reports it delivered once the rollout shows it', async () => {
    expect(await adapter().send?.(ref('busy'), '-v after this', user)).toEqual({
      ok: true,
      value: { delivered: false },
    });
    appendFileSync(join(dir, 'finished.jsonl'), `\n${heard('next step\nwith detail')}`);
    expect(await adapter().send?.(ref('idle'), 'next step\nwith detail', user)).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(spawned).toEqual([
      ['codex', 'queue', '--thread=busy', '--message=-v after this'],
      ['codex', 'queue', '--thread=idle', '--message=next step\nwith detail'],
    ]);
  });

  test('send refuses archived threads and reports a failed queue', async () => {
    expect(await adapter().send?.(ref('old'), 'hi', user)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(await adapter(1, 'no such thread\n').send?.(ref('idle'), 'hi', user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'no such thread',
    });
  });
});
