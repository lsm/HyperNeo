import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArtifactProofChild } from '../../helpers/artifact-proof-child';

describe('artifact proof child failure evidence', () => {
  test('reports the child phase and stderr before its disposable run is removed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-proof-child-')));
    try {
      const child = join(root, 'fixture.ts');
      writeFileSync(
        child,
        "import{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';const root=process.argv.at(-1)!;mkdirSync(join(root,'evidence'));writeFileSync(join(root,'evidence/artifact-proof-phases.json'),JSON.stringify([{phase:'startup-wait',elapsedMs:1}]));process.stderr.write('synthetic child stderr');process.exit(7);"
      );
      let failure: unknown;
      try {
        runArtifactProofChild(child, root);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('startup-wait');
      expect(String(failure)).toContain('synthetic child stderr');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
