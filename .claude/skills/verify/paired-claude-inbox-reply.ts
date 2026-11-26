import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDelivery } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
const senderId = 'inbox-proof-sender';

if (process.argv.includes('--daemon')) {
  const app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath, workspaceRoot: run }),
      disableWorktrees: true,
    },
    verbose: false,
  });
  process.once('SIGTERM', () => {
    void app.cleanup().then(() => process.exit(0));
  });
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  const now = new Date().toISOString();
  await app.db.createSession({
    id: senderId,
    title: 'Inbox proof sender',
    workspacePath: run,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, totalCost: 0 },
  });
  process.send!(app.server.port);
} else {
  const alias = 'attached-home';
  assert.notEqual(hostname(), alias);
  const home = join(run, 'a');
  const worker = join(run, 'b');
  const children: { process: ChildProcess; exited: Promise<number | null> }[] = [];
  const transports: WebSocketClientTransport[] = [];
  const sessionId = crypto.randomUUID();
  const ref = { adapter: 'claude-desktop', id: `local_${sessionId}`, daemon: 'worker' };
  const record = join(worker, 'home/Library/Application Support/Claude/claude-code-sessions/a/b');
  const registrations = join(worker, 'home/.claude/sessions');
  const sockets = join(worker, 's');
  const socketPath = join(sockets, `${process.pid}.sock`);
  const project = join(worker, 'project');
  const transcript = join(
    worker,
    'home/.claude/projects',
    project.replace(/[/.]/g, '-'),
    `${sessionId}.jsonl`
  );
  const text = 'Send through the attached daemon';
  const replyText = 'Reply from the private inbox';
  const replyId = crypto.randomUUID();
  const frames: { from: string; uuid: string; message: { content: string } }[] = [];
  const refused = 'Reject before writing to the private inbox';
  mkdirSync(join(run, 'evidence'));
  const evidencePath = join(run, 'evidence/observed.json');
  const evidence: Record<string, unknown> = { frames };
  const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  const peer = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const frame = JSON.parse(buffer);
      frames.push(frame);
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'user',
          uuid: frame.uuid,
          timestamp: new Date().toISOString(),
          message: frame.message,
        }) + '\n'
      );
    });
  });

  async function start(dir: string) {
    for (const part of ['bin', 'data', 'home', 'tmp']) {
      mkdirSync(join(dir, part), { recursive: true });
    }
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    writeFileSync(join(dir, 'bin/ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const child = spawn(process.execPath, [import.meta.path, '--daemon', dir], {
      env: {
        HOME: join(dir, 'home'),
        HYPERNEO_DATA_DIR: join(dir, 'data'),
        TMPDIR: join(dir, 'tmp'),
        NODE_ENV: 'test',
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const exited = new Promise<number | null>((done) => child.once('close', done));
    children.push({ process: child, exited });
    const port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Isolated daemon startup timed out')), 30_000);
      child.once('message', (value) => {
        clearTimeout(timer);
        done(Number(value));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        fail(new Error(`Isolated daemon exited with ${code}`));
      });
      child.once('error', fail);
    });
    assert(port > 0 && port !== 8399);
    const url = `ws://127.0.0.1:${port}/ws`;
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({
      url,
      createSocket: (url) => createLocalSocket(url, join(dir, 'data/local-rpc.credential')),
      autoReconnect: false,
    });
    transports.push(transport);
    hub.registerTransport(transport);
    await transport.connect();
    return {
      url,
      rpc: <T>(name: string, input: unknown) =>
        hub.request<T>('operation.invoke', { name, input }, { timeout: 30_000 }),
    };
  }

  async function attach(
    local: Awaited<ReturnType<typeof start>>,
    remote: typeof local,
    id: string
  ) {
    const pairing = await remote.rpc<{ ok: boolean; approval?: string; code?: string }>(
      'device.pair.create',
      { kind: 'daemon' }
    );
    assert(pairing.ok && pairing.approval === 'approved', 'Could not create a daemon pairing code');
    const attached = await local.rpc<{ kind: string }>('daemon.attach', {
      daemonId: id,
      url: remote.url,
      code: pairing.code,
    });
    assert.equal(attached.kind, 'attached', 'Daemon pairing failed');
  }

  try {
    for (const dir of [
      record,
      registrations,
      sockets,
      project,
      dirname(transcript),
      join(worker, 'bin'),
      join(home, 'bin'),
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(transcript, '');
    writeFileSync(
      join(record, `${ref.id}.json`),
      JSON.stringify({
        sessionId: ref.id,
        cliSessionId: sessionId,
        cwd: project,
        title: 'Inbox proof',
        permissionMode: 'auto',
      })
    );
    writeFileSync(
      join(worker, 'peer.json'),
      JSON.stringify([{ sessionId, pid: process.pid, status: 'waiting' }])
    );
    writeFileSync(
      join(registrations, `${process.pid}.json`),
      JSON.stringify({
        sessionId,
        pid: process.pid,
        procStart: 1,
        entrypoint: 'claude-desktop',
        version: '2.1.302',
        peerProtocol: 1,
        peerFeatures: ['notify_idle'],
        messagingSocketPath: socketPath,
      })
    );
    writeFileSync(
      join(worker, 'bin/claude'),
      `#!/bin/sh\n[ "$1 $2" = 'agents --json' ] || exit 1\ncat '${join(worker, 'peer.json')}'\n`,
      { mode: 0o700 }
    );
    writeFileSync(join(home, 'bin/claude'), '#!/bin/sh\necho "[]"\n', { mode: 0o700 });
    await new Promise<void>((done, fail) => peer.listen(socketPath, done).once('error', fail));
    chmodSync(socketPath, 0o600);

    const source = await start(home);
    const target = await start(worker);
    await attach(source, target, ref.daemon);
    const send = (message: string) =>
      source.rpc<Result<WorkDelivery>>('work.send', {
        ref,
        mode: 'steer',
        from: `session:${senderId}`,
        message,
      });

    const rejected = await send(refused);
    evidence.rejected = rejected;
    assert.equal(rejected.ok, false);
    assert.match(rejected.detail, /Claude inbox reply daemon is not attached/);
    assert.equal(frames.length, 0);

    await attach(target, source, alias);
    const delivered = await send(text);
    evidence.delivered = delivered;
    assert(delivered.ok && delivered.value.delivered, JSON.stringify(delivered));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].uuid, delivered.value.receipt?.inputId);
    assert(frames[0].message.content.includes(text));

    await new Promise<void>((done, fail) => {
      const socket = createConnection(frames[0].from.slice(4));
      socket.once('error', fail);
      socket.once('close', () => done());
      socket.once('connect', () => {
        socket.end(
          JSON.stringify({
            msgV: 1,
            msg_id: replyId,
            type: 'user',
            from: `uds:${socketPath}`,
            message: { role: 'user', content: replyText },
          }) + '\n'
        );
      });
    });
    const db = new Database(join(home, 'data/daemon.db'), { readonly: true });
    try {
      const query = db.prepare(
        "SELECT count(*) AS n FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') = ? AND json_extract(payload, '$.message.message.content') LIKE ?"
      );
      let replies = 0;
      for (let n = 0; n < 50 && replies === 0; n++) {
        replies = (query.get(senderId, `%${replyText}%`) as { n: number }).n;
        if (replies === 0) await delay(100);
      }
      evidence.replies = replies;
      assert.equal(replies, 1);
    } finally {
      db.close();
    }
    console.log(
      'One pre-attachment rejection, one confirmed Desktop inbox write, one reply in the sender mailbox.'
    );
  } finally {
    save();
    await Promise.all(transports.map((transport) => transport.close()));
    for (const child of children) child.process.kill('SIGTERM');
    const exitCodes = await Promise.all(children.map((child) => child.exited));
    console.log(JSON.stringify({ daemonExitCodes: exitCodes, inboxFrames: frames.length }));
    if (peer.listening) await new Promise<void>((done) => peer.close(() => done()));
    assert(
      exitCodes.every((code) => code === 0),
      'An isolated daemon did not shut down cleanly'
    );
  }
}
