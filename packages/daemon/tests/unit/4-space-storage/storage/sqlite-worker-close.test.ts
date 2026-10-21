import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('SQLite connection closure under Bun', () => {
  test('releases retained prepared statements before returning from close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sqlite-close-'));
    const file = fileURLToPath(
      new URL('../../../helpers/sqlite-closed-statement.ts', import.meta.url)
    );
    const child = spawn('bun', [file, root], {
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      const code = await new Promise<number | null>((done, fail) => {
        child.once('exit', done);
        child.once('error', fail);
      });
      expect({ code, output }).toEqual({ code: 0, output: '' });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
