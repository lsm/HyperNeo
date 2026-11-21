import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createCodexSetupHost } from '../../src/lib/drivers/codex-setup-host.ts';
import { codexAppServerSocketPath } from '../../src/lib/drivers/worker-directories.ts';
import type { SpawnFn } from '../../src/lib/runtime-spawn/index.ts';

export async function exerciseCodexSetupHost(home: string) {
  const path = codexAppServerSocketPath(join(home, '.codex'));
  const agents = join(home, 'Library', 'LaunchAgents');
  await mkdir(dirname(path), { recursive: true });
  await mkdir(agents, { recursive: true });
  const labels = ['ai.hyperneo.codex-app-setup', 'ai.hyperneo.codex-app-forwarder'];
  for (const label of labels) await writeFile(join(agents, `${label}.plist`), 'fixture');
  const loaded = new Set(labels);
  const calls: string[] = [];
  const busyRead = Promise.withResolvers<void>();
  const quitting = Promise.withResolvers<void>();
  const finishQuit = Promise.withResolvers<number>();
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]);
  let active = true;
  let idleReads = 0;
  let environment = 'ws://original.example/';
  const server = createServer();
  const websockets = new WebSocketServer({ server });
  websockets.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const { id, method, params } = JSON.parse(String(bytes));
      if (id === undefined) return;
      let result: unknown = {};
      if (method === 'thread/loaded/list')
        result = params.cursor
          ? { data: ['managed-turn'], nextCursor: null }
          : { data: [], nextCursor: 'next' };
      if (method === 'thread/read') {
        result = { thread: { status: { type: active ? 'active' : 'idle' } } };
        if (active) busyRead.resolve();
        else {
          calls.push('idle');
          idleReads++;
        }
      }
      if (method === 'remoteControl/status/read') result = { status: 'connected' };
      socket.send(JSON.stringify({ id, result }));
    })
  );
  server.listen(path);
  await once(server, 'listening', { signal });

  const spawn: SpawnFn = ([command, action, target, value]) => {
    let code = 0;
    let text = '';
    let exited = Promise.resolve(0);
    if (command === '/bin/launchctl') {
      const label = target?.split('/').at(-1) ?? '';
      if (action === 'getenv') text = `${environment}\n`;
      if (action === 'setenv') environment = value;
      if (action === 'unsetenv') environment = '';
      if (action === 'print' && !loaded.has(label)) code = 1;
      if (action === 'bootout') {
        loaded.delete(label);
        calls.push(label);
      }
    } else if (command === '/usr/bin/osascript') {
      calls.push('quit');
      exited = finishQuit.promise;
      quitting.resolve();
    } else if (command === '/usr/bin/open') {
      assert.equal(target, 'com.openai.codex');
      calls.push('open');
    } else {
      assert.equal(action, 'app-server');
      calls.push(value);
    }
    return {
      stdout: new Response(text).body,
      stderr: null,
      exited: code ? Promise.resolve(code) : exited,
      exitCode: null,
      kill() {},
    };
  };
  const host = createCodexSetupHost(spawn, home);
  const pending: Promise<unknown>[] = [];
  try {
    assert.equal(await host.environment(), 'ws://original.example/');
    await host.setEnvironment('ws://fixture.example/');
    assert.equal(await host.environment(), 'ws://fixture.example/');
    await host.setEnvironment(null);
    assert.equal(environment, '');
    await host.startManaged();
    assert.equal(await host.remoteEnabled(), true);
    const restarting = host.restartApp(signal);
    pending.push(restarting);
    await Promise.race([busyRead.promise, restarting]);
    assert.deepEqual(calls, ['start']);
    active = false;
    await Promise.race([quitting.promise, restarting]);
    const send = host.admit(async () => {
      calls.push('send');
    });
    pending.push(send);
    await setImmediate();
    assert.deepEqual(calls, ['start', 'idle', 'quit']);
    finishQuit.resolve(0);
    await Promise.all([restarting, send]);
    assert.deepEqual(await host.migrate(signal), labels);
    assert.deepEqual(await host.migrate(signal), []);
    for (const label of labels)
      await assert.rejects(access(join(agents, `${label}.plist`)), { code: 'ENOENT' });
    await host.enableRemote(signal);
    assert.deepEqual(calls, [
      'start',
      'idle',
      'quit',
      'open',
      'send',
      'idle',
      labels[0],
      'idle',
      labels[1],
      'idle',
      'enable-remote-control',
    ]);
    return { idleReads, deferredRestarts: 1, heldSends: 1, migratedJobs: labels.length };
  } finally {
    abort.abort();
    finishQuit.resolve(0);
    await Promise.allSettled(pending);
    for (const client of websockets.clients) client.terminate();
    websockets.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
