import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const root = realpathSync(process.argv.at(-1)!);
const home = join(root, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
mkdirSync(join(root, 'tmp'), { recursive: true });
const child = Bun.spawn([
  process.execPath,
  fileURLToPath(new URL('./preview-register.ts', import.meta.url)),
  root,
  'seed',
], { env: { ...process.env, TMPDIR: join(root, 'tmp') }, stdout: 'pipe', stderr: 'inherit' });
const seeded = await new Response(child.stdout).text();
assert.equal(await child.exited, 0, seeded);
const workspace = join(home, 'HyperNeo');
renameSync(join(root, 'workspace'), workspace);
mkdirSync(join(workspace, '引用配色'));
const html = '<h1>Home-relative HTML content</h1>';
const relative = 'HyperNeo/引用配色/quote-colour-options.html';
const reference = `~/${relative}`;
const absolute = join(home, relative);
writeFileSync(absolute, html);
writeFileSync(join(home, 'outside.html'), '<h1>Outside workspace</h1>');
symlinkSync(join(home, 'outside.html'), join(workspace, 'linked.html'));
mkdirSync(join(workspace, '.ssh'));
writeFileSync(join(workspace, '.ssh', 'secret.html'), '<h1>Secret</h1>');
mkdirSync(join(workspace, '~other'));
writeFileSync(join(workspace, '~other', 'report.html'), '<h1>Literal tilde user</h1>');
writeFileSync(join(workspace, 'binary.html'), Buffer.from([0xff, 0]));
writeFileSync(join(workspace, 'large.html'), '');
truncateSync(join(workspace, 'large.html'), 64 * 1024 * 1024 + 1);
const data = join(root, 'data');
const db = new Database(join(data, 'daemon.db'));
try {
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES ('neo','Synthetic',?,'now','now','active','{}','{}')`).run(workspace);
  const denied = [
    ['~other/report.html', 'unavailable'],
    ['~', 'unavailable'],
    ['~/outside.html', 'outside_roots'],
    ['~/HyperNeo/../outside.html', 'unavailable'],
    ['~/HyperNeo/%2e%2e/outside.html', 'unavailable'],
    ['~/HyperNeo/linked.html', 'unavailable'],
    ['~/HyperNeo/.ssh/secret.html', 'sensitive_path'],
    ['~/HyperNeo/binary.html', 'unsupported_type'],
    ['~/HyperNeo/large.html', 'size_limit'],
  ];
  const publicationId = randomUUID();
  const origin = { sessionId: 'neo', messageId: 'm' };
  assert(new NeoPublicationRepository(db).append({
    conversationId: randomUUID(), publicationId,
    producerInput: origin, askOrigin: origin,
    shortText: `Read \`${reference}\``,
    fullText: [absolute, ...denied.map(([path]) => path)].map((path) => `\`${path}\``).join('\n\n'),
    links: [],
  }).accepted);
  const registry = createOperationRegistry([
    createArtifactReferenceResolve(() => db, data, home),
    ...createArtifactReadOperations(() => db, data),
  ]);
  const human = { source: 'rpc' as const, principal: 'local' as const };
  async function call(name: string, input: unknown) {
    const result = await invokeOperation(registry, name, input, human);
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    return (result as { kind: 'completed'; value: {
      accepted: boolean; reason?: string; artifact: { artifactId: string };
      data: string; metadata: { sha256: string };
    } }).value;
  }
  const tap = (path: string) => call('artifact.reference.resolve', {
    sourceMessageOrCard: { kind: 'publication', id: publicationId },
    reference: path, requestId: randomUUID(),
  });
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n;
  assert.equal(count(), 0);
  const receipt = await tap(reference);
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  assert.equal(count(), 1);
  const id = { artifactId: receipt.artifact.artifactId };
  assert.equal(Buffer.from((await call('artifact.file.read', id)).data, 'base64').toString(), html);
  const absoluteReceipt = await tap(absolute);
  assert(absoluteReceipt.accepted);
  const metadata = (await call('artifact.file.get', id)).metadata;
  assert.equal((await call('artifact.file.get', { artifactId: absoluteReceipt.artifact.artifactId })).metadata.sha256, metadata.sha256);
  for (const [path, reason] of denied) {
    const before = count();
    assert.equal((await tap(path)).reason, reason, path);
    assert.equal(count(), before, path);
  }
  assert.equal((await tap('~/HyperNeo/not-in-message.html')).reason, 'unavailable');
  db.prepare('UPDATE neo_asks SET session_id = ? WHERE id = ?').run('replacement', 'ask');
  assert.equal((await tap(reference)).reason, 'unavailable');
  assert.equal((await call('artifact.file.read', id)).reason, 'unavailable');
  const evidence = { passed: true, unregisteredHtmlContent: html, sameAbsoluteSnapshot: true,
    denials: denied.map(([path, reason]) => ({ path, reason })), sourceBound: true, ownershipRechecked: true };
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(join(root, 'evidence', 'home-reference.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  db.close();
}
