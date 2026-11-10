import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';

const [directory, sessionId] = process.argv.slice(2);
const run = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(sessionId.startsWith('neo:'));
const publicationId = crypto.randomUUID();
const text = '## A short update\n\n> The release notes are ready for review. Please check the small changes before publishing.\n>\n> Thank you for taking a look.\n\nThe preview is ready.\n\n```text\nA code sample.\n```';
const db = new Database(join(run, 'data/daemon.db'));
try {
  assert(new NeoPublicationRepository(db).append({conversationId:sessionId.slice(4),publicationId,producerInput:{sessionId,messageId:'synthetic-colour-proof'},shortText:text,fullText:text,links:[]}).accepted);
} finally { db.close(); }
writeFileSync(join(run,'evidence/quote-colour-fixture.json'), JSON.stringify({publicationId,text}));
