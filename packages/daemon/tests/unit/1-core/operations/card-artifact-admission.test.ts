import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishHandoff, publicHandoffReference } from '../../../../src/lib/handoffs/outbox.ts';
import {
  readCardArtifactFacts,
  unverifiedCardArtifact,
} from '../../../../src/lib/neo/card-artifact-admission.ts';

test('checks mixed saved and published handoffs against verified local bytes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'card-admission-')));
  const prior = process.env.HYPERNEO_DATA_DIR;
  process.env.HYPERNEO_DATA_DIR = root;
  try {
    const drafts = join(root, 'handoffs', 'worker', 'drafts');
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, 'report.md'), '# Synthetic\n');
    const published = await publishHandoff(root, 'worker', 'report.md');
    if (published.kind !== 'published') throw new Error('publish failed');
    const ref = publicHandoffReference(published.reference);
    const saved = {
      daemonId: 'd',
      artifactId: 'a',
      title: 'Saved',
      kind: 'markdown' as const,
      byteLength: 12,
    };
    const caller = { source: 'mcp' as const, sessionId: 'neo', role: 'neo' as const };
    const find = (id: string) => (id === saved.artifactId ? saved : null);
    const refs = [saved, ref];
    expect(
      unverifiedCardArtifact(refs, await readCardArtifactFacts(refs, caller, find))
    ).toBeNull();
    const foreign = { ...ref, daemonId: '00000000-0000-4000-8000-000000000000' };
    expect(
      unverifiedCardArtifact([foreign], await readCardArtifactFacts([foreign], caller, find))
    ).toEqual(foreign);
    const missing = { ...saved, artifactId: 'missing' };
    expect(
      unverifiedCardArtifact([missing], await readCardArtifactFacts([missing], caller, find))
    ).toEqual(missing);
    chmodSync(published.reference.path, 0o600);
    writeFileSync(published.reference.path, 'tampered');
    expect(unverifiedCardArtifact([ref], await readCardArtifactFacts([ref], caller, find))).toEqual(
      ref
    );
  } finally {
    if (prior === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test('withholds registered video from publication and card attachment admission', async () => {
  const video = {
    daemonId: 'd',
    artifactId: 'video',
    title: 'Video',
    kind: 'video' as const,
    byteLength: 24,
  };
  const caller = { source: 'mcp' as const, sessionId: 'neo', role: 'neo' as const };
  const facts = await readCardArtifactFacts([video], caller, () => video);
  expect(unverifiedCardArtifact([video], facts)).toEqual(video);
});
