import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { readDaemonGithubToken } from '../../../../src/lib/github/runtime-token.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

function fakeCli(text = 'synthetic-cli-token\n', exit = 0) {
  return vi.fn<SpawnFn>(() => ({
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(exit),
    exitCode: exit,
    kill: vi.fn(),
  }));
}

beforeEach(() => {
  vi.stubEnv('GH_TOKEN', undefined);
  vi.stubEnv('GITHUB_TOKEN', undefined);
  vi.stubEnv('GH_HOST', undefined);
  vi.stubEnv('GH_CONFIG_DIR', '/synthetic/daemon-gh');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test('the existing store token wins without consulting another credential source', async () => {
  vi.stubEnv('GH_TOKEN', 'synthetic-env-token');
  const spawn = fakeCli();
  expect(await readDaemonGithubToken(async () => 'synthetic-store-token', spawn)).toBe(
    'synthetic-store-token'
  );
  expect(spawn).not.toHaveBeenCalled();
});

test.each(['GH_TOKEN', 'GITHUB_TOKEN'])('%s is used before CLI authentication', async (key) => {
  vi.stubEnv(key, 'synthetic-env-token');
  const spawn = fakeCli();
  expect(await readDaemonGithubToken(async () => null, spawn)).toBe('synthetic-env-token');
  expect(spawn).not.toHaveBeenCalled();
});

test('the daemon CLI active token is supplied when no explicit token exists', async () => {
  const spawn = fakeCli();
  expect(await readDaemonGithubToken(async () => null, spawn)).toBe('synthetic-cli-token');
  expect(spawn).toHaveBeenCalledWith(['gh', 'auth', 'token', '--hostname', 'github.com'], {
    env: expect.objectContaining({
      GH_CONFIG_DIR: '/synthetic/daemon-gh',
      GH_PROMPT_DISABLED: '1',
    }),
    stdout: 'pipe',
    stderr: 'ignore',
  });
});

test('an unavailable store still uses the already-authenticated daemon CLI', async () => {
  expect(
    await readDaemonGithubToken(async () => {
      throw new Error('Synthetic store unavailable');
    }, fakeCli())
  ).toBe('synthetic-cli-token');
});

test.each([
  { name: 'empty', text: '', exit: 0 },
  { name: 'refused', text: 'synthetic-partial-token', exit: 1 },
  { name: 'oversize', text: 'x'.repeat(17000), exit: 0 },
])('$name CLI output leaves Neo unauthenticated', async ({ text, exit }) => {
  expect(await readDaemonGithubToken(async () => null, fakeCli(text, exit))).toBeNull();
});

test('a missing CLI leaves Neo unauthenticated', async () => {
  expect(
    await readDaemonGithubToken(
      async () => null,
      () => {
        throw new Error('Synthetic executable missing');
      }
    )
  ).toBeNull();
});

test('timed-out token lookup is terminated and never returns captured output', async () => {
  vi.useFakeTimers();
  let finish = (_exit: number) => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const kill = vi.fn(() => finish(0));
  const spawn = fakeCli('synthetic-unconfirmed-token');
  spawn.mockReturnValueOnce({ ...spawn([], {}), exited, kill });
  const pending = readDaemonGithubToken(async () => null, spawn);
  await vi.advanceTimersByTimeAsync(30000);
  expect(await pending).toBeNull();
  expect(kill).toHaveBeenCalledWith('SIGKILL');
});
