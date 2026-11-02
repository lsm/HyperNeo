import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';

const [directory, phase, session, artifact] = process.argv.slice(2);
const run = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./file-reference-cards-b1-web-seed.ts', import.meta.url)), run, phase, ...(phase === 'publish' ? [session, artifact] : [])], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
const output = await new Response(child.stdout).text();
assert.equal(await child.exited, 0, output);
if (phase === 'publish') {
  const home = join(run, 'home');
  const path = join(home, 'reports/current.md');
  const urlPath = join(home, 'reports/space report.md');
  const url = pathToFileURL(urlPath).href;
  const outside = join(run, 'home-other/report.md');
  mkdirSync(join(home, 'reports'), { recursive: true });
  mkdirSync(join(run, 'home-other'), { recursive: true });
  writeFileSync(path, '# Owner file A\n');
  writeFileSync(urlPath, '# Encoded current file\n');
  writeFileSync(outside, '# Outside home\n');
  const text = ['Owner-home display proof.', `\`${path}\``, `> \`${path}\``, `[Named report](${url})`,
    `[\`${urlPath}\`](${url})`,
    `[**${urlPath}**](${url})`, `\`${url}\``, `\`${outside}\``, '```text\n' + path + '\n```'].join('\n\n');
  const publicationId = crypto.randomUUID();
  const db = new Database(join(run, 'data/daemon.db'));
  try {
    assert(new NeoPublicationRepository(db).append({ conversationId: session.slice(4), publicationId, producerInput: { sessionId: session, messageId: 'owner-path-display-proof' }, shortText: text, fullText: text, links: [] }).accepted);
  } finally { db.close(); }
  writeFileSync(join(run, 'evidence/owner-home-fixture.json'), JSON.stringify({ home, path, urlPath, url, outside, text, publicationId }));
}
console.log(`seeded isolated owner-home ${phase}`);
