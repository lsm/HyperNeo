import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { ArtifactRef } from '../../../packages/shared/src/types/artifact-file.ts';
const root = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(root, 'data'));
await mkdir(join(root, 'evidence'), { recursive: true });
const seed = Bun.spawn([process.execPath, fileURLToPath(new URL('./worker-identity-seed.ts', import.meta.url)), root], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
assert.equal(await seed.exited, 0, await new Response(seed.stdout).text());
const daemon = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(root, 'data/daemon.db'), workspaceRoot: join(root, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
type Reply = { accepted: boolean; reason?: string; artifact?: ArtifactRef; data?: string };
const evidence: Record<string, unknown> = { synthetic: true, port: daemon.server.port };
try {
  assert.notEqual(daemon.server.port, 8399);
  await transport.initialize();
  const invoke = (name: string, input: unknown) => hub.request<Reply>('operation.invoke', { name, input });
  const input = { requestId: 'chosen-report', context: { kind: 'todo', id: 'worker-todo' }, path: join(root, 'outside.md'), title: 'Chosen report' };
  await writeFile(input.path, '# Outside workspace\n');
  const outside = await invoke('artifact.file.register', input);
  const unknownContext = await invoke('artifact.file.register', { ...input, context: { kind: 'todo', id: 'not-recorded' } });
  const revisionInput = { ...input, requestId: 'revision', path: join(root, 'workspace/report.md') };
  await writeFile(revisionInput.path, '# First revision\n');
  const first = await invoke('artifact.file.register', revisionInput);
  await writeFile(revisionInput.path, '# Second revision\n');
  const second = await invoke('artifact.file.register', revisionInput);
  Object.assign(evidence, { outside, unknownContext, first, second });
  assert.equal(outside.accepted, true, JSON.stringify(outside));
  assert.equal(unknownContext.accepted, true, JSON.stringify(unknownContext));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true, JSON.stringify(second));
  assert.notEqual(first.artifact!.artifactId, second.artifact!.artifactId);
  assert.deepEqual(await invoke('artifact.file.register', revisionInput), second);
  for (const [receipt, text] of [[outside, '# Outside workspace\n'], [first, '# First revision\n'], [second, '# Second revision\n']] as const) {
    const read = await invoke('artifact.file.read', { artifactId: receipt.artifact!.artifactId });
    assert.equal(read.accepted, true);
    assert.equal(Buffer.from(read.data!, 'base64').toString(), text);
  }
  await rename(revisionInput.path, join(root, 'workspace/retained.md'));
  assert.deepEqual(await invoke('artifact.file.register', revisionInput), second);
  const changedPath = await invoke('artifact.file.register', { ...revisionInput, path: input.path });
  assert.equal(changedPath.accepted, true);
  assert.notEqual(changedPath.artifact!.artifactId, second.artifact!.artifactId);
  await mkdir(join(root, 'home/.codex/reports'), { recursive: true });
  const benign = join(root, 'home/.codex/reports/report.md');
  await writeFile(benign, '# Benign application folder\n');
  assert.equal((await invoke('artifact.file.register', { ...input, path: benign })).accepted, true);
  const refusals: unknown[] = [];
  for (const path of ['.env', '.ssh/id_ed25519', '.codex/auth.json', '.codex/config.toml', 'credentials.json', 'private.key', 'secrets.txt']) {
    const reply = await invoke('artifact.file.register', { ...input, path: join(root, 'home', path) });
    assert.deepEqual(reply, { accepted: false, reason: 'sensitive_path' });
    refusals.push({ path, reply });
  }
  await symlink(join(root, 'home/.codex/auth.json'), join(root, 'alias.md'));
  await symlink(join(root, 'home/.ssh'), join(root, 'alias-dir'));
  for (const path of [join(root, 'alias.md'), join(root, 'alias-dir/report.md'), join(root, 'workspace') + '/../home/.codex/auth.json'])
    assert.deepEqual(await invoke('artifact.file.register', { ...input, path }), { accepted: false, reason: 'unsafe_path' });
  daemon.db.getDatabase().prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'codex-desktop', id: 'missing-native-cwd' }), 'worker-todo');
  assert.equal((await invoke('artifact.file.register', { ...input, requestId: 'missing-native' })).accepted, true);
  Object.assign(evidence, { changedPath, refusals, oldAndNewBytesRead: true, noContextVeto: true, passed: true });
} finally {
  await writeFile(join(root, 'evidence/attachment-paths.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await daemon.cleanup();
}
