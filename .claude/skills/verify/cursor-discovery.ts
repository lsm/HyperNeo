import { strict as assert } from 'node:assert';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { Result } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import type { z } from 'zod';

const [portText, mode, executable, run] = process.argv.slice(2);
const port = Number(portText);
assert(run && Number.isInteger(port) && port > 0 && port !== 8399);
assert(mode === 'fixture' || mode === 'signed-out');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const cliDir = join(run, 'home/.local/bin');
mkdirSync(cliDir, { recursive: true });
const cli = join(cliDir, 'cursor-agent');
if (mode === 'signed-out') symlinkSync(executable, cli);
else
  writeFileSync(
    cli,
    `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'acp') process.exit(2);
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  let result;
  if (method === 'initialize' && params.protocolVersion === 1) {
    result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } };
    initialized = true;
  } else if (initialized && method === 'session/list') {
    result = { sessions: [
      { sessionId: 'cursor-alpha', cwd: '/synthetic/alpha', title: 'Alpha session', updatedAt: '2026-11-19T15:00:00Z' },
      { sessionId: 'cursor-beta', cwd: '/synthetic/beta' },
    ].filter(session => !params.cwd || session.cwd === params.cwd) };
  } else process.exit(3);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
`,
    { mode: 0o700 }
  );
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
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
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Isolated RPC connection failed'));
  });
  async function rpc<T>(name: string, input: object): Promise<T> {
    calls++;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 20_000);
      const receive = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', receive);
        if (reply.error) reject(new Error(JSON.stringify(reply.error)));
        else resolve(reply.data);
      };
      ws.addEventListener('message', receive);
      ws.send(
        JSON.stringify({
          id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
          data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0',
        })
      );
    });
  }
  const adapter = 'cursor-cli';
  const registered = await rpc<Result<{ id: string; capabilities: string[] }[]>>('work.adapters', {});
  assert(registered.ok);
  assert.deepEqual(registered.value.find((entry) => entry.id === adapter)?.capabilities, ['find']);
  async function find(query = {}) {
    const result = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
      adapters: [adapter], localOnly: true, ...query,
    });
    const sessions = result.places.flatMap((group) => group.work);
    return { sessions, unreachable: result.unreachable };
  }
  const all = await find();
  if (mode === 'fixture') {
    assert.deepEqual(all.unreachable, []);
    assert.equal(all.sessions.length, 2);
    assert.equal(all.sessions.find((session) => session.ref.id === 'cursor-beta')?.title, 'Untitled Cursor session');
    const alpha = await find({ folder: '/synthetic/alpha', text: 'alpha session' });
    assert.deepEqual(alpha.sessions.map(({ ref }) => [ref.adapter, ref.id]), [[adapter, 'cursor-alpha']]);
    assert.equal(alpha.sessions[0].lastActivityAt, Date.parse('2026-11-19T15:00:00Z'));
    assert.equal((await find({ text: 'missing' })).sessions.length, 0);
  } else {
    assert.equal(all.sessions.length, 0);
    assert.deepEqual(all.unreachable, [
      { source: adapter, reason: 'Cursor CLI authentication required. Run cursor-agent login.' },
    ]);
  }
  process.stdout.write(JSON.stringify({
    mode,
    calls,
    sessions: all.sessions.length,
    unreachable: all.unreachable.length,
  }) + '\n');
} finally {
  socket?.close();
  await app.cleanup();
}
