import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { discoverSigningSocket } from '../../../../src/lib/neo/worker-sockets.ts';
const state = vi.hoisted(() => ({ missing: 'ssh' }));

vi.mock('node:child_process', () => ({
  execFile: (
    program: string,
    args: string[],
    _options: unknown,
    done: (error: Error | null, stdout: string) => void
  ) =>
    done(
      program === state.missing
        ? Object.assign(new Error(`${program} unavailable`), { code: 'ENOENT' })
        : null,
      args.includes('gpg.format') ? 'ssh' : 'synthetic-sign'
    ),
}));

test.each(['git', 'ssh'])(
  'missing %s does not abort startup signing discovery',
  async (missing) => {
    state.missing = missing;
    vi.stubEnv('SSH_AUTH_SOCK', undefined);
    try {
      await expect(discoverSigningSocket()).resolves.toBeFalsy();
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
