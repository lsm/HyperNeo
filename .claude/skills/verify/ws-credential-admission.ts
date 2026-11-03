import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sockets: WebSocket[] = [];
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  for (const [name, headers] of [
    ['anonymous', {}],
    ['unknown', { authorization: 'Bearer not-a-paired-device' }],
    ['peer', { authorization: `Bearer ${'b'.repeat(64)}` }],
  ] as const) {
    const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, { headers });
    sockets.push(socket);
    const opened = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade probe timed out')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(true); };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
    });
    socket.close();
    evidence[`${name}Opened`] = opened;
    assert.equal(opened, false, `${name} WebSocket must not be admitted`);
  }
  for (const [name, headers] of [
    ['anonymous', {}],
    ['unknown', { authorization: 'Bearer not-a-paired-device' }],
    ['peer', { authorization: `Bearer ${'b'.repeat(64)}` }],
    ['proxied-browser', { origin: 'https://daemon.example', host: 'daemon.example' }],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${app.server.port}/ws`, { headers });
    evidence[name] = response.status;
    assert.equal(response.status, 401, `${name} must be refused before WebSocket upgrade`);
  }
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(root, 'packages/cli/main.ts'), ...args], {
      cwd: root,
      env: { ...process.env, HYPERNEO_SESSION_ID: 'synthetic-local-worker' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    assert.equal(await child.exited, 0, `source CLI failed: ${errors}`);
    return JSON.parse(output);
  };
  const local = await readLocalCredential();
  const call = async (headers: Record<string, string>, name: string, input = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, { headers });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    const id = crypto.randomUUID();
    return await new Promise<{ data?: unknown; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RPC timed out')), 5000);
      ws.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.requestId !== id && reply.id !== id) return;
        clearTimeout(timer);
        resolve(reply);
      };
      ws.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0', data: { name, input } }));
    });
  };
  const localReply = await call({ authorization: `Bearer ${local}` }, 'system.build');
  assert(!localReply.error);
  evidence.localRpc = Boolean(localReply.data);
  const build = await cli('build');
  assert.equal(build.pid, process.pid);
  evidence.localCli = true;
  let humanHeaders: Record<string, string> = {};
  for (const kind of ['human', 'daemon'] as const) {
    const code = await cli('pair', '--kind', kind, '--name', `Synthetic ${kind}`);
    assert.equal(code.approval, kind === 'human' ? 'approved' : 'pending');
    if (kind === 'daemon') {
      const approval = await call(humanHeaders, 'device.pair.approve', { codeId: code.codeId });
      assert(!approval.error);
    }
    const paired = await fetch(`http://127.0.0.1:${app.server.port}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(kind === 'human' ? { origin: `http://127.0.0.1:${app.server.port}` } : {}) },
      body: JSON.stringify({ code: code.code, name: `Synthetic ${kind}` }),
    });
    assert.equal(paired.status, 200);
    const result = await paired.json() as { credential?: string };
    const headers = kind === 'human' ? { cookie: paired.headers.get('set-cookie')!.split(';')[0] } : { authorization: `Bearer ${result.credential}` };
    if (kind === 'human') humanHeaders = headers;
    const reply = await call(headers, kind === 'human' ? 'system.build' : 'work.adapters');
    assert(!reply.error);
    evidence[kind] = Boolean(reply.data);
    if (kind === 'daemon') {
      assert((await call(headers, 'system.build')).error);
      evidence.daemonOwnerDenied = true;
    } else assert.equal(result.credential, undefined);
  }
  evidence.verified = true;
} finally {
  for (const socket of sockets) socket.close();
  await app.cleanup();
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/ws-credential-admission.json'), JSON.stringify(evidence, null, 2));
}
