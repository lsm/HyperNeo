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
  queueMicrotask(() => child.emit('spawn'));
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
      queueMicrotask(() => child.emit('spawn'));
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
        args: ['acp'],
        options: {
          env: { PATH: '/safe/bin', HOME: '/safe/home' },
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: process.platform !== 'win32',
        },
      },
    ]);
  });

  test('accepts a process that exits nonzero after spawning', async () => {
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('exit', 3, null);
      });
      return child;
    };

    await expect(defaultAcpCommandProbe('devin acp', 1000)).resolves.toBeUndefined();
  });

  test('reports a missing command', async () => {
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
      );
      return child;
    };

    await expect(defaultAcpCommandProbe('missing acp', 1000)).rejects.toThrow(
      "ACP command 'missing' not found in PATH"
    );
  });

  test('escalates SIGKILL while the process group remains', async () => {
    const killSignals: NodeJS.Signals[] = [];
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
        pid?: number;
      };
      child.kill = (signal) => {
        killSignals.push(signal);
        return true;
      };
      child.pid = 0x40000000;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };

    await defaultAcpCommandProbe('devin acp', 1000, () => true);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(killSignals).toContain('SIGTERM');
    expect(killSignals).toContain('SIGKILL');
  }, 2000);

  test('skips SIGKILL after the process group is gone', async () => {
    const killSignals: NodeJS.Signals[] = [];
    spawnHandler = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
        pid?: number;
      };
      child.kill = (signal) => {
        killSignals.push(signal);
        return true;
      };
      child.pid = 0x40000001;
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      });
      return child;
    };

    await defaultAcpCommandProbe('devin acp', 1000, () => false);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(killSignals).toContain('SIGTERM');
    expect(killSignals).not.toContain('SIGKILL');
  }, 2000);
});
