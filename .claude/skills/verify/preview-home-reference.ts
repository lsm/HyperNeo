import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { reserveNeoConversation } from '../../../packages/daemon/src/storage/repositories/neo-conversation-reservation.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { createLiveFileRead } from '../../../packages/daemon/src/lib/artifacts/live-file-read.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const root = realpathSync(process.argv.at(-1)!);
const home = join(root, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
mkdirSync(join(root, 'tmp'), { recursive: true });
const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL('./preview-register.ts', import.meta.url)),
    root,
    'seed',
  ],
  { env: { ...process.env, TMPDIR: join(root, 'tmp') }, stdout: 'pipe', stderr: 'inherit' }
);
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
    ['~', 'forbidden'],
    ['~/HyperNeo/../outside.html', 'unsafe_path'],
    ['~/HyperNeo/引用配色/../引用配色/quote-colour-options.html', 'unsafe_path'],
    ['~/HyperNeo/%2e%2e/outside.html', 'unsafe_path'],
    ['~/HyperNeo/linked.html', 'unsafe_path'],
    ['~/HyperNeo/.ssh/secret.html', 'sensitive_path'],
    ['~/HyperNeo/binary.html', 'unsupported_type'],
    ['~/HyperNeo/large.html', 'size_limit'],
  ];
  const conversationId = randomUUID();
  reserveNeoConversation(db, conversationId, Date.now());
  new NeoRepository(db).reserveBinding({ sessionId: 'neo', kind: 'neo', projectId: null });
  const publicationId = randomUUID();
  const origin = { sessionId: 'neo', messageId: 'm' };
  assert(
    new NeoPublicationRepository(db).append({
      conversationId,
      publicationId,
      producerInput: origin,
      askOrigin: origin,
      shortText: `Read \`${reference}\``,
      fullText: [absolute, '~/outside.html', ...denied.map(([path]) => path)]
        .map((path) => `\`${path}\``)
        .join('\n\n'),
      links: [],
    }).accepted
  );
  const registry = createOperationRegistry([
    createLiveFileRead(() => db, home),
    ...createArtifactReadOperations(() => db, data),
  ]);
  const human = { source: 'rpc' as const, principal: 'local' as const };
  async function call(name: string, input: unknown) {
    const result = await invokeOperation(registry, name, input, human);
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    return (
      result as {
        kind: 'completed';
        value: {
          accepted: boolean;
          reason?: string;
          artifact: { artifactId: string };
          data: string;
          document: string;
          metadata: { sha256: string };
        };
      }
    ).value;
  }
  const tap = (path: string) =>
    call('file.reference.read', {
      sourceMessageOrCard: { kind: 'publication', id: publicationId },
      reference: path,
    });
  const count = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n;
  assert.equal(count(), 0);
  const receipt = await tap(reference);
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  assert.equal(count(), 0);
  assert(Buffer.from(receipt.data, 'base64').toString().includes(html));
  const absoluteReceipt = await tap(absolute);
  assert(absoluteReceipt.accepted);
  assert.equal(absoluteReceipt.data, receipt.data);
  assert.equal((await tap('~/outside.html')).accepted, true);
  const observedDenials: unknown[] = [];
  for (const [path, reason] of denied) {
    const before = count();
    const result = await tap(path);
    observedDenials.push({ path, reason: result.reason });
    assert.equal(result.accepted, false, path);
    if (['unsafe_path', 'sensitive_path'].includes(reason)) assert(['forbidden', reason].includes(result.reason!), path);
    else assert.equal(result.reason, reason, path);
    assert.equal(count(), before, path);
  }
  assert.equal((await tap('~/HyperNeo/not-in-message.html')).reason, 'forbidden');
  db.prepare("UPDATE neo_publications SET payload_json = json_set(payload_json, '$.shortText', 'Reference removed', '$.fullText', 'Reference removed') WHERE publication_id = ?").run(publicationId);
  assert.equal((await tap(reference)).reason, 'forbidden');
  const evidence = {
    passed: true,
    unregisteredHtmlContent: html,
    liveDocumentServed: true,
    sameAbsoluteContent: true,
    denials: observedDenials,
    sourceBound: true,
    sourceRechecked: true,
  };
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(join(root, 'evidence', 'home-reference.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  db.close();
}
