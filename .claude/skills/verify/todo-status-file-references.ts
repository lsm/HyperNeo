import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const [mode, selected] = process.argv.slice(2), run = realpathSync(process.argv.at(-1)!);
assert(['native', 'rpc'].includes(mode));
assert(['all', 'blockedReason', 'nextAction'].includes(selected));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
execFileSync('bun', [fileURLToPath(new URL('./preview-register.ts', import.meta.url)), run, 'seed'], { env: process.env, stdio: 'pipe' });
const data = join(run, 'data'), home = join(run, 'home'), workspace = join(run, 'workspace');
const db = new Database(join(data, 'daemon.db'));
const work = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
const cases = [
  { field: 'title', column: 'title', file: 'ordinary-source.md' },
  { field: 'blockedReason', column: 'blocked_reason', file: 'blocked-source.md' },
  { field: 'nextAction', column: 'next_action', file: 'next-source.md' },
].filter(item => item.field === 'title' || selected === 'all' || item.field === selected);
for (const item of cases) {
  const id = `source-${item.field}`;
  work.addTodo(id, 'ask', { title: 'Synthetic attachment', doneWhen: '', check: null, instruction: '', named: null }, 1);
  sessions.create(id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'local', name: 'Synthetic', folder: workspace } });
  sessions.recordRef(id, { adapter: 'hyperneo', id: 'worker' });
  db.prepare(`UPDATE neo_todos SET ${item.column} = ? WHERE id = ?`).run(`Read \`~/${item.file}\`.`, id);
  writeFileSync(join(home, item.file), `# ${item.field}\nUnique synthetic attachment bytes.\n`);
}
writeFileSync(join(home, 'unmentioned.md'), '# Exists but absent from every source field\n');
const registry = createOperationRegistry([createArtifactReferenceResolve(() => db, data, home), ...createArtifactReadOperations(() => db, data)]);
type Reply = { accepted: boolean; reason?: string; artifact?: { artifactId: string }; data?: string };
let remote: ((name: string, input: unknown) => Promise<Reply>) | undefined;
let stop = async () => {};
const evidence: { mode: string; passed: boolean; cases: Record<string, unknown>[]; unmentioned?: Reply; port?: number; codeHead: string } = { mode, passed: false, cases: [], codeHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' }).trim() };
async function call(name: string, input: unknown): Promise<Reply> {
  if (remote) return remote(name, input);
  const result = await invokeOperation(registry, name, input, { source: 'rpc', principal: 'local' });
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  return (result as { value: Reply }).value;
}
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
try {
  if (mode === 'rpc') {
    const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
    const { getConfig } = await import('../../../packages/daemon/src/config.ts');
    const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
    const app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') }), verbose: false });
    stop = () => app.cleanup();
    await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
    assert.notEqual(app.server.port, 8399); evidence.port = app.server.port;
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
    hub.registerTransport(transport);
    stop = async () => { try { await transport.close(); } finally { await app.cleanup(); } };
    await transport.initialize();
    remote = (name, input) => hub.request('operation.invoke', { name, input });
  }
  for (const item of cases) {
    const tap = { sourceMessageOrCard: { kind: 'todo', id: `source-${item.field}` }, reference: `~/${item.file}`, requestId: randomUUID() };
    const receipt = await call('artifact.reference.resolve', tap);
    const observed: Record<string, unknown> = { field: item.field, reference: tap.reference, receipt };
    evidence.cases.push(observed);
    if (receipt.accepted) {
      const read = await call('artifact.file.read', { artifactId: receipt.artifact!.artifactId });
      assert.equal(read.accepted, true);
      assert.equal(Buffer.from(read.data!, 'base64').toString(), `# ${item.field}\nUnique synthetic attachment bytes.\n`);
      assert.deepEqual(await call('artifact.reference.resolve', tap), receipt);
      observed.exactBytesRead = true; observed.retryStable = true;
    }
  }
  evidence.unmentioned = await call('artifact.reference.resolve', { sourceMessageOrCard: { kind: 'todo', id: 'source-title' }, reference: '~/unmentioned.md', requestId: randomUUID() });
  assert.equal(evidence.unmentioned.accepted, false);
  assert(evidence.cases.every(item => (item.receipt as Reply).accepted), JSON.stringify(evidence.cases));
  evidence.passed = true;
} finally {
  try { await stop(); } finally {
    db.close(); globalThis.fetch = network;
    mkdirSync(join(run, 'evidence'), { recursive: true });
    writeFileSync(join(run, 'evidence/todo-status-file-references.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log(JSON.stringify(evidence));
