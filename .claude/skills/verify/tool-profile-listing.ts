import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { operationInvoke } from '../../../packages/daemon/tests/helpers/operation-mcp.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder, { recursive: true });
assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=dev', folder]).status, 0);
assert.equal(
  spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: folder }).status,
  0
);
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
try {
  assert.notEqual(app.server.port, 8399);
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('connection failed'));
  });
  const rpc = (method: string, data: unknown) =>
    new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID();
      ws.addEventListener('message', function receive(event: MessageEvent) {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        ws.removeEventListener('message', receive);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data);
      });
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  const started = (await rpc('operation.invoke', {
    name: 'work.start',
    input: { adapter: 'hyperneo', place: { machine: hostname(), folder, name: 'Synthetic' }, title: 'Synthetic worker', message: 'Synthetic task only' },
  })) as Result<WorkStarted>;
  assert(started.ok, JSON.stringify(started));
  const manual = (await rpc('session.create', { workspacePath: folder, title: 'Synthetic manual' })) as { sessionId: string };
  const listed = async (sessionId: string) => {
    const session = await app.sessionManager.getSessionAsync(sessionId);
    assert(session, `session ${sessionId} not found`);
    const reply = await operationInvoke(session.getOperationMcpServer())({ name: 'operations.list' });
    const content = reply.content[0];
    assert(content.type === 'text');
    return (JSON.parse(content.text) as { name: string }[]).map((entry) => entry.name).sort();
  };
  const worker = await listed(started.value.ref.id);
  const human = await listed(manual.sessionId);
  const orchestration = (names: string[]) => names.filter((name) => /^(neo|pack|work)\./.test(name));
  const observed = {
    workerProfile: app.db.getSession(started.value.ref.id)?.config.toolProfile ?? null,
    manualProfile: app.db.getSession(manual.sessionId)?.config.toolProfile ?? null,
    workerCount: worker.length,
    manualCount: human.length,
    workerOrchestration: orchestration(worker),
    manualOrchestration: orchestration(human),
    workerHasMessageSend: worker.includes('message.send'),
  };
  writeFileSync(join(run, 'evidence/tool-profile-listing.json'), JSON.stringify({ observed, worker, manual: human }, null, 2));
  console.log(JSON.stringify(observed, null, 2));
  assert.equal(observed.workerProfile, 'worker');
  assert.equal(observed.manualProfile, null);
  assert.deepEqual(observed.workerOrchestration, []);
  assert(observed.manualOrchestration.includes('work.start'));
  assert(observed.workerHasMessageSend);
} finally {
  ws.close();
  await app.cleanup();
}
