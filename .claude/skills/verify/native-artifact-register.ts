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
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createHash } from 'node:crypto';
import { createArtifactRefReader } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { ArtifactReferenceSourceRepository } from '../../../packages/daemon/src/storage/repositories/artifact-reference-source.ts';
import { captureGitArtifact } from '../../../packages/daemon/src/lib/artifacts/git-capture.ts';

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
  for (const [path, reason] of [['../outside.md', 'unsafe_path'], ['.env', 'sensitive_path']])
    assert.deepEqual(await invoke('artifact.file.register', { ...input, requestId: path, path }), { accepted: false, reason });
  const neoId = 'neo:10000000-0000-4000-8000-000000008120';
  const neoWorkspace = join(root, 'neo-workspace');
  await mkdir(neoWorkspace);
  await writeFile(join(neoWorkspace, 'own.md'), '# Neo own workspace\n');
  db.prepare('UPDATE sessions SET workspace_path = ? WHERE id = ?').run(neoWorkspace, neoId);
  const neoInput = { requestId: 'neo-own', context: { kind: 'ask', id: 'worker-card' }, path: 'own.md', title: 'Neo own workspace' };
  const neo = await invoke<{ accepted: boolean; artifact: ArtifactRef }>('artifact.file.register', neoInput);
  assert.equal(neo.accepted, true);
  assert.equal((await invoke<{ accepted: boolean }>('artifact.file.register', { ...neoInput, path: join(root, 'workspace', 'report.md'), requestId: 'not-neos' })).accepted, true);
  const register = createArtifactRegistration(() => db, join(root, 'data'));
  const worker = { source: 'mcp' as const, role: 'direct_task_worker' as const, sessionId: 'codex-desktop:synthetic-worker' };
  assert.deepEqual(await register.execute(input, worker), first);
  assert.equal((await register.execute(input, { ...worker, sessionId: 'codex-desktop:other' }) as { accepted: boolean }).accepted, true);
  const getter = createArtifactReadOperations(() => db).find((op) => op.name === 'artifact.file.get')!;
  assert.equal((await getter.execute({ artifactId: first.artifact.artifactId }, worker) as { accepted: boolean }).accepted, true);
  assert.deepEqual(await getter.execute({ artifactId: first.artifact.artifactId }, { ...worker, sessionId: 'other' }), { accepted: false, reason: 'unavailable' });
  const neoCaller = { source: 'mcp' as const, role: 'neo' as const, sessionId: neoId };
  assert.deepEqual(await register.execute(neoInput, neoCaller), neo);
  assert.equal((await register.execute(neoInput, { ...neoCaller, sessionId: 'wrong-neo' }) as { accepted: boolean }).accepted, true);
  db.prepare('UPDATE neo_todos SET artifacts_json = ? WHERE id = ?').run(JSON.stringify([first.artifact, png.artifact]), context.id);
  const projected = new NeoAskTodoRepository(db).getTodo(context.id)!;
  assert.deepEqual(projected.artifacts, [first.artifact, png.artifact]);
  Object.assign(evidence, { first, png, neo, metadata, readMatchesSource: true, ownerChecks: true, explicitPathsAllowed: true, projected: true });
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
  assert.equal((await register.execute({ ...input, path: join(root, 'workspace/report.md') }, worker) as { accepted: boolean }).accepted, true);
  assert.deepEqual(await getter.execute({ artifactId: first.artifact.artifactId }, worker), { accepted: false, reason: 'unavailable' });
  evidence.revocationRechecked = true;
  const customHome = join(root, 'custom-home');
  await mkdir(join(customHome, '.codex'), { recursive: true });
  const native = new Database(join(customHome, '.codex', 'state_5.sqlite'));
  const customDb = new Database(join(root, 'data', 'daemon.db'));
  try {
    native.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT)');
    native.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('custom-worker', join(root, 'workspace'), 'desktop');
    customDb.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'codex-desktop', id: 'custom-worker' }), context.id);
    const owner = { ...worker, sessionId: 'codex-desktop:custom-worker' };
    const customInput = { ...input, requestId: 'custom-home' };
    const custom = await createArtifactRegistration(() => customDb, join(root, 'data'), customHome).execute(customInput, owner) as { accepted: boolean; artifact: ArtifactRef };
    assert.equal(custom.accepted, true);
    const customGet = createArtifactReadOperations(() => customDb, join(root, 'data')).find((op) => op.name === 'artifact.file.get')!;
    assert.equal((await customGet.execute({ artifactId: custom.artifact.artifactId }, owner) as { accepted: boolean }).accepted, true, 'custom-home authorization must use the registration native state');
    assert.deepEqual(createArtifactRefReader(() => customDb)(custom.artifact.artifactId, owner), custom.artifact);
    const sources = new ArtifactReferenceSourceRepository(customDb, custom.artifact.daemonId, customHome);
    assert.equal(sources.load({ kind: 'todo', id: context.id })?.bindings[0]?.workspacePath, join(root, 'workspace'));
    const largeText = 'Synthetic retained log line\n'.repeat(24000);
    await writeFile(join(root, 'workspace', 'large.log'), largeText);
    const largeInput = { ...customInput, requestId: 'locked-preview', path: 'large.log' };
    const capture = createArtifactRegistration(() => customDb, join(root, 'data'), customHome);
    const large = await capture.execute(largeInput, owner) as { accepted: boolean; artifact: ArtifactRef };
    assert.equal(large.accepted, true);
    native.exec('BEGIN EXCLUSIVE');
    try {
      assert.equal((await customGet.execute({ artifactId: custom.artifact.artifactId }, owner) as { accepted: boolean }).accepted, true, 'snapshot ownership must not reopen the locked native state');
      const reads = createArtifactReadOperations(() => customDb, join(root, 'data'));
      const read = reads.find((op) => op.name === 'artifact.file.read')!;
      let offset = 0;
      let chunks = 0;
      do {
        const part = await read.execute({ artifactId: large.artifact.artifactId, offset, maxBytes: 256 * 1024 }, owner) as { accepted: boolean; data: string; complete: boolean; nextOffset: number };
        assert.equal(part.accepted, true);
        assert.equal(Buffer.from(part.data, 'base64').toString(), largeText.slice(offset, part.nextOffset));
        offset = part.nextOffset;
        chunks++;
        if (part.complete) break;
      } while (offset < Buffer.byteLength(largeText));
      assert(chunks > 1);
      assert.equal(offset, Buffer.byteLength(largeText));
      assert(createArtifactRefReader(() => customDb)(large.artifact.artifactId, owner));
      const start = performance.now();
      assert.deepEqual(await capture.execute({ ...customInput, requestId: 'locked-new-capture' }, owner), { accepted: false, reason: 'ambiguous_context' });
      assert.equal((await capture.execute({ ...customInput, path: join(root, 'workspace/report.md'), requestId: 'locked-absolute' }, owner) as { accepted: boolean }).accepted, true);
      evidence.captureLockRefusalMs = performance.now() - start;
      assert(Number(evidence.captureLockRefusalMs) < 1000, 'capture must not wait for the native writer');
      customDb.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'codex-desktop', id: 'revoked' }), context.id);
      assert.deepEqual(await customGet.execute({ artifactId: large.artifact.artifactId }, owner), { accepted: false, reason: 'unavailable' });
      evidence.snapshotReadsUnderNativeLock = true;
      evidence.revocationUnderNativeLock = true;
    } finally {
      native.exec('ROLLBACK');
      customDb.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'codex-desktop', id: 'custom-worker' }), context.id);
    }
    const bytes = Buffer.from('# Synthetic pinned blob\n');
    const captured = await captureGitArtifact(customDb, join(root, 'data'), { repository: 'synthetic/repo', sha: 'a'.repeat(40), path: 'custom.md', context: { kind: 'todo', id: context.id } }, 'custom-home-git', async () => true, async () => ({ accepted: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), blobSha: 'b'.repeat(40) }), customHome) as { accepted: boolean };
    assert.equal(captured.accepted, true, 'Git authorization must use the same configured home');
    evidence.customHomeConsistent = true;
  } finally { customDb.close(); native.close(); }
  evidence.passed = true;
} finally {
  await writeFile(join(root, 'evidence', 'native-registration.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await daemon.cleanup();
}
