import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSigningSocket } from '../../../../src/lib/neo/worker-sockets.ts';
const state = vi.hoisted(() => ({ missing: 'ssh', sshConfig: '' }));

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
      args.includes('gpg.format') ? 'ssh' : state.sshConfig || 'synthetic-sign'
    ),
}));

test.each(['git', 'ssh'])(
  'missing %s does not abort startup signing discovery',
  async (missing) => {
    state.missing = missing;
    state.sshConfig = '';
    vi.stubEnv('SSH_AUTH_SOCK', undefined);
    try {
      await expect(discoverSigningSocket()).resolves.toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  }
);

test('proposes the ssh-config IdentityAgent socket alongside SSH_AUTH_SOCK', async () => {
  state.missing = '';
  state.sshConfig = `host *\nidentityagent ~/Library/Group Containers/synthetic/agent.sock\n`;
  vi.stubEnv('SSH_AUTH_SOCK', join(tmpdir(), 'launchd-agent.sock'));
  try {
    await expect(discoverSigningSocket()).resolves.toEqual([
      join(tmpdir(), 'launchd-agent.sock'),
      join(homedir(), 'Library/Group Containers/synthetic/agent.sock'),
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
});
