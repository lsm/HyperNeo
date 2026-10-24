import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPrFileOperation } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-file-operation.ts';
import { readBoundGitBlob } from '../../../packages/daemon/src/lib/artifacts/git-blob.ts';

const [portText, runText] = process.argv.slice(2);
const run = resolve(runText);
const port = Number(portText);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port >= 0 && port !== 8399);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync(fileURLToPath(new URL('./preview-git-gh.ts', import.meta.url)), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const content = '# Complete review document\n\nUnchanged introduction.\n\n## Updated decision\n\nThe complete current decision.\n\nUnchanged appendix.\n';
const bytes = Buffer.from(content);
const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const pr = { url: 'https://github.com/example/project/pull/42', title: 'Synthetic document', body: '', state: 'OPEN', headRefOid: sha, reviews: [], statusCheckRollup: [], changedFiles: 1, files: [{ path: 'report.md', additions: 1, deletions: 1 }] };
const fixtures = Object.fromEntries([
  [`commits/${sha}`, { sha, tree: { sha: tree } }],
  [`trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: 'report.md', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] }],
  [`blobs/${blob}`, { sha: blob, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }],
].map(([suffix, value]) => {
  const endpoint = `repos/example/project/git/${suffix}`;
  return [endpoint, { ...value as object, url: `https://api.github.com/${endpoint}` }];
}));
writeFileSync(join(run, 'git-fixtures.json'), JSON.stringify(fixtures));
writeFileSync(join(run, 'pr.json'), JSON.stringify(pr));
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-neo','Synthetic Neo',?,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z','active','{}','{}')`).run(join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const repo = new NeoAskTodoRepository(db);
  repo.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Review document', request: 'Review full document', createdAt: 1 });
  repo.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Review', instruction: '', doneWhen: '', check: null, named: null }, 1);
  const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  const call = async (name: string, input: unknown) => {
    const response = await mcp({ name, input });
    const value = JSON.parse(response.content[0].text);
    evidence.push({ name, input, response: value });
    assert(!response.isError, JSON.stringify(value));
    return value;
  };
  const input = { context: { kind: 'ask' as const, id: 'synthetic-ask' }, pr: 'example/project#42', path: 'report.md', headSha: sha, requestId: randomUUID() };
  const captured = await call('neo.coding.pr.file', input);
  assert(captured.accepted, JSON.stringify(captured));
  assert.equal(captured.artifact.kind, 'markdown');
  assert.equal(captured.artifact.byteLength, bytes.length);
  assert.deepEqual(await call('neo.coding.pr.file', input), captured);
  const read = await call('artifact.file.read', { artifactId: captured.artifact.artifactId });
  assert(read.accepted && read.complete);
  assert.equal(Buffer.from(read.data, 'base64').toString(), content);
  const metadata = await call('artifact.file.get', { artifactId: captured.artifact.artifactId });
  assert.equal(metadata.metadata.revision.commitSha, sha);
  const question = await call('neo.question.ask', { askId: 'synthetic-ask', kind: 'yesno', text: 'The decision changed; review the complete document?', noLabel: 'Keep', yesLabel: 'Approve', artifacts: [captured.artifact] });
  assert(question.ok, JSON.stringify(question));
  assert.deepEqual(question.question.artifacts, [captured.artifact]);
  for (const changes of [{ headSha: 'c'.repeat(40) }, { path: 'not-in-pr.md' }]) {
    const before = readFileSync(join(run, 'evidence/gh.log'), 'utf8');
    const refused = await call('neo.coding.pr.file', { ...input, ...changes, requestId: randomUUID() });
    assert.equal(refused.accepted, false);
    assert.equal(refused.reason, 'source_changed');
    const added = readFileSync(join(run, 'evidence/gh.log'), 'utf8').slice(before.length);
    assert(!added.includes('"api"'));
  }
  const nextSha = 'd'.repeat(40);
  const nextCommit = `repos/example/project/git/commits/${nextSha}`;
  writeFileSync(join(run, 'git-fixtures.json'), JSON.stringify({ ...fixtures, [nextCommit]: { url: `https://api.github.com/${nextCommit}`, sha: nextSha, tree: { sha: tree } } }));
  writeFileSync(join(run, 'pr.json'), JSON.stringify({ ...pr, headRefOid: nextSha }));
  const changedRequest = await call('neo.coding.pr.file', { ...input, headSha: nextSha });
  assert.equal(changedRequest.accepted, false);
  assert.equal(changedRequest.reason, 'source_changed');
  const next = await call('neo.coding.pr.file', { ...input, headSha: nextSha, requestId: randomUUID() });
  assert(next.accepted);
  assert.notEqual(next.artifact.artifactId, captured.artifact.artifactId);
  assert.equal((await call('artifact.file.get', { artifactId: next.artifact.artifactId })).metadata.revision.commitSha, nextSha);
  assert.equal((await call('artifact.file.get', { artifactId: captured.artifact.artifactId })).metadata.revision.commitSha, sha);
  writeFileSync(join(run, 'pr.json'), JSON.stringify(pr));
  const todo = await call('neo.coding.pr.file', { ...input, context: { kind: 'todo', id: 'synthetic-todo' }, pr: pr.url, requestId: randomUUID() });
  assert(todo.accepted, JSON.stringify(todo));
  const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'synthetic-neo' };
  const beforeRaces = (db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n;
  const op = createCodingPrFileOperation(() => db, join(run, 'data'), join(run, 'home'), undefined, async (target) => {
    const result = await readBoundGitBlob(target);
    writeFileSync(join(run, 'pr.json'), JSON.stringify({ ...pr, headRefOid: 'c'.repeat(40) }));
    return result;
  });
  const raced = await op.execute({ ...input, requestId: randomUUID() }, caller);
  assert.deepEqual(raced, { accepted: false, reason: 'source_changed' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n, beforeRaces);
  evidence.push({ headMovedDuringCapture: raced });
  writeFileSync(join(run, 'pr.json'), JSON.stringify(pr));
  const revoked = createCodingPrFileOperation(() => db, join(run, 'data'), join(run, 'home'), undefined, async (target) => {
    const result = await readBoundGitBlob(target);
    db.prepare(`UPDATE neo_asks SET session_id='other' WHERE id='synthetic-ask'`).run();
    return result;
  });
  const beforeRace = (db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n;
  assert.deepEqual(await revoked.execute({ ...input, requestId: randomUUID() }, caller), { accepted: false, reason: 'unavailable' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n, beforeRace);
  evidence.push({ ownershipRevokedDuringCapture: true });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ status: 'pass', fullContent: content, evidence }, null, 2));
  console.log('PASS: owner Neo MCP -> complete Markdown Git snapshot -> question attachment; stale/unlisted/racing inputs refused');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true, port }));
}
