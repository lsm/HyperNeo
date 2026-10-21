import assert from 'node:assert/strict';
import { existsSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { loadRegistrationBinding } from '../../../packages/daemon/src/lib/artifacts/registration-binding.ts';
import { planStoredReference } from '../../../packages/daemon/src/lib/artifacts/reference-plan.ts';

const root = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-register.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
const output = await new Response(child.stdout).text();
assert.equal(await child.exited, 0, output);
const path = join(root, 'data', 'daemon.db');
let db = new Database(path);
const publications = new NeoPublicationRepository(db);
const conversationId = '11111111-1111-4111-8111-111111111111';
const publicationId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const origin = { sessionId: 'worker', messageId: 'source' };
assert(publications.append({ conversationId, publicationId, askOrigin: origin, producerInput: origin, shortText: 'Report', fullText: 'Read `report.md`.', links: [{ kind: 'work', id: 'todo', label: 'Report' }] }).accepted);
assert(publications.edit(conversationId, publicationId, { fullText: 'Read `new-report.md`.' }, new Date().toISOString(), 'human', origin, revisionId).accepted);
db.close();
renameSync(join(root, 'workspace'), join(root, 'workspace.retained'));
db = new Database(path, { readonly: true });
const source = { kind: 'publication' as const, id: publicationId, revisionId: publicationId };
const context = { kind: 'todo' as const, id: 'todo' };
const caller = { source: 'mcp' as const, role: 'direct_task_worker' as const, sessionId: 'worker' };
const deps = {
  daemonId: 'synthetic-daemon', home: join(root, 'home'),
  loadSource: async (key: typeof source) => {
    const publication = new NeoPublicationRepository(db).get(conversationId, key.id);
    if (!publication || key.kind !== 'publication') return null;
    const text = key.revisionId === publication.revisionId ? publication.fullText : publication.revisions?.find((revision) => revision.revisionId === key.revisionId)?.fullText;
    const link = publication.links.find((item) => item.kind === 'work');
    const binding = link ? loadRegistrationBinding(db, 'synthetic-daemon', { kind: 'todo', id: link.id }) : null;
    return text && binding ? { key, text, bindings: [{ ...binding, repository: 'github.com/lsm/hyperneo', revision: { kind: 'worktree' as const } }] } : null;
  },
};
const request = { source, reference: 'report.md' };
const original = await planStoredReference(request, caller, deps);
assert.deepEqual(original, { accepted: true, kind: 'worktree', context, root: join(root, 'workspace'), relativePath: 'report.md', revision: { kind: 'worktree' } });
assert.deepEqual(await planStoredReference({ ...request, reference: 'new-report.md' }, caller, deps), { accepted: false, reason: 'unavailable' });
assert.deepEqual(await planStoredReference({ ...request, source: { ...source, revisionId }, reference: 'report.md' }, caller, deps), { accepted: false, reason: 'unavailable' });
assert.equal((await planStoredReference({ ...request, source: { ...source, revisionId }, reference: 'new-report.md' }, caller, deps)).accepted, true);
assert(!existsSync(join(root, 'data', 'artifacts')));
db.close();
db = new Database(path);
new NeoTodoSessionRepository(db).recordRef('todo', { adapter: 'hyperneo', id: 'replacement' });
db.close();
db = new Database(path, { readonly: true });
assert.deepEqual(await planStoredReference(request, caller, deps), { accepted: false, reason: 'unavailable' });
db.close();
const evidence = { persistedRevision: true, readonlyRestart: true, staleReferenceRefused: true, currentAuthority: true, noFileReadOrCapture: true, original };
writeFileSync(join(root, 'candidate-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
