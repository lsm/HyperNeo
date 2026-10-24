import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'fresh synthetic DB required');
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const setting = { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/repo' }, key: 'mergePolicy', value: 'review_bot' };
for (const phase of ['initial', 'restart']) {
  const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
  let ws: WebSocket | undefined;
  try {
    await app.spaceRuntimeService.ready();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
    const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
      ws!.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        evidence.push({ phase, name, input, reply });
        if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
      };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    if (phase === 'initial') {
      assert.deepEqual((await rpc('pack.preferences.list', {})).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos'), []);
      assert.equal((await rpc('pack.preferences.get', setting)).preference, null);
      assert.equal((await rpc('pack.preferences.set', setting)).ok, true);
      assert.equal((await rpc('pack.preferences.set', { ...setting, value: 'invented' })).ok, false);
    }
    const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-agent', role: 'neo' }));
    const denied = await mcp({ name: 'pack.preferences.set', input: { ...setting, value: 'ci_only' } });
    evidence.push({ phase, agentMcp: denied });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
    const read = (await rpc('pack.preferences.get', setting)).preference;
    assert.equal(read.value, 'review_bot');
    assert.equal(read.setBy, 'human');
    assert(read.setAt > 0);
    assert.deepEqual((await rpc('pack.preferences.list', {})).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos'), [read]);
    const snapshot = await rpc('neo.snapshot', {});
    assert.deepEqual(snapshot.packPreferences.filter((row: { key: string }) => row.key !== 'watchedRepos'), [read]);
    const agentRead = await mcp({ name: 'pack.preferences.get', input: setting });
    assert.deepEqual(JSON.parse(agentRead.content[0].text).preference, read);
    evidence.push({ phase, agentRead });
    assert.equal((await rpc('pack.preferences.get', { ...setting, scope: { kind: 'repo', key: 'synthetic/new' } })).preference, null);
  } finally { ws?.close(); await app.cleanup(); }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: human RPC writes, agent MCP refused, get/list/snapshot persist through restart. Evidence: ${run}/evidence/observed.json`);
