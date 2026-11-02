import { expect, test, vi } from 'vitest';
import daemonPackage from '../../../../package.json' with { type: 'json' };

const requests = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('Package manifests are unavailable in the compiled server');
  },
}));

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execSync: () => {
    throw new Error('No system Claude executable');
  },
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    done: (error: Error, stdout: string, stderr: string) => void
  ) => {
    requests.push(...args.filter((arg) => arg.startsWith('https://registry.npmjs.org/')));
    queueMicrotask(() => done(new Error('Isolated download refused'), '', ''));
  },
}));

import { warmupSDKCliBinary } from '../../../../src/lib/agent/sdk-cli-resolver';

test('a server without package manifests downloads the pinned SDK version', async () => {
  const expected = daemonPackage.dependencies['@anthropic-ai/claude-agent-sdk'];
  const result = await warmupSDKCliBinary();

  expect(result.status).toBe('failed');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.split('/').at(-1)).toBe(expected);
  expect(result.version).toBe(expected);
});
