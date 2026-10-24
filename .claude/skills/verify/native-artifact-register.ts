import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createArtifactRegistration } from '../../../packages/daemon/src/lib/artifacts/register-operation.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import type { ArtifactRef } from '../../../packages/shared/src/types/artifact-file.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const root = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(root, 'data'));
await mkdir(join(root, 'evidence'), { recursive: true });
const seed = Bun.spawn([process.execPath, fileURLToPath(new URL('./worker-identity-seed.ts', import.meta.url)), root], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
assert.equal(await seed.exited, 0, await new Response(seed.stdout).text());
const daemon = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(root, 'data', 'daemon.db'), workspaceRoot: join(root, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { port: daemon.server.port, synthetic: true };
try {
  assert.notEqual(daemon.server.port, 8399);
  await transport.initialize();
  const db = daemon.db.getDatabase();
  const text = '# Native workspace report\nRegistered from the recorded Codex cwd.\n';
  await writeFile(join(root, 'workspace', 'report.md'), text);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(root, 'workspace', 'comparison.png'), image);
  const context = { kind: 'todo', id: 'worker-todo' };
  const input = { requestId: 'native-report', context, path: 'report.md', title: 'Native workspace report' };
  const invoke = <T = unknown>(name: string, input: unknown) => hub.request<T>('operation.invoke', { name, input });
  const first = await invoke<{ accepted: boolean; artifact: ArtifactRef }>('artifact.file.register', input);
  assert.equal(first.accepted, true, JSON.stringify(first));
  assert.equal(first.artifact.kind, 'markdown');
  assert.deepEqual(await invoke('artifact.file.register', input), first);
  const png = await invoke<{ accepted: boolean; artifact: ArtifactRef }>('artifact.file.register', { ...input, requestId: 'native-image', path: 'comparison.png', title: 'Synthetic comparison' });
  assert.equal(png.accepted, true);
  assert.equal(png.artifact.kind, 'image');
  const read = await invoke<{ accepted: boolean; data: string }>('artifact.file.read', { artifactId: first.artifact.artifactId });
  assert.equal(read.accepted, true);
  assert.equal(Buffer.from(read.data, 'base64').toString(), text);
  const metadata = await invoke<{ accepted: boolean; metadata: { producer: unknown } }>('artifact.file.get', { artifactId: first.artifact.artifactId });
  assert.deepEqual(metadata.metadata.producer, { adapter: 'codex-desktop', id: 'synthetic-worker' });
  for (const [path, reason] of [['../outside.md', 'unsafe_path'], [join(root, 'outside.md'), 'outside_roots'], ['.env', 'sensitive_path']])
    assert.deepEqual(await invoke('artifact.file.register', { ...input, requestId: path, path }), { accepted: false, reason });
  const neoId = 'neo:10000000-0000-4000-8000-000000008120';
  const neoWorkspace = join(root, 'neo-workspace');
  await mkdir(neoWorkspace);
  await writeFile(join(neoWorkspace, 'own.md'), '# Neo own workspace\n');
  db.prepare('UPDATE sessions SET workspace_path = ? WHERE id = ?').run(neoWorkspace, neoId);
  const neoInput = { requestId: 'neo-own', context: { kind: 'ask', id: 'worker-card' }, path: 'own.md', title: 'Neo own workspace' };
  const neo = await invoke<{ accepted: boolean; artifact: ArtifactRef }>('artifact.file.register', neoInput);
  assert.equal(neo.accepted, true);
  assert.deepEqual(await invoke('artifact.file.register', { ...neoInput, path: join(root, 'workspace', 'report.md'), requestId: 'not-neos' }), { accepted: false, reason: 'outside_roots' });
  const register = createArtifactRegistration(() => db, join(root, 'data'));
  const worker = { source: 'mcp' as const, role: 'direct_task_worker' as const, sessionId: 'codex-desktop:synthetic-worker' };
  assert.deepEqual(await register.execute(input, worker), first);
  assert.deepEqual(await register.execute(input, { ...worker, sessionId: 'codex-desktop:other' }), { accepted: false, reason: 'unavailable' });
  const getter = createArtifactReadOperations(() => db).find((op) => op.name === 'artifact.file.get')!;
  assert.equal((await getter.execute({ artifactId: first.artifact.artifactId }, worker) as { accepted: boolean }).accepted, true);
  assert.deepEqual(await getter.execute({ artifactId: first.artifact.artifactId }, { ...worker, sessionId: 'other' }), { accepted: false, reason: 'unavailable' });
  const neoCaller = { source: 'mcp' as const, role: 'neo' as const, sessionId: neoId };
  assert.deepEqual(await register.execute(neoInput, neoCaller), neo);
  assert.deepEqual(await register.execute(neoInput, { ...neoCaller, sessionId: 'wrong-neo' }), { accepted: false, reason: 'unavailable' });
  db.prepare('UPDATE neo_todos SET artifacts_json = ? WHERE id = ?').run(JSON.stringify([first.artifact, png.artifact]), context.id);
  const projected = new NeoAskTodoRepository(db).getTodo(context.id)!;
  assert.deepEqual(projected.artifacts, [first.artifact, png.artifact]);
  Object.assign(evidence, { first, png, neo, metadata, readMatchesSource: true, ownerChecks: true, rootsUnchanged: true, projected: true });
  if (process.argv[3]) {
    const dist = fileURLToPath(new URL('../../../packages/web/dist/', import.meta.url));
    const web = Bun.serve({ hostname: '127.0.0.1', port: 0,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === '/ws') {
          if (server.upgrade(req, { data: { connectionSessionId: 'global', device: await daemon.authenticateUpgrade(req, server.requestIP(req)?.address ?? null) } })) return;
          return new Response('Upgrade failed', { status: 500 });
        }
        return new Response(Bun.file(resolve(dist, `.${path === '/neo' ? '/neo/index.html' : path}`)));
      }, websocket: createWebSocketHandlers(daemon.transport, daemon.sessionManager),
    });
    try {
      const browser = Bun.spawn(['node', process.argv[3], String(web.port), root], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
      assert.equal(await browser.exited, 0, await new Response(browser.stdout).text());
    } finally { web.stop(true); }
  }
  db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'codex-desktop', id: 'replacement' }), context.id);
  assert.deepEqual(await register.execute(input, worker), { accepted: false, reason: 'unavailable' });
  assert.deepEqual(await getter.execute({ artifactId: first.artifact.artifactId }, worker), { accepted: false, reason: 'unavailable' });
  evidence.revocationRechecked = true;
  evidence.passed = true;
} finally {
  await writeFile(join(root, 'evidence', 'native-registration.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await daemon.cleanup();
}
