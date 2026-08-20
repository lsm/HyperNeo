import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawned: MockChildProcess[] = [];
const spawnCalls: Array<{
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; detached?: boolean };
}> = [];
let nextPid = 100;

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = nextPid++;
  kill = mock((_signal: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

mock.module('node:child_process', () => ({
  spawn: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; detached?: boolean }
  ) => {
    spawnCalls.push({ command, args, options });
    const child = new MockChildProcess();
    spawned.push(child);
    return child;
  },
}));

const { AcpTerminalManager } = await import('../../../../src/lib/acp/acp-terminal-manager');

function params(terminalId: string) {
  return { sessionId: 'session-1', terminalId };
}

describe('AcpTerminalManager', () => {
  afterEach(() => {
    spawned.length = 0;
    spawnCalls.length = 0;
  });

  test('uses argv directly with the sanitized session environment', async () => {
    const manager = new AcpTerminalManager({ PATH: '/safe/bin', SAFE_TOKEN: 'session' });

    await manager.create({
      sessionId: 'session-1',
      command: 'devin tool; ignored',
      args: ['literal arg'],
      env: [{ name: 'EXTRA', value: 'value' }],
    });

    expect(spawnCalls[0]).toEqual({
      command: 'devin tool; ignored',
      args: ['literal arg'],
      options: {
        cwd: undefined,
        env: { PATH: '/safe/bin', SAFE_TOKEN: 'session', EXTRA: 'value' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    });
  });

  test('returns the newest output bytes when truncating', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 4,
    });

    spawned[0].stdout.emit('data', Buffer.from('abcdefghij'));

    expect(await manager.output(params(terminalId))).toMatchObject({
      output: 'ghij',
      truncated: true,
    });
  });

  test('signals the terminal process group and escalates to SIGKILL', async () => {
    const processKill = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, processKill);
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'sleep' });
    const child = spawned[0];

    await manager.kill(params(terminalId));
    if (process.platform === 'win32') {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } else {
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    }

    await new Promise((resolve) => setTimeout(resolve, 5100));
    if (process.platform === 'win32') {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } else {
      expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    }
  }, 6000);

  test('dispose terminates every active terminal process', async () => {
    const manager = new AcpTerminalManager();
    await manager.create({ sessionId: 'session-1', command: 'first' });
    await manager.create({ sessionId: 'session-1', command: 'second' });

    manager.dispose();

    expect(spawned[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawned[1].kill).toHaveBeenCalledWith('SIGTERM');
  });
});
