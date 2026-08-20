import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

type SpawnHandler = (
  command: string,
  args: string[]
) => EventEmitter & { kill: (signal: NodeJS.Signals) => boolean };

const calls: Array<{ command: string; args: string[] }> = [];
let spawnHandler: SpawnHandler = (command, args) => {
  calls.push({ command, args });
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.kill = () => true;
  queueMicrotask(() => child.emit('exit', 0, null));
  return child;
};

mock.module('node:child_process', () => ({
  spawn: (command: string, args: string[]) => spawnHandler(command, args),
}));

const { defaultAcpCommandProbe } = await import('../../../../src/lib/providers/acp-provider');

describe('defaultAcpCommandProbe', () => {
  afterEach(() => {
    calls.length = 0;
    spawnHandler = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
  });

  test('parses quoted command paths and arguments', async () => {
    await defaultAcpCommandProbe('"/Applications/Devin CLI/devin" acp', 1000);

    expect(calls).toEqual([{ command: '/Applications/Devin CLI/devin', args: ['acp', '--help'] }]);
  });

  test('rejects nonzero probe exits', async () => {
    spawnHandler = (command, args) => {
      calls.push({ command, args });
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
