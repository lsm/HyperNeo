import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { ArtifactFileRepository } from '../../../packages/daemon/src/storage/repositories/artifact-file-repository.ts';
import { loadRegistrationBinding } from '../../../packages/daemon/src/lib/artifacts/registration-binding.ts';
import type { ArtifactContext } from '../../../packages/daemon/src/lib/artifacts/file-policy.ts';
import type { ArtifactBundleEntry } from '../../../packages/daemon/src/lib/artifacts/bundle.ts';
import type { ArtifactRef } from '../../../packages/shared/src/types/artifact-file.ts';

type FixtureInput = { context: ArtifactContext; requestId: string; path: string; title: string; bundle?: ArtifactBundleEntry[] };

export function legacyAttachmentFixture(database: () => Database, data: string, home = homedir()) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(basename(home), 'home');
  assert.equal(home, process.env.HOME);
  assert(resolve(data).startsWith(`${dirname(resolve(home))}/`));
  return {
    execute(input: FixtureInput, _caller?: unknown) {
      const db = database();
      const repo = new ArtifactFileRepository(db);
      const binding = loadRegistrationBinding(db, repo.daemonId, input.context, home);
      const path = resolve(binding?.workspacePath ?? join(dirname(home), 'workspace'), input.path);
      const bytes = readFileSync(path);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const root = join(data, 'artifacts');
      for (const folder of ['blobs', 'staging']) mkdirSync(join(root, folder), { recursive: true });
      if (!existsSync(join(root, 'blobs', hash))) writeFileSync(join(root, 'blobs', hash), bytes, { mode: 0o400 });
      const extension = path.split('.').at(-1)!;
      const kind: ArtifactRef['kind'] = extension === 'md' ? 'markdown' : ['html', 'htm'].includes(extension) ? 'html' : ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension) ? 'image' : extension === 'json' ? 'json' : extension === 'log' ? 'log' : 'text';
      const artifact = { daemonId: repo.daemonId, artifactId: randomUUID(), title: input.title, kind, byteLength: bytes.length };
      const producer = binding?.workerRef ?? { adapter: 'hyperneo', id: binding?.workerSessionId ?? binding?.neoSessionId ?? 'synthetic' };
      return repo.save(input.context, randomUUID(), 'synthetic-historical-fixture', hash, artifact, JSON.stringify(producer), input.path, { kind: 'worktree' }, input.bundle, input.requestId);
    },
  };
}

if (import.meta.main) {
  const [run, json] = process.argv.slice(2);
  assert.equal(resolve(process.env.HOME!), join(resolve(run), 'home'));
  const db = new Database(join(run, 'data/daemon.db'));
  try { console.log(JSON.stringify(legacyAttachmentFixture(() => db, join(run, 'data')).execute(JSON.parse(json)))); }
  finally { db.close(); }
}
