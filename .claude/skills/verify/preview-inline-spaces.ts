import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const run = realpathSync(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const rpc = process.argv.includes('--rpc');
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const seed = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-resolve.ts', import.meta.url)), run, 'seed'],
  { env: process.env, stdout: 'pipe', stderr: 'inherit' });
assert.equal(await seed.exited, 0, await new Response(seed.stdout).text());
const data = join(run, 'data'), workspace = join(run, 'workspace');
const db = new Database(join(data, 'daemon.db'));
const text = 'Read `notes.md` and `My notes.md`. Also `Linked notes.md`, `missing notes.md`, `../outside.md`, `$(pwd)/notes.md` and `cat notes.md`.';
const body = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
db.prepare("UPDATE sdk_message_bodies SET sdk_message = ? WHERE seq = (SELECT rowid FROM sdk_messages WHERE id='source')").run(body);
db.prepare("UPDATE neo_todos SET evidence = ? WHERE id='todo'").run(text);
for (const name of ['notes.md', 'My notes.md', 'unmentioned notes.md']) writeFileSync(join(workspace, name), `# Synthetic ${name}\nComplete reviewable bytes.\n`);
writeFileSync(join(run, 'outside.md'), '# Outside the authorized workspace\n');
symlinkSync(join(run, 'outside.md'), join(workspace, 'Linked notes.md'));
const registry = createOperationRegistry([createArtifactReferenceResolve(() => db, data, join(run, 'home')), ...createArtifactReadOperations(() => db, data)]);
type Reply = { accepted?: boolean; artifact?: { artifactId: string }; data?: string };
let remote: ((name: string, input: unknown) => Promise<Reply>) | undefined;
let stop = async () => {};
const evidence: Record<string, unknown> = { mode: rpc ? 'isolated-daemon-websocket' : 'native-operation', chatSpaced: false, todoSpaced: false };
async function call(name: string, input: unknown): Promise<Reply> {
  if (remote) return remote(name, input);
  const result = await invokeOperation(registry, name, input, { source: 'rpc', principal: 'local' });
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  return (result as { value: Reply }).value;
}
try {
  if (rpc) {
    const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
    const { getConfig } = await import('../../../packages/daemon/src/config.ts');
    const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
    const daemon = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') }), verbose: false });
    assert(![8399, 8499].includes(daemon.server.port));
    evidence.port = daemon.server.port;
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
    hub.registerTransport(transport);
    stop = async () => { await transport.close(); await daemon.cleanup(); };
    await transport.initialize();
    remote = (name, input) => hub.request('operation.invoke', { name, input });
  }
  for (const [kind, id] of [['message', 'source'], ['todo', 'todo']] as const) {
    const sourceMessageOrCard = { kind, id };
    for (const reference of ['notes.md', 'My notes.md']) {
      const input = { sourceMessageOrCard, reference, requestId: randomUUID() };
      const receipt = await call('artifact.reference.resolve', input);
      evidence[`${kind}:${reference}`] = receipt.accepted;
      assert.equal(receipt.accepted, true, `${kind} must resolve the entire literal ${reference}`);
      assert.deepEqual(await call('artifact.reference.resolve', input), receipt);
      const read = await call('artifact.file.read', { artifactId: receipt.artifact!.artifactId });
      assert.equal(Buffer.from(read.data!, 'base64').toString(), `# Synthetic ${reference}\nComplete reviewable bytes.\n`);
    }
    for (const reference of ['Linked notes.md', 'missing notes.md', '../outside.md', 'unmentioned notes.md', '$(pwd)/notes.md', 'cat notes.md']) {
      const refused = await call('artifact.reference.resolve', { sourceMessageOrCard, reference, requestId: randomUUID() });
      assert.equal(refused.accepted, false, `${kind} must refuse ${reference}`);
    }
    evidence[kind === 'message' ? 'chatSpaced' : 'todoSpaced'] = true;
  }
  evidence.safetyChecks = true;
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  await stop(); db.close();
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/inline-spaces.json'), JSON.stringify(evidence, null, 2));
}
