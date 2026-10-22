import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
const [port, runText, mode = 'verify'] = process.argv.slice(2);
const run = resolve(runText);
assert(Number(port) > 0 && Number(port) !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const { root, ref } = JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8'));
assert.equal(ref.id, 'synthetic-worker');
if (mode === 'renamed') {
  const own = new Database(join(run, 'home/.codex/state_5.sqlite'));
  own.prepare('UPDATE threads SET name=? WHERE id=?').run('fullstack-renamed', ref.id);
  own.close();
  const state = new Database(join(run, 'data/daemon.db'));
  state.prepare('UPDATE sessions SET title=? WHERE id=?').run('Renamed Neo', root);
  state.close();
}
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('connect failed')); });
const replies: unknown[] = [];
const rpc = (method: string, data: unknown) => new Promise<any>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 15000);
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timer);
    replies.push({ method, data, reply });
    if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
  };
  socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
try {
  const snapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} });
  const find = await rpc('operation.invoke', { name: 'work.find', input: { id: ref.id, localOnly: true } });
  const status = await rpc('operation.invoke', { name: 'work.status', input: { ref } });
  const session = await rpc('state.session', { sessionId: root });
  if (mode === 'reproduce') {
    assert.equal(snapshot.todoAsks[0].todos[0].worker, undefined);
  } else {
    const name = mode === 'verify' ? 'Claude something' : 'fullstack-renamed';
    const worker = { ...ref, name, label: `Codex · ${name}` };
    assert.deepEqual(snapshot.todoAsks[0].todos[0].worker, worker);
    assert.deepEqual(find.places.flatMap((place: any) => place.work).find((item: any) => item.ref.id === ref.id).worker, worker);
    assert.deepEqual(status.value.worker, worker);
    assert.deepEqual(snapshot.session, { id: root, adapter: 'hyperneo', name: mode === 'verify' ? 'Synthetic Neo' : 'Renamed Neo', label: mode === 'verify' ? 'HyperNeo · Synthetic Neo' : 'HyperNeo · Renamed Neo' });
    assert.deepEqual(session.worker, snapshot.session);
    const inventory = await rpc('operation.invoke', { name: 'daemon.snapshot', input: {} });
    assert.deepEqual(inventory.resources.find((resource: any) => resource.kind === 'session').entries.find((entry: any) => entry.id === root).worker, snapshot.session);
    const notices = snapshot.sessionNoticeGroups.flatMap((group: any) => group.notices);
    assert.deepEqual(notices.find((notice: any) => notice.key === 'worker-notice').worker, worker);
    assert.deepEqual(notices.find((notice: any) => notice.key === 'missing-notice').worker, { id: 'missing-worker', adapter: 'codex-desktop', name: null, label: 'Codex · missing-worker' });
    assert(!JSON.stringify(snapshot.sessionNoticeGroups).includes('Creation-time name'));
    assert(!JSON.stringify(snapshot.sessionNoticeGroups).includes('Old deleted name'));
    if (mode === 'header') {
    const sent = await rpc('operation.invoke', { name: 'message.send', input: { sessionId: root, from: 'session:codex-desktop:synthetic-worker', message: { type: 'user', message: { role: 'user', content: `Synthetic identity report ${mode}` }, parent_tool_use_id: null } } });
    assert.equal(sent.kind, 'accepted');
    const own = new Database(join(run, 'data/daemon.db'), { readonly: true });
    const queued = own.prepare('SELECT payload FROM job_queue WHERE payload LIKE ?').all(`%${sent.messageId}%`);
    own.close();
    assert(queued.some((row: any) => row.payload.includes('from-name=') && row.payload.includes(`Codex · ${name}`)), 'queued header names the current adapter record');
    replies.push({ queued });
    const missing = await rpc('operation.invoke', { name: 'message.send', input: { sessionId: root, from: 'session:neo:deleted-sender', message: { type: 'user', message: { content: 'Synthetic missing native sender' }, parent_tool_use_id: null } } });
    assert.equal(missing.kind, 'accepted');
    const saved = new Database(join(run, 'data/daemon.db'), { readonly: true });
    const missingRows = saved.prepare('SELECT payload FROM job_queue WHERE payload LIKE ?').all(`%${missing.messageId}%`);
    saved.close();
    assert(missingRows.some((row: any) => row.payload.includes('HyperNeo · neo:deleted-sender')), 'missing native sender keeps full ID');
    replies.push({ missingRows });
    const log = join(run, 'evidence/claude-agents.log');
    const count = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const before = count();
    for (let i = 0; i < 2; i++) {
      const history = await rpc('operation.invoke', { name: 'work.find', input: { text: 'workerhistoryprobe', adapters: ['claude-code'], localOnly: true } });
      const work = history.places.flatMap((place: any) => place.work);
      assert.equal(work.length, 10);
      assert(work.every((item: any) => item.title.startsWith('workerhistoryprobe plan ') && item.worker.name === null && item.worker.label === `Claude · ${item.ref.id}`));
      assert.equal(count() - before, i + 1, 'one actual CLI invocation per batch, fresh read on next batch');
    }
    const exact = await rpc('operation.invoke', { name: 'work.find', input: { session: 'workerhistoryprobe plan 0', adapters: ['claude-code'], localOnly: true } });
    assert.equal(exact.session.match, 'exact');
    const near = await rpc('operation.invoke', { name: 'work.find', input: { session: 'workerhistoryprobe', adapters: ['claude-code'], localOnly: true } });
    assert.equal(near.session.match, 'none');
    assert(near.session.near.every((item: any) => item.title.startsWith('workerhistoryprobe plan ') && item.worker.name === null));
    replies.push({ claudeCliCalls: count() - before });

    }
  }
  console.log(`${mode} PASS`);
} finally {
  writeFileSync(join(run, `evidence/rpc-${mode}.json`), JSON.stringify(replies, null, 2));
  socket.close();
}
