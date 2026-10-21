import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/neo-todo-collapse-seed.ts', run], { stdio: 'inherit' });
const { root } = JSON.parse(readFileSync(`${run}/evidence/seed.json`, 'utf8'));
const db = new Database(`${run}/data/daemon.db`);
try {
  assert(new NeoConversationAskRepository(db).append({ conversationId: root.slice(4), requestId: '30000000-0000-4000-8000-000000008092',
    askOrigin: { sessionId: root, messageId: '30000000-0000-4000-8000-000000008092' },
    content: `Synthetic human message\n\n${Array.from({length:18}, (_, i) => `Synthetic selectable line ${i+1}.`).join('\n')}`,
  }).accepted);
  const publications = new NeoPublicationRepository(db);
  const cases = ['short', 'long'].map((name, index) => {
    const ending = name === 'short' ? 'Short ending.' : 'A long final line of synthetic detail. '.repeat(30).trim();
    const shortText = `Synthetic ${name} preview. ${name === 'long' ? 'Long preview words. '.repeat(8) : ''}`.trim();
    const publicationId = `20000000-0000-4000-8000-00000000809${index}`;
    assert(publications.append({ conversationId: root.slice(4), publicationId,
      askOrigin: { sessionId: root, messageId: publicationId }, producerInput: { sessionId: root, messageId: publicationId },
      shortText, fullText: `Synthetic ${name} full details.\n\n${ending}`, links: [],
    }).accepted);
    return { name, publicationId, shortText, ending };
  });
  const store = new NeoAskTodoRepository(db);
  const question = store.askQuestion('disclosure-question', 'collapse-card', {
    text: 'Synthetic historical question with details.', kind: 'yesno', noLabel: 'No', yesLabel: 'Yes',
  }, Date.now());
  store.answerQuestion(question, 'no', 'button', Date.now());
  writeFileSync(`${run}/evidence/disclosure-seed.json`, JSON.stringify({ root, cases }, null, 2));
} finally { db.close(); }
