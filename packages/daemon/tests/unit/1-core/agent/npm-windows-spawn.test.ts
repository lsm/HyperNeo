import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedTarball } from '../../../../src/lib/agent/npm-package-download.ts';
import { integrityOf, npmTarball } from '../../helpers/npm-tarball.ts';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: spawn,
}));

describe('Windows package downloads', () => {
  it('uses pnpm when npm fails to spawn', async () => {
    const run = mkdtempSync(join(tmpdir(), 'windows-npm-'));
    const archive = npmTarball([{ path: 'package/claude', body: 'binary' }]);
    const platform = process.platform;
    const calls: string[] = [];
    spawn.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        done: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        calls.push(command);
        if (command === 'npm')
          return done(Object.assign(new Error('spawn'), { code: 'EINVAL' }), '', '');
        if (command === 'pnpm') return done(null, 'https://mirror.example.test', '');
        if (args.includes('-o')) {
          writeFileSync(args[args.indexOf('-o') + 1], archive);
          return done(null, '', '');
        }
        return done(
          null,
          JSON.stringify({
            dist: {
              tarball: 'https://mirror.example.test/pkg.tgz',
              integrity: integrityOf(archive),
            },
          }),
          ''
        );
      }
    );
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const dest = join(run, 'result.tgz');
      await downloadVerifiedTarball('pkg', '1.0.0', dest);
      expect(readFileSync(dest).toString('base64')).toBe(archive.toString('base64'));
      expect(calls).toEqual(['npm', 'pnpm', 'curl', 'curl']);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      rmSync(run, { recursive: true, force: true });
      spawn.mockReset();
    }
  });
});
