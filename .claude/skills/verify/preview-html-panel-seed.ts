import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
const root = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home'));
const { root: session, ref } = JSON.parse(readFileSync(join(root, 'evidence', 'html-viewer-refs.json'), 'utf8'));
assert(session.startsWith('neo:'));
const db = new Database(join(root, 'data', 'daemon.db'));
const result = new NeoPublicationRepository(db).append({
 conversationId: session.slice(4), publicationId: crypto.randomUUID(),
 askOrigin: { sessionId: session, messageId: 'synthetic-html-ask' },
 producerInput: { sessionId: session, messageId: 'synthetic-html-turn' },
 shortText: 'Static layout report ready.', fullText: 'The HTML report is attached; scripts are disabled.',
 links: [{ kind: 'work', id: 'todo', label: 'Report' }], artifacts: [ref],
});
db.close(); assert(result.accepted, JSON.stringify(result)); console.log('seeded synthetic HTML publication while daemon stopped');
