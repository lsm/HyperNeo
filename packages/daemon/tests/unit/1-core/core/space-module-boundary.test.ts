import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('daemon bundle without Space', () => {
  test('bundling the daemon app leaves the Space runtime out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperneo-space-boundary-'));
    try {
      execFileSync(
        'bun',
        ['build', 'src/app.ts', '--target=bun', '--packages=external', '--outdir', dir],
        { stdio: 'pipe' }
      );
      const bundle = readFileSync(join(dir, 'app.js'), 'utf8');
      expect(bundle).toContain('loadSpaceDaemonModule');
      for (const name of ['createSpaceRpc', 'class TaskAgentManager', 'class SpaceRuntimeService'])
        expect(bundle).not.toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
