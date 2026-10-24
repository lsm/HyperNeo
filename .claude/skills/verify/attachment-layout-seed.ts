import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createArtifactRegistration } from '../../../packages/daemon/src/lib/artifacts/register-operation.ts';
import { captureGitArtifact } from '../../../packages/daemon/src/lib/artifacts/git-capture.ts';

const root = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
mkdirSync(join(root, 'evidence'), { recursive: true });
if (process.argv[3] === 'cards') {
  const port = process.argv[4] ?? '9491';
  assert.notEqual(port, '8399');
  const seed = JSON.parse(readFileSync(join(root, 'evidence', 'seed.json'), 'utf8'));
  const input = { askId: 'ask', kind: 'yesno', text: 'Try both attachment previews. On a wide screen, keep using the chat beside the document. On a phone, tap above the sheet or swipe it down.', yesLabel: 'Looks good', noLabel: 'Needs changes', artifacts: [seed.local.artifact, seed.git.artifact] };
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), 'neo.question.ask', JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
  assert(JSON.parse(output).reply.ok, output);
  writeFileSync(join(root, 'evidence', 'cards.json'), output);
  process.exit(0);
}

const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-register.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
assert.equal(await child.exited, 0);
mkdirSync(join(root, 'bin'), { recursive: true });
writeFileSync(join(root, 'bin', 'gh'), '#!/bin/sh\nexit 1\n');
chmodSync(join(root, 'bin', 'gh'), 0o700);
const data = join(root, 'data');
const db = new Database(join(data, 'daemon.db'));
const context = { kind: 'todo' as const, id: 'todo' };
const markdown = '# Launch plan\n\nA synthetic document for trying the attachment layout.\n\n## Decisions\n\n| Topic | Proposal |\n| --- | --- |\n| Audience | Curious readers |\n| Launch | A small pilot |\n\nOpen the other attachment while this stays open. The chat remains usable on wide screens.\n';
writeFileSync(join(root, 'workspace', 'report.md'), markdown);
const local = await createArtifactRegistration(() => db, data, join(root, 'home')).execute({ requestId: 'layout-markdown', context, path: 'report.md', title: 'Launch plan (Markdown)' }, { source: 'rpc', principal: 'local' });
assert(local.accepted, JSON.stringify(local));
const bytes = Buffer.from('# PR layout proposal\n\nThis synthetic PR file is captured as an immutable git blob.\n\n## Review notes\n\n- Keep the conversation clickable.\n- Replace the preview when another attachment opens.\n- Close with X, Escape or browser Back.\n');
const git = await captureGitArtifact(db, data, { context, repository: 'github.com/example/demo', sha: 'a'.repeat(40), path: 'docs/proposal.md' }, 'layout-git', async () => true, async () => ({ accepted: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }), join(root, 'home'));
assert(git.accepted, JSON.stringify(git));
writeFileSync(join(root, 'evidence', 'seed.json'), JSON.stringify({ local, git }, null, 2));
db.close();
