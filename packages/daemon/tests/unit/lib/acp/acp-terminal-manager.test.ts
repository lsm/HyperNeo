import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawned: MockChildProcess[] = [];
const spawnCalls: Array<{
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean };
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

  test('uses argv directly with the sanitized session environment and workspace', async () => {
    const manager = new AcpTerminalManager(
      { PATH: '/safe/bin', SAFE_TOKEN: 'session' },
      '/workspace'
    );

    await manager.create({
      sessionId: 'session-1',
      command: 'devin tool; ignored',
      args: ['literal arg'],
    });

    expect(spawnCalls[0]).toEqual({
      command: 'devin tool; ignored',
      args: ['literal arg'],
      options: {
        cwd: '/workspace',
        env: { PATH: '/safe/bin', SAFE_TOKEN: 'session' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    });
  });

  test('parses command strings into argv without invoking a shell', async () => {
    const manager = new AcpTerminalManager();

    await manager.create({ sessionId: 'session-1', command: 'npm test -- --runInBand' });

    expect(spawnCalls[0]).toMatchObject({
      command: 'npm',
      args: ['test', '--', '--runInBand'],
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

  test('reports close status to output and pending waiters', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'command' });
    const waiting = manager.waitForExit(params(terminalId));

    spawned[0].emit('close', 7, null);

    await expect(waiting).resolves.toEqual({ exitCode: 7, signal: null });
    expect(await manager.output(params(terminalId))).toMatchObject({
      exitStatus: { exitCode: 7, signal: null },
    });
  });

  test('keeps spawn errors when a later close event arrives', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'missing' });
    const waiting = manager.waitForExit(params(terminalId));

    spawned[0].emit('error', new Error('not found'));
    spawned[0].emit('close', null, null);

    await expect(waiting).resolves.toEqual({ exitCode: 1, signal: null });
    expect(await manager.output(params(terminalId))).toMatchObject({
      output: 'Process error: not found\n',
      exitStatus: { exitCode: 1, signal: null },
    });
  });

  test('release kills a running terminal and removes it', async () => {
    const processKill = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, processKill);
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'command' });

    await manager.release(params(terminalId));

    if (process.platform === 'win32') {
      expect(spawned[0].kill).toHaveBeenCalledWith('SIGTERM');
    } else {
      expect(processKill).toHaveBeenCalledWith(-spawned[0].pid, 'SIGTERM');
    }
    expect(await manager.output(params(terminalId))).toEqual({
      output: '',
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    });
  });

  test('clamps output limits', async () => {
    const manager = new AcpTerminalManager();
    const low = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 0,
    });
    const high = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: Number.MAX_SAFE_INTEGER,
    });
    const malformed = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 'invalid' as unknown as number,
    });

    spawned[0].stdout.emit('data', Buffer.from('abc'));
    spawned[1].stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
    spawned[2].stdout.emit('data', Buffer.alloc(1024 * 1024 + 1, 'x'));

    expect(await manager.output(params(low.terminalId))).toMatchObject({
      output: 'c',
      truncated: true,
    });
    const highOutput = await manager.output(params(high.terminalId));
    expect(Buffer.byteLength(highOutput.output)).toBe(4 * 1024 * 1024);
    expect(highOutput.truncated).toBe(true);
    const malformedOutput = await manager.output(params(malformed.terminalId));
    expect(Buffer.byteLength(malformedOutput.output)).toBe(1024 * 1024);
    expect(malformedOutput.truncated).toBe(true);
  });

  test('signals the terminal process group and escalates to SIGKILL', async () => {
    const processKill = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, processKill);
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
    const processKill = mock((_pid: number, _signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, processKill);
    await manager.create({ sessionId: 'session-1', command: 'first' });
    await manager.create({ sessionId: 'session-1', command: 'second' });

    manager.dispose();

    if (process.platform === 'win32') {
      expect(spawned[0].kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawned[1].kill).toHaveBeenCalledWith('SIGTERM');
    } else {
      expect(processKill).toHaveBeenCalledWith(-spawned[0].pid, 'SIGTERM');
      expect(processKill).toHaveBeenCalledWith(-spawned[1].pid, 'SIGTERM');
    }
  });
});
