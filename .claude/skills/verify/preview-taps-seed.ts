import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';

const [directory, phase, rootSession, refJson] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));

if (phase === 'seed') {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL('./preview-git-capture.ts', import.meta.url)), root, 'seed'],
    { env: process.env, stdout: 'pipe', stderr: 'inherit' }
  );
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, output);
  writeFileSync(
    join(root, 'workspace', 'notes.md'),
    '# Synthetic layout notes\n\nThe header keeps one line on phones.\n'
  );
  console.log('seeded preview tap fixture');
} else {
  assert.equal(phase, 'publish');
  assert(rootSession?.startsWith('neo:'));
  const db = new Database(join(root, 'data', 'daemon.db'));
  const text = [
    'The layout notes are in `notes.md`, and the design PR is https://github.com/lsm/HyperNeo/pull/42.',
    '',
    'I attached the notes as a file too; notes.md also sits in the worktree.',
  ].join('\n');
  const result = new NeoPublicationRepository(db).append({
    conversationId: rootSession.slice(4),
    publicationId: crypto.randomUUID(),
    askOrigin: { sessionId: rootSession, messageId: 'synthetic-ask' },
    producerInput: { sessionId: rootSession, messageId: 'synthetic-turn' },
    shortText: text,
    fullText: text,
    links: [{ kind: 'work', id: 'todo', label: 'Report' }],
    artifacts: [JSON.parse(refJson)],
  });
  db.close();
  assert(result.accepted, JSON.stringify(result));
  console.log(`published ${result.publication.publicationId}`);
}
