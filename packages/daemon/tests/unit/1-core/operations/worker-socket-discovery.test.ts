import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { discoverSigningSocket } from '../../../../src/lib/neo/worker-sockets.ts';

vi.mock('../../../../src/lib/runtime-spawn/index.ts', () => ({
  spawnProcess: (command: string[]) => {
    if (command[0] === 'ssh') throw Object.assign(new Error('ssh unavailable'), { code: 'ENOENT' });
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

test('missing ssh does not abort startup signing discovery', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', undefined);
  try {
    await expect(discoverSigningSocket()).resolves.toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});
