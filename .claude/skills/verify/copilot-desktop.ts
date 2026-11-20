import { strict as assert } from 'node:assert';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { Result, WorkDetail, WorkStarted, WorkTurnFact } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { copilotFolder, copilotSession, prepareCopilotFixture } from '../../../packages/daemon/tests/helpers/copilot-fixture.ts';
import type { z } from 'zod';
import { startCopilotDesktopPeer, verifyCopilotDesktopControl } from './copilot-desktop-control-peer.ts';

const [portText, mode, run] = process.argv.slice(2);
const port = Number(portText);
assert(run && Number.isInteger(port) && port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(['desktop', 'cli', 'both', 'cli-failure', 'control', 'both-control'].includes(mode));
const home = join(run, 'home');
const cli = mode !== 'desktop' && mode !== 'control';
const desktop = mode !== 'cli';
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
if (cli) {
  prepareCopilotFixture(run);
  process.env.COPILOT_CLI_PATH = join(run, 'bin/copilot');
  if (mode === 'cli-failure') writeFileSync(join(home, 'copilot-list-failure'), '');
}
const state = join(home, '.copilot/data.db');
if (desktop) {
  const history = join(home, '.copilot/session-state', copilotSession);
  mkdirSync(history, { recursive: true });
  const db = new Database(state);
  try {
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, main_repo_path TEXT);
      CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT,
        is_running INTEGER, was_interrupted INTEGER, archived_at TEXT,
        execution_location TEXT, provisional INTEGER);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, session_id TEXT UNIQUE, project_id TEXT,
        worktree_id TEXT, name TEXT, source_path TEXT, archived_at TEXT,
        host_id TEXT, workspace_type TEXT);
      INSERT INTO projects VALUES ('p', 'Desktop project', '/synthetic/copilot-project');
      INSERT INTO sessions VALUES ('${copilotSession}', 'Desktop title',
        '2026-11-19T15:00:01Z', 0, 0, NULL, 'local', 0);
      INSERT INTO workspaces VALUES ('desktop-workspace', '${copilotSession}', 'p',
        NULL, 'Desktop', NULL, NULL, 'local', 'folder');
    `);
  } finally {
    db.close();
  }
  const events = [
    { type: 'session.start', data: { context: { cwd: copilotFolder } } },
    { type: 'user.message', data: { messageId: 'zero', interactionId: 'other', content: 'Other input' } },
    { type: 'assistant.message', data: { messageId: 'other-reply', interactionId: 'other', content: 'Other reply' } },
    { type: 'user.message', data: { messageId: 'one', interactionId: 'turn', content: 'MARKER\nInput' } },
    { type: 'assistant.message', data: { messageId: 'two', interactionId: 'turn', content: 'Reply' } },
    { type: 'session.idle', data: {} },
  ];
  writeFileSync(join(history, 'events.jsonl'), events.map((event, i) =>
    JSON.stringify({ ...event, timestamp: `2026-11-19T15:00:0${i}Z` })).join('\n') + '\n');
}
const before = desktop ? readFileSync(state) : null;
const peer = mode === 'control' || mode === 'both-control' ? await startCopilotDesktopPeer(home, state) : undefined;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
process.chdir(run);
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
let socket: WebSocket | undefined;
let calls = 0;
try {
  const ws = createLocalSocket(`ws://127.0.0.1:${port}/ws`);
  socket = ws;
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('Isolated RPC connection failed'));
  });
  function rpc<T>(name: string, input: object): Promise<T> {
    calls++;
    return new Promise((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 20000);
      const receive = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        ws.removeEventListener('message', receive);
        clearTimeout(timer);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data);
      };
      ws.addEventListener('message', receive);
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
        data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  }
  const adapter = 'copilot-cli';
  const registered = await rpc<Result<{ id: string; capabilities: string[] }[]>>('work.adapters', {});
  assert(registered.ok);
  const listed = registered.value.filter((entry) => entry.id.startsWith('copilot-'));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, adapter);
  assert.equal(listed[0].capabilities.includes('start'), cli || !!peer);
  if (peer) {
    await verifyCopilotDesktopControl(rpc, run, peer);
  } else {
  const query = { adapters: [adapter], localOnly: true };
  const found = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', query);
  assert.deepEqual(found.unreachable, []);
  const matches = found.places.flatMap((place) => place.work).filter((work) => work.ref.id === copilotSession);
  assert.equal(matches.length, 1);
  const [session] = matches;
  assert.equal(session.title, desktop ? 'Desktop title' : 'Synthetic sum task');
  if (mode === 'cli-failure') {
    assert.match(session.watchHint ?? '', /External Copilot discovery unavailable/);
    const missed = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
      ...query, text: 'No matching session',
    });
    assert.match(missed.unreachable[0]?.reason ?? '', /Synthetic listing failure/);
  }
  if (desktop) {
    assert.equal(session.link, 'ghapp://sessions/desktop-workspace');
    const status = await rpc<Result<WorkDetail>>('work.status', { ref: session.ref });
    assert(status.ok && status.value.status === 'done');
    const latest = await rpc<Result<{ turns: { text: string }[]; nextCursor: object }>>(
      'work.read', { sessionId: session.ref.id, before: 0, after: 0 }
    );
    assert(latest.ok && latest.value.turns[0].text === 'Reply' && latest.value.nextCursor);
    const marker = await rpc<Result<{ turns: { messageId: string }[] }>>('work.read', {
      sessionId: session.ref.id, input: { adapter, marker: 'MARKER' },
    });
    assert(marker.ok && marker.value.turns[0].messageId === 'user:one');
    const turns = await rpc<Result<{ turns: WorkTurnFact[] }>>('work.turns', { ref: session.ref, limit: 1 });
    assert(turns.ok && turns.value.turns[0].id === 'one' && turns.value.turns[0].complete);
    if (mode === 'desktop') {
      const older = turns.value.turns[0];
      const next = await rpc<Result<{ turns: WorkTurnFact[] }>>('work.turns', {
        ref: session.ref, cursor: older.cursor, limit: 1,
      });
      assert(next.ok, JSON.stringify(next));
      assert.equal(next.value.turns[0]?.id, 'zero');
      assert.equal(next.value.turns[0].endedAt, older.endedAt);
      const events = [
        { type: 'user.message', data: { messageId: 'new', interactionId: 'next', content: 'New input' } },
        { type: 'assistant.message', data: { messageId: 'new-reply', interactionId: 'next', content: 'New reply' } },
        { type: 'session.idle', data: {} },
      ];
      appendFileSync(join(home, '.copilot/session-state', copilotSession, 'events.jsonl'),
        ' '.repeat(270_000) + '\n' + events.map((event, i) =>
          JSON.stringify({ ...event, timestamp: `2026-11-19T15:00:0${i + 3}Z` })).join('\n') + '\n');
      const resumed = await rpc<Result<{ turns: WorkTurnFact[] }>>('work.turns', {
        ref: session.ref, cursor: next.value.turns[0].cursor,
      });
      assert(resumed.ok, JSON.stringify(resumed));
      assert.deepEqual(resumed.value.turns.map((turn) => turn.id), ['new']);
      assert.equal(resumed.value.turns[0].endedAt, older.endedAt);
      const caughtUp = await rpc<Result<{ turns: WorkTurnFact[] }>>('work.turns', {
        ref: session.ref, cursor: resumed.value.turns[0].cursor,
      });
      assert(caughtUp.ok && caughtUp.value.turns.length === 0);
    }
    const refused = await rpc<Result<unknown>>('work.send', { ref: session.ref, message: 'No delivery' });
    assert(!refused.ok && refused.reason === 'unsupported');
    assert.deepEqual(readFileSync(state), before);
  }
  if (mode === 'desktop') {
    const db = new Database(state);
    try {
      db.exec('BEGIN EXCLUSIVE');
      const [afterLock] = await Promise.all([
        rpc<z.infer<typeof FindWorkResultSchema>>('work.find', query),
        new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() => db.exec('COMMIT')),
      ]);
      assert.deepEqual(afterLock.unreachable, []);
      assert(afterLock.places.some((place) => place.work.some((work) => work.ref.id === copilotSession)));
      db.exec('PRAGMA journal_mode = WAL');
    } finally {
      db.close();
    }
    chmodSync(dirname(state), 0o555);
    try {
      const wal = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', query);
      assert.deepEqual(wal.unreachable, []);
      assert(wal.places.some((place) => place.work.some((work) => work.ref.id === copilotSession)));
    } finally {
      chmodSync(dirname(state), 0o700);
    }
  }
  if (cli) {
    const folder = join(run, 'workspace');
    mkdirSync(folder);
    const start = await rpc<Result<WorkStarted>>('work.start', {
      adapter,
      place: { machine: hostname(), folder, name: 'Fixture' },
      title: 'Fixture',
      model: 'synthetic-model',
      message: 'hold',
    });
    assert(start.ok, JSON.stringify(start));
    const { ref } = start.value;
    const send = await rpc<Result<unknown>>('work.send', { ref, message: 'queued' });
    assert(send.ok, JSON.stringify(send));
    const stop = await rpc<Result<{ stopped: boolean }>>('work.stop', { ref });
    assert(stop.ok && stop.value.stopped, JSON.stringify(stop));
    const turns = await rpc<Result<{ turns: WorkTurnFact[] }>>('work.turns', { ref });
    assert(turns.ok && turns.value.turns.some((turn) => turn.ended === 'stopped'));
    if (desktop) assert.deepEqual(readFileSync(state), before);
  }
  if (desktop && mode !== 'cli-failure') {
    const db = new Database(state);
    try {
      if (cli) {
        db.exec(`
          INSERT INTO sessions VALUES ('untitled', '', '2026-11-19T15:00:02Z', 0, 0, NULL, 'local', 0);
          INSERT INTO workspaces VALUES ('untitled-workspace', 'untitled', 'p', NULL, NULL,
            NULL, NULL, 'local', 'folder');
        `);
        const untitled = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
          ...query, text: 'Untitled session',
        });
        assert.deepEqual(untitled.unreachable, []);
        assert(untitled.places.some((place) =>
          place.work.some((work) => work.ref.id === 'untitled' && work.title === 'Untitled session')));
      }
      db.exec('ALTER TABLE sessions RENAME TO changed_sessions');
    } finally {
      db.close();
    }
    const drift = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', query);
    const missing = 'unknown-desktop-session';
    const history = await rpc<Result<unknown>>('work.read', { sessionId: missing });
    assert(!history.ok && history.reason === 'not_found');
    const input = await rpc<Result<unknown>>('work.read', {
      sessionId: missing, input: { adapter, marker: 'MARKER' },
    });
    assert(!input.ok && input.reason === 'not_found');
    if (cli) {
      const visible = drift.places.flatMap((place) => place.work);
      const external = visible.find((work) => work.ref.id === copilotSession);
      assert.equal(external?.title, 'Synthetic sum task');
      assert(visible.every((work) => work.watchHint?.includes('Copilot Desktop discovery unavailable')));
      const missed = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
        ...query, text: 'No matching session',
      });
      assert.match(missed.unreachable[0]?.reason ?? '', /^Unsupported Copilot Desktop state schema:/);
    } else {
      assert.equal(drift.places.length, 0);
      assert.match(drift.unreachable[0]?.reason ?? '', /^Unsupported Copilot Desktop state schema:/);
    }
  }
  }
} finally {
  socket?.close();
  await app.cleanup();
  await peer?.close();
}
console.log(`PASS Copilot ${mode}: ${calls} RPC calls`);
