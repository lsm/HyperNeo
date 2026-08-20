import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

type SpawnOptions = { env?: NodeJS.ProcessEnv; stdio?: string[] };
type SpawnHandler = (
  command: string,
  args: string[],
  options: SpawnOptions
) => EventEmitter & { kill: (signal: NodeJS.Signals) => boolean };

const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
let spawnHandler: SpawnHandler = (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.kill = () => true;
  queueMicrotask(() => child.emit('exit', 0, null));
  return child;
};

mock.module('node:child_process', () => ({
  spawn: (command: string, args: string[], options: SpawnOptions) =>
    spawnHandler(command, args, options),
}));

const { defaultAcpCommandProbe } = await import('../../../../src/lib/providers/acp-provider');

describe('defaultAcpCommandProbe', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    calls.length = 0;
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
  });

  test('parses quoted command paths and arguments with a sanitized environment', async () => {
    process.env = {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      ANTHROPIC_AUTH_TOKEN: 'secret',
    };

    await defaultAcpCommandProbe('"/Applications/Devin CLI/devin" acp', 1000);

    expect(calls).toEqual([
      {
        command: '/Applications/Devin CLI/devin',
        args: ['acp', '--help'],
        options: {
          env: { PATH: '/safe/bin', HOME: '/safe/home' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      },
    ]);
  });

  test('rejects nonzero probe exits', async () => {
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      queueMicrotask(() => child.emit('exit', 3, null));
      return child;
    };

    await expect(defaultAcpCommandProbe('devin acp', 1000)).rejects.toThrow('probe exited with 3');
  });
});
