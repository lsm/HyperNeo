import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { discoverSigningSocket } from '../../../../src/lib/neo/worker-sockets.ts';
const state = vi.hoisted(() => ({ missing: 'ssh' }));

vi.mock('../../../../src/lib/runtime-spawn/index.ts', () => ({
  spawnProcess: (command: string[]) => {
    if (command[0] === state.missing)
      throw Object.assign(new Error(`${state.missing} unavailable`), { code: 'ENOENT' });
    return {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(command.includes('gpg.format') ? 'ssh' : 'synthetic-sign')
          );
          controller.close();
        },
      }),
    };
  },
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
