import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [port, run] = process.argv.slice(2);
assert(port && port !== '8399' && run, 'usage: bun external-reply-check.ts <port> <fresh-run-dir>');
const probe = createServer();
await new Promise<void>((done, fail) =>
  probe.listen(Number(port), '127.0.0.1', done).once('error', fail)
);
await new Promise<void>((done) => probe.close(() => done()));
const root = resolve(import.meta.dirname, '../../..');
const home = join(run, 'home');
const data = join(run, 'data');
const sockets = join(run, 'sockets');
for (const path of [
  join(home, '.claude/projects'),
  join(home, '.claude/sessions'),
  join(run, 'bin'),
  data,
  sockets,
])
  mkdirSync(path, { recursive: true });
chmodSync(sockets, 0o700);
const peer = { sessionId: crypto.randomUUID(), pid: process.pid, status: 'busy' };
const socketPath = join(sockets, `${peer.pid}.sock`);
writeFileSync(join(run, 'peer.json'), JSON.stringify([peer]));
writeFileSync(
  join(run, 'bin/claude'),
  `#!/bin/sh\n[ "$1 $2" = 'agents --json' ] || exit 1\ncat '${join(run, 'peer.json')}'\n`,
  { mode: 0o700 }
);
writeFileSync(
  join(home, `.claude/sessions/${peer.pid}.json`),
  JSON.stringify({
    ...peer,
    procStart: Date.now(),
    entrypoint: 'cli',
    version: '2.1.295',
    messagingSocketPath: socketPath,
  })
);
const received: string[] = [];
const server = createServer((socket) => {
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk.toString();
    if (!pending.includes('\n')) return;
    received.push(JSON.parse(pending.split('\n')[0]).message.content);
  });
});
await new Promise<void>((done, fail) => server.listen(socketPath, done).once('error', fail));
chmodSync(socketPath, 0o600);
const env = {
  HOME: home,
  PATH: `${join(run, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  NODE_ENV: 'test',
  HYPERNEO_DATA_DIR: data,
};
const log = openSync(join(run, 'daemon.log'), 'wx');
const daemon = spawn(
  process.execPath,
  [
    'packages/cli/main.ts',
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--db-path',
    join(data, 'daemon.db'),
  ],
  { cwd: root, env, stdio: ['ignore', log, log] }
);
const pause = () => new Promise((done) => setTimeout(done, 250));
async function rpc(name: string, input: unknown, sessionId = 'global') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const id = crypto.randomUUID();
  try {
    return await new Promise<Record<string, unknown>>((done, fail) => {
      const timer = setTimeout(() => {
        ws.close();
        fail(new Error(`${name} timed out`));
      }, 15000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id,
            type: 'REQ',
            sessionId,
            method: 'operation.invoke',
            data: { name, input },
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          })
        );
      ws.onerror = () => {
        clearTimeout(timer);
        fail(new Error(`${name} connection failed`));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.requestId !== id && message.id !== id) return;
        clearTimeout(timer);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.data);
      };
    });
  } finally {
    ws.close();
  }
}
try {
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (daemon.exitCode !== null) throw new Error('Isolated daemon exited; inspect daemon.log');
    try {
      await rpc('operations.list', {});
      ready = true;
    } catch {}
    if (ready) break;
    await pause();
  }
  assert(ready, 'isolated daemon did not become ready');
  const opened = await rpc('neo.open', {});
  const neo = String(opened.sessionId);
  assert(neo.startsWith('neo:'), JSON.stringify(opened));
  const line = `Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings. Use: hyperneo send ${neo} --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.`;
  const ref = { adapter: 'claude-code', id: peer.sessionId };
  const seed = new Database(join(data, 'daemon.db'));
  try {
    const now = Date.now();
    seed
      .prepare(
        "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at) VALUES ('verify-ask', ?, 'Verify reply', 'Verify reply', 'open', ?, ?)"
      )
      .run(neo, now, now);
    for (const [id, instruction] of [
      ['first', 'Build the fix.'],
      ['second', `Continue.\n\n${line}`],
    ]) {
      seed
        .prepare(
          "INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, created_at, updated_at) VALUES (?, 'verify-ask', ?, 'Verify peer', 'Peer receives instruction', ?, 'todo', ?, ?)"
        )
        .run(id, id === 'first' ? 0 : 1, instruction, now, now);
      seed
        .prepare('INSERT INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
        .run(id, JSON.stringify({ verb: 'send', ref }));
      seed
        .prepare(
          "INSERT INTO neo_questions (id, ask_id, text, kind, start_todos, state, created_at) VALUES (?, 'verify-ask', 'Start peer?', 'start', ?, 'open', ?)"
        )
        .run(`start-${id}`, JSON.stringify([id]), now);
    }
  } finally {
    seed.close();
  }
  const first = await rpc('neo.question.answer', { questionId: 'start-first', answer: ['first'] });
  for (let i = 0; received.length < 1 && i < 40; i++) await pause();
  writeFileSync(join(run, 'observed.json'), JSON.stringify({ neo, first, received }, null, 2));
  assert.equal(first.ok, true);
  assert(
    received[0]?.includes(line),
    'external worker did not receive the sending Neo CLI reply line'
  );
  await rpc('neo.question.answer', { questionId: 'start-second', answer: ['second'] });
  await rpc('work.send', {
    ref,
    message: 'Human instruction.',
    from: `session:${encodeURIComponent(neo)}`,
  });
  for (let i = 0; received.length < 3 && i < 40; i++) await pause();
  assert.equal(received.length, 3);
  assert.equal(received[1].split(line).length - 1, 1);
  assert(!received[2].includes('hyperneo send'));
  const reply = spawnSync(
    process.execPath,
    ['packages/cli/main.ts', 'send', neo, '--kind', 'blocked', 'Blocked: synthetic peer needs a decision.'],
    {
      cwd: root,
      env: {
        ...env,
        CLAUDE_CODE_SESSION_ID: peer.sessionId,
        HYPERNEO_SESSION_DOOR: join(data, 'session-door.sock'),
      },
      encoding: 'utf8',
    }
  );
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).kind, 'accepted');
  const db = new Database(join(data, 'daemon.db'), { readonly: true });
  let persisted = false;
  let structured = false;
  try {
    for (let i = 0; i < 40; i++) {
      persisted = !!db
        .prepare(
          "SELECT 1 FROM sdk_messages WHERE session_id = ? AND message_type = 'user' AND sdk_message LIKE ? AND sdk_message LIKE ? LIMIT 1"
        )
        .get(neo, '%Blocked: synthetic peer needs a decision.%', `%claude-code:${peer.sessionId}%`);
      if (persisted) break;
      await pause();
    }
    structured = !!db.prepare("SELECT 1 FROM sdk_messages WHERE session_id = ? AND json_extract(sdk_message, '$.workerReportKind') = 'blocked' LIMIT 1").get(neo);
  } finally {
    db.close();
  }
  assert(persisted, 'CLI blocker did not reach Neo transcript');
  assert(structured, 'CLI blocker lost its structured report kind');
  const evidence = {
    neo,
    ref,
    received,
    reply: JSON.parse(reply.stdout),
    persisted,
    structured,
    transport: 'real daemon RPC and Claude inbox socket; synthetic peer, no model or GUI',
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  daemon.kill('SIGTERM');
  for (let i = 0; daemon.exitCode === null && i < 60; i++) await pause();
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  await new Promise<void>((done) => server.close(() => done()));
}
