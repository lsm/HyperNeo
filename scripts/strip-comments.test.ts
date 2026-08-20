import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const scriptPath = join(import.meta.dir, 'strip-comments.ts');

describe('strip-comments', () => {
  it('does not treat flags after --files as paths', () => {
    const result = spawnSync('bun', [scriptPath, '--files', scriptPath, '--check'], {
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('files with comments: 0, comments removed: 0\n');
  });
});
